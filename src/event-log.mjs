// 事件落库的写合并层。
//
// 宿主的 token 级增量(reasoning/text/tool delta)占全部事件行的 76%–97%,而它们
// 与结构化事件共用同一张历史表。原先每个增量一次 autocommit,既让 WAL 高速膨胀,
// 又使 SQLite 每 ~488 次提交触发一次自动检查点,在检查点期间阻塞事件循环约 150ms。
//
// 这里把增量累积进内存缓冲,由单个全局定时器在一个事务里批量写入:
// - 单事务多行,提交次数从每秒数十次降到每秒数次;
// - 同一流的连续同类增量合并为一行,保留全文与时间区间,只是粒度变粗;
// - 任何非增量事件写入前先冲刷缓冲,保证 seq 与真实时序一致。

const deltaFields = {
  // 字段路径:合并时拼接该字段,其余字段取首个事件。
  'framework.reasoning.delta': ['text'],
  'framework.text.delta': ['text'],
  'framework.tool.delta': ['argumentsDelta'],
};

// 合并上限:单行正文超过该长度就另起一行,避免一条记录无限增长。
const maxMergedChars = 64 * 1024;

function readPath(value, path) {
  let current = value;
  for (const key of path) {
    if (current == null) return undefined;
    current = current[key];
  }
  return current;
}

function writePath(value, path, next) {
  let current = value;
  for (const key of path.slice(0, -1)) current = current[key];
  current[path.at(-1)] = next;
  return value;
}

/**
 * 判断事件是否属于可合并的流式增量,并给出合并键与累积字段。
 * 返回 null 表示必须立即按原样落库。
 */
function coalesceSpec(event) {
  const type = event?.type;
  if (typeof type !== 'string') return null;
  const direct = deltaFields[type];
  if (direct) {
    return { path: direct, key: [type, event.callId ?? event.itemId ?? '-'] };
  }
  // claude 的增量以原始 stream_event 形式出现,text/thinking/partial_json 三种载荷
  // 不能互相合并,因此把子类型并入键。
  if (type === 'stream_event' && event.event?.type === 'content_block_delta') {
    const delta = event.event.delta ?? {};
    const field = typeof delta.text === 'string'
      ? 'text'
      : typeof delta.thinking === 'string'
        ? 'thinking'
        : typeof delta.partial_json === 'string'
          ? 'partial_json'
          : null;
    if (!field) return null;
    return { path: ['event', 'delta', field], key: [type, delta.type ?? field, event.event.index ?? '-'] };
  }
  return null;
}

export class EventLog {
  constructor(store, { flushMs = 250, schedule = setInterval } = {}) {
    this.store = store;
    this.flushMs = flushMs;
    this.buffer = [];
    this.byKey = new Map();
    this.timer = schedule(() => this.flush(), flushMs);
    this.timer?.unref?.();
  }

  /** 面板会话事件;返回值语义与 store.panelHistory 一致(插入行的 seq)。 */
  panel(sessionId, event, turnId = null) {
    return this.#record('panel', sessionId, event, turnId);
  }

  /** 团队 endpoint 事件;返回值语义与 store.history 一致(非团队上下文返回 null)。 */
  member(endpointId, event, turnId = null) {
    return this.#record('member', endpointId, event, turnId);
  }

  #record(table, id, event, turnId) {
    const spec = coalesceSpec(event);
    if (!spec) {
      // 结构化事件的顺序必须与真实时序一致,先把缓冲落到同一个 seq 序列里。
      this.flush();
      return table === 'panel'
        ? this.store.panelHistory(id, event, turnId)
        : this.store.history(id, event, turnId);
    }
    const key = `${table}|${id}|${turnId ?? ''}|${spec.key.join('|')}`;
    const text = readPath(event, spec.path);
    const last = this.byKey.get(key);
    // 只要求"同一流",不要求紧邻:多个成员并发时增量会交错到达,若要求紧邻,
    // 各自的增量永远不会相邻,合并就完全失效(实测 6 成员时合并行数为 0)。
    const canMerge = last && (last.text.length + String(text ?? '').length) <= maxMergedChars;
    const now = new Date().toISOString();
    if (canMerge) {
      last.text += String(text ?? '');
      last.event = writePath(last.event, spec.path, last.text);
      last.count += 1;
      last.to = now;
      return null;
    }
    const entry = {
      table,
      id,
      turnId,
      key,
      event,
      path: spec.path,
      text: String(text ?? ''),
      count: 1,
      from: now,
      to: now,
    };
    this.buffer.push(entry);
    this.byKey.set(key, entry);
    return null;
  }

  /** 把缓冲写入一个事务;无缓冲时为空操作。 */
  flush() {
    if (!this.buffer.length) return;
    const rows = this.buffer;
    this.buffer = [];
    this.byKey = new Map();
    // 已处于事务中时不能嵌套 BEGIN:直接在当前事务里按序写入,保持 seq 顺序。
    if (this.store.db.isTransaction) {
      this.#write(rows);
      return;
    }
    this.store.transaction(() => this.#write(rows));
  }

  #write(rows) {
    for (const row of rows) {
      // 合并行保留原始 type 与首事件结构,附带合并计数与时间区间,
      // 便于「原始事件」视图看出这是被折叠的一段流。
      const event = row.count > 1 || row.text.length >= maxMergedChars
        ? { ...writePath(row.event, row.path, row.text), coalesced: row.count, from: row.from, to: row.to }
        : row.event;
      if (row.table === 'panel') this.store.panelHistory(row.id, event, row.turnId);
      else this.store.history(row.id, event, row.turnId);
    }
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.flush();
  }
}
