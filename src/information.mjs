// Deterministic information projection for agent inputs and framework tool
// results. Authority stays in Store/Collaboration; this module only derives
// views, stable references and size measurements.
import { createHash, randomUUID } from 'node:crypto';

export const CONTEXT_SCHEMA_VERSION = 1;
export const LEGACY_SCHEMA_VERSION = 0;
export const MESSAGE_REF_UNIT = 'unicode-code-point';
export const MAX_BODY_PAGE = 4096;
export const MAX_MESSAGE_PAGE = 200;

// Defaults are a starting point measured against the local core tests, not a
// claim that every task fits. Callers may pass tighter budgets in tests.
export const DEFAULT_BUDGETS = Object.freeze({
  rulesBytes: 16 * 1024,
  turnInputBytes: 512 * 1024,
  collaborationBytes: 256 * 1024,
  previewCodePoints: 512,
});

const json = value => JSON.stringify(value);
const parse = value => JSON.parse(value);
const now = () => new Date().toISOString();

export function byteSize(value) {
  return Buffer.byteLength(typeof value === 'string' ? value : json(value));
}
export function contentHash(text) {
  return createHash('sha256').update(text).digest('hex');
}
export function codePointLength(text) {
  return Array.from(text).length;
}
export function clampInt(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

export function fixedRules(member, { modelPolicy = null } = {}) {
  return `你是本机 Agent 群成员 ${member.name}，成员编号 ${member.id}，角色 ${member.role}。群编号 ${member.group_id}。
本轮上下文使用 contextSchemaVersion ${CONTEXT_SCHEMA_VERSION}：以下固定规则与本轮动态事实分离；当前有效契约与本轮权威状态见本轮输入，动态事实每轮更新。旧轮事实可能过期，不得把旧轮状态当作当前状态。
使用 send/note 在群里发言，正文是自然语言。最终文本只属于宿主会话，不会自动进入群。
send 只发给一个接收者；note 不唤醒，用于涉及自己的对话补充或轻通知，随接收者下一条正式消息一起交付。
不要介入与自己无关的对话。需要上下文时自行 read，members 可查能力。profile_set 只能写自己的能力自述；成员目录不常驻规则。
同一消息编号出现两次表示同一条消息重发；先查本会话上下文，避免重复操作。
普通成员之间的对话上下文独立；用户私聊不进群。主 Agent依据共享契约和工作状态协调团队。
成员要由用户确认后加入；不要自行扩充团队。不需要回复时可以沉默，避免无意义的相互致谢。
主 Agent的团队消息统一进入coordination会话；用户私聊独立，不能直接派工。工作项由主 Agent调度会话维护，成员用send自然语言汇报。契约不可自行修改，需用户批准。
收到汇报后依据目标缺口决定继续、等待、接受或收尾，不必回复致谢。不存在固定讨论轮数。
目标完成或失败终止后，群仍可继续沟通。后续消息只用于交流、解释结果和追问；不得改写上一目标的工作项、重新派工、执行命令、读写项目、重复收尾或扩大原契约权限。用户明确要求下一项执行任务时，只能调用next_goal_request提交完整新契约，等待用户批准后启动新的目标版本；聊天内容本身不会自动成为新目标。
团队唤醒由框架负责。不得创建、等待、打断或管理 Codex 原生子 Agent；不要调用 spawn/wait/agent 类原生协同工具。需要等待新信息时只结束当前回合，不要阻塞等待；框架会把下一条群消息作为同一个调度会话的新回合投递。
工具权限、回合来源、私聊隔离和审计由框架校验；不得尝试绕过，也不要读取认证秘密。未决身份、阻塞、待决请求和未处理责任必须在汇报中显式保留。
独立审查必须由独立审查者完成；审查者只读，不代替执行者修改实现、不修改契约或工作项、不代写他人自述。审查以真实证据、成果版本和权威状态为准，模型自报不能代替审查；审查缺口的修复与新版本复审由执行者与主 Agent 按契约处理。
${modelPolicy ? `全局模型策略（仅用于有模型规划职责的上下文）：${json(modelPolicy)}。只能从 model_catalog 实时目录选择。` : ''}`.trim();
}

// Prototype-compatible projection used to prove the "required facts are never
// trimmed silently" property. rows carry explicit goal/artifact identity.
export function projectFacts({ goal, artifact, rows, constraints, unknown = [], pending = [] }, budget = 16384) {
  if (!goal || !artifact || !Array.isArray(rows)) throw new Error('explicit identity required');
  const relevant = rows.filter(row => row.goal === goal && row.artifact === artifact);
  const unresolved = rows.filter(row => !row.goal || (row.goal === goal && !row.artifact));
  const view = { schema: CONTEXT_SCHEMA_VERSION, goal, artifact, constraints, relevant, unresolved, unknown, pending, complete: true };
  if (byteSize(view) > budget) throw new Error('required facts exceed budget; explicit paging or direct full read required');
  return view;
}

export function messageRef(row) {
  return { id: row.id, hash: contentHash(row.text), length: codePointLength(row.text), unit: MESSAGE_REF_UNIT };
}

export function boundedMessage(row, { previewCodePoints = DEFAULT_BUDGETS.previewCodePoints, workItemId = null } = {}) {
  const points = Array.from(row.text);
  const preview = points.slice(0, previewCodePoints).join('');
  return {
    id: row.id,
    seq: row.seq,
    sender: row.sender,
    recipient: row.recipient,
    kind: row.kind,
    replyTo: row.reply_to ?? null,
    created: row.created,
    workItemId: workItemId ?? row.workItemId ?? row.work_item_id ?? null,
    ref: { id: row.id, hash: contentHash(row.text), length: points.length, unit: MESSAGE_REF_UNIT },
    preview,
    complete: points.length <= previewCodePoints,
  };
}

export function boundedMessages(rows, { limit = 50, after = 0, previewCodePoints = DEFAULT_BUDGETS.previewCodePoints, workItemIds = new Map() } = {}) {
  const delivered = rows.slice(0, limit);
  return {
    schema: CONTEXT_SCHEMA_VERSION,
    view: 'bounded',
    unit: MESSAGE_REF_UNIT,
    messages: delivered.map(row => boundedMessage(row, { previewCodePoints, workItemId: workItemIds.get(row.id) ?? null })),
    nextAfter: delivered.at(-1)?.seq ?? after,
    hasMore: rows.length > limit,
    complete: rows.length <= limit,
  };
}

export function expandMessageText(row, { hash, offset = 0, bodyLimit = 1024, schema = CONTEXT_SCHEMA_VERSION } = {}) {
  if (typeof hash !== 'string' || !hash.trim()) throw new Error('正文引用缺少内容哈希，不能证明读取的是同一内容');
  if (!Number.isInteger(offset) || offset < 0) throw new Error('无效的正文偏移');
  if (!Number.isInteger(bodyLimit) || bodyLimit < 1 || bodyLimit > MAX_BODY_PAGE) throw new Error('无效的正文范围');
  if (contentHash(row.text) !== hash) throw new Error('正文引用内容已变化（stale），请重新读取消息列表');
  const points = Array.from(row.text);
  if (offset > points.length) throw new Error('正文偏移超出内容长度');
  const end = Math.min(offset + bodyLimit, points.length);
  return {
    schema,
    view: 'body',
    unit: MESSAGE_REF_UNIT,
    ref: { id: row.id, hash, length: points.length, unit: MESSAGE_REF_UNIT },
    text: points.slice(offset, end).join(''),
    offset,
    next: end,
    hasMore: end < points.length,
    complete: end === points.length,
  };
}

function currentUnresolvedItems(items, goalVersion) {
  return items
    .filter(item => item.goalVersion !== goalVersion && !['accepted', 'cancelled'].includes(item.state))
    .map(item => ({ id: item.id, goalVersion: item.goalVersion, revision: item.revision, state: item.state, title: item.title }));
}

function summarisePending(rows = []) {
  return rows.map(row => {
    const summary = boundedMessage(row, { previewCodePoints: 256 });
    return { ...summary, complete: summary.complete };
  });
}

function requestSummary(requests = []) {
  const counts = {};
  for (const request of requests) counts[request.state] = (counts[request.state] ?? 0) + 1;
  return counts;
}

// Projection of the authoritative collaboration.read() object. The caller is
// responsible for passing the current goal id (authority stays in Collaboration).
export function projectCollaboration(full, {
  schema = CONTEXT_SCHEMA_VERSION,
  itemId = null,
  goalId = null,
  budget = DEFAULT_BUDGETS.collaborationBytes,
  previewCodePoints = DEFAULT_BUDGETS.previewCodePoints,
} = {}) {
  if (!full || full.legacy) return full;
  const state = full.state;
  const goalVersion = state?.goal_version ?? null;
  const allItems = Array.isArray(full.items) ? full.items : [];
  let item = null;
  if (itemId) {
    item = allItems.find(candidate => candidate.id === itemId);
    if (!item) throw new Error('工作项不存在或不属于当前团队');
  }
  const items = itemId
    ? [item]
    : allItems.filter(candidate => candidate.goalVersion === goalVersion);
  const unresolved = currentUnresolvedItems(allItems, goalVersion);
  const requests = Array.isArray(full.requests) ? full.requests : [];
  const pendingRequests = requests.filter(request => request.state === 'pending');
  const requestCounts = requestSummary(requests);
  const pendingMessages = summarisePending(full.pendingMessages);
  const records = (Array.isArray(full.records) ? full.records : [])
    .filter(record => (record.goal_version ?? record.goalVersion ?? null) === (itemId ? item.goalVersion : goalVersion))
    .filter(record => !itemId || record.work_item_id === itemId);
  const outputs = (Array.isArray(full.outputs) ? full.outputs : [])
    .filter(output => output.goalVersion === goalVersion);
  const view = {
    schema,
    view: itemId ? 'item' : 'state',
    legacy: false,
    goalVersion,
    goalId,
    contractVersion: full.contract?.version ?? null,
    stateRevision: state?.revision ?? null,
    contract: full.contract,
    state: full.state,
    communicationOpen: full.communicationOpen,
    ...(itemId ? { item } : {}),
    items,
    unresolved,
    pendingRequests,
    requestCounts,
    pendingMessages,
    unknown: full.unknown ?? [],
    runningCount: full.runningCount ?? 0,
    records,
    nextAfter: full.nextAfter ?? null,
    recordsHasMore: full.recordsHasMore === true,
    outputs,
    omissions: [],
    complete: true,
  };
  if (byteSize(view) > budget) {
    view.outputs = [];
    view.omissions.push({
      field: 'outputs',
      count: outputs.length,
      reason: '投影预算不足；state.final 仍提供最终交付文本，outputs 不单独返回',
    });
  }
  if (byteSize(view) > budget) {
    let keep = view.records.length;
    while (keep > 0 && byteSize({ ...view, records: view.records.slice(0, keep) }) > budget) keep -= 1;
    const kept = view.records.slice(0, keep);
    const resumeAfter = kept.at(-1)?.seq ?? (view.records[0]?.seq != null ? view.records[0].seq - 1 : view.nextAfter);
    view.omissions.push({
      field: 'records',
      omitted: view.records.length - keep,
      reason: '投影预算不足，按记录游标续读，不跳过未交付记录',
      nextAfter: resumeAfter,
    });
    view.records = kept;
    view.nextAfter = resumeAfter;
    view.recordsHasMore = true;
  }
  if (byteSize(view) > budget) {
    throw new Error('状态投影超过预算：请使用 collaboration_read 的 itemId 定向读取工作项或缩小记录范围；必要事实不会被静默截断');
  }
  view.complete = view.omissions.length === 0 && !view.recordsHasMore;
  return view;
}

function fullInputMessage(row) {
  return {
    id: row.id,
    seq: row.seq,
    sender: row.sender,
    recipient: row.recipient,
    kind: row.kind,
    replyTo: row.reply_to ?? null,
    created: row.created,
    workItemId: row.workItemId ?? row.work_item_id ?? null,
    ref: messageRef(row),
    text: row.text,
    complete: true,
  };
}

// Turn input: fixed rules live apart; this object is the authoritative dynamic
// facts for the round. Current task material is delivered in full, never as a
// preview. Optional history is paged with explicit omissions.
export function projectTurnInput({
  full,
  group,
  policy,
  input,
  schema = CONTEXT_SCHEMA_VERSION,
  goalId = null,
  budget = DEFAULT_BUDGETS.turnInputBytes,
} = {}) {
  if (!full || full.legacy) throw new Error('该团队尚未确认当前目标契约，不能使用投影输入');
  const state = full.state;
  const goalVersion = state?.goal_version ?? null;
  const allItems = Array.isArray(full.items) ? full.items : [];
  const workItems = allItems.filter(item => item.goalVersion === goalVersion);
  const unresolved = currentUnresolvedItems(allItems, goalVersion);
  const records = (Array.isArray(full.records) ? full.records : [])
    .filter(record => (record.goal_version ?? record.goalVersion ?? null) === goalVersion);
  const outputs = (Array.isArray(full.outputs) ? full.outputs : [])
    .filter(output => output.goalVersion === goalVersion);
  const requests = Array.isArray(full.requests) ? full.requests : [];
  const view = {
    contextSchemaVersion: schema,
    schema,
    group: { id: group.id, name: group.name },
    goalVersion,
    goalId,
    contractVersion: full.contract?.version ?? null,
    stateRevision: state?.revision ?? null,
    contract: full.contract,
    state: full.state,
    communicationOpen: full.communicationOpen,
    policy,
    workItems,
    unresolved,
    pendingRequests: requests.filter(request => request.state === 'pending'),
    requestCounts: requestSummary(requests),
    pendingMessages: summarisePending(full.pendingMessages),
    unknown: full.unknown ?? [],
    runningCount: full.runningCount ?? 0,
    records,
    nextAfter: full.nextAfter ?? null,
    recordsHasMore: full.recordsHasMore === true,
    outputs,
    input: {
      message: fullInputMessage(input.message),
      additionalMessages: (input.additionalMessages ?? []).map(row => fullInputMessage(row)),
      notes: (input.notes ?? []).map(row => fullInputMessage(row)),
    },
    omissions: [],
    complete: true,
  };
  if (byteSize(view) > budget) {
    view.outputs = [];
    view.omissions.push({
      field: 'outputs',
      count: outputs.length,
      reason: '本轮输入预算不足；state.final 仍提供最终交付文本，outputs 不单独返回',
    });
  }
  if (byteSize(view) > budget) {
    let keep = view.records.length;
    while (keep > 0 && byteSize({ ...view, records: view.records.slice(0, keep) }) > budget) keep -= 1;
    const kept = view.records.slice(0, keep);
    const resumeAfter = kept.at(-1)?.seq ?? (view.records[0]?.seq != null ? view.records[0].seq - 1 : view.nextAfter);
    view.omissions.push({
      field: 'records',
      omitted: view.records.length - keep,
      reason: '本轮输入预算不足，按记录游标续读，不跳过未交付记录',
      nextAfter: resumeAfter,
    });
    view.records = kept;
    view.nextAfter = resumeAfter;
    view.recordsHasMore = true;
  }
  if (byteSize(view) > budget) {
    throw new Error(`本轮输入超过 ${budget} 字节预算：必要契约、工作项与触发消息不会被静默截断；请缩减触发消息或改用定向读取`);
  }
  view.complete = view.omissions.length === 0 && !view.recordsHasMore;
  return view;
}

export class Information {
  constructor(store, { budgets = {} } = {}) {
    this.store = store;
    this.budgets = { ...DEFAULT_BUDGETS, ...budgets };
    this.migrate();
  }

  migrate() {
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS endpoint_context_formats(
        endpoint_id TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
        session_key TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        source TEXT NOT NULL,
        created TEXT NOT NULL,
        updated TEXT NOT NULL,
        PRIMARY KEY(endpoint_id,session_key)
      );
      CREATE TABLE IF NOT EXISTS information_measurements(
        id TEXT PRIMARY KEY,
        group_id TEXT,
        endpoint_id TEXT NOT NULL,
        turn_id TEXT,
        kind TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        goal_version INTEGER,
        contract_version INTEGER,
        revision INTEGER,
        bytes INTEGER NOT NULL,
        detail TEXT NOT NULL,
        created TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS information_measurements_turn ON information_measurements(turn_id,kind);
      CREATE INDEX IF NOT EXISTS information_measurements_group ON information_measurements(group_id,created);
      CREATE TABLE IF NOT EXISTS turn_context_schemas(
        turn_id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        session_key TEXT,
        created TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS panel_session_context_formats(
        session_id TEXT PRIMARY KEY REFERENCES panel_sessions(id) ON DELETE CASCADE,
        schema_version INTEGER NOT NULL,
        source TEXT NOT NULL,
        created TEXT NOT NULL,
        updated TEXT NOT NULL
      );
    `);
  }

  // --- context schema compatibility -------------------------------------

  memberSchemaForSession(endpoint, sessionKey, existingSession) {
    const row = this.store.get(
      'SELECT schema_version FROM endpoint_context_formats WHERE endpoint_id=? AND session_key=?',
      endpoint.id,
      sessionKey,
    );
    if (row) return row.schema_version;
    const schema = existingSession ? LEGACY_SCHEMA_VERSION : CONTEXT_SCHEMA_VERSION;
    const timestamp = now();
    this.store.run(
      'INSERT OR REPLACE INTO endpoint_context_formats VALUES(?,?,?,?,?,?)',
      endpoint.id,
      sessionKey,
      schema,
      existingSession ? 'legacy-detected' : 'new-session',
      timestamp,
      timestamp,
    );
    return schema;
  }

  memberSchemaForEndpoint(endpointId) {
    return this.store.get(
      'SELECT schema_version FROM endpoint_context_formats WHERE endpoint_id=? ORDER BY updated DESC LIMIT 1',
      endpointId,
    )?.schema_version ?? LEGACY_SCHEMA_VERSION;
  }

  memberSchemaForTurn(turnId) {
    if (!turnId) return null;
    return this.store.get(
      "SELECT schema_version FROM turn_context_schemas WHERE turn_id=? AND scope='member'",
      turnId,
    )?.schema_version ?? null;
  }

  rememberTurnSchema(turnId, scope, schemaVersion, sessionKey = null) {
    this.store.run(
      'INSERT OR REPLACE INTO turn_context_schemas VALUES(?,?,?,?,?)',
      turnId,
      scope,
      schemaVersion,
      sessionKey,
      now(),
    );
    return schemaVersion;
  }

  toolSchema(turnId, endpointId) {
    return this.memberSchemaForTurn(turnId) ?? this.memberSchemaForEndpoint(endpointId);
  }

  panelSchemaForStart(session) {
    const row = this.store.get(
      'SELECT schema_version FROM panel_session_context_formats WHERE session_id=?',
      session.id,
    );
    if (row) return row.schema_version;
    return session.session ? LEGACY_SCHEMA_VERSION : CONTEXT_SCHEMA_VERSION;
  }

  rememberPanelSchema(session, schema) {
    const existing = this.store.get(
      'SELECT schema_version FROM panel_session_context_formats WHERE session_id=?',
      session.id,
    );
    if (!existing) {
      const timestamp = now();
      this.store.run(
        'INSERT INTO panel_session_context_formats VALUES(?,?,?,?,?)',
        session.id,
        schema,
        schema === CONTEXT_SCHEMA_VERSION ? 'new-session' : 'legacy-detected',
        timestamp,
        timestamp,
      );
    }
    session.context_schema = existing?.schema_version ?? schema;
    return session.context_schema;
  }

  panelSchemaForTurn(turnId) {
    if (!turnId) return null;
    return this.store.get(
      "SELECT schema_version FROM turn_context_schemas WHERE turn_id=? AND scope='panel'",
      turnId,
    )?.schema_version ?? null;
  }

  panelSchemaForSession(session) {
    return this.store.get(
      'SELECT schema_version FROM panel_session_context_formats WHERE session_id=?',
      session.id,
    )?.schema_version ?? LEGACY_SCHEMA_VERSION;
  }

  forgetSessionFormats(endpointId, sessionKey = null) {
    if (sessionKey) this.store.run('DELETE FROM endpoint_context_formats WHERE endpoint_id=? AND session_key=?', endpointId, sessionKey);
    else this.store.run('DELETE FROM endpoint_context_formats WHERE endpoint_id=?', endpointId);
  }

  pruneOrphanTurnSchemas() {
    this.store.run(
      'DELETE FROM turn_context_schemas WHERE turn_id NOT IN (SELECT id FROM turns) AND turn_id NOT IN (SELECT id FROM panel_turns)',
    );
  }

  // --- message views -----------------------------------------------------

  listMessages({ groupId, after = 0, limit = 50, senderId = null, itemId = null, schema = CONTEXT_SCHEMA_VERSION }) {
    const cap = clampInt(Number.isInteger(limit) ? limit : 50, 1, MAX_MESSAGE_PAGE);
    const params = [groupId, after];
    let where = 'm.group_id=? AND m.seq>?';
    if (senderId) { where += ' AND m.sender=?'; params.push(senderId); }
    if (itemId) { where += ' AND c.work_item_id=?'; params.push(itemId); }
    params.push(cap + 1);
    const rows = this.store.all(
      `SELECT m.* FROM messages m ${itemId ? 'JOIN message_context c ON c.message_id=m.id' : ''}
       WHERE ${where} ORDER BY m.seq LIMIT ?`,
      ...params,
    );
    const delivered = rows.slice(0, cap);
    if (schema !== CONTEXT_SCHEMA_VERSION) {
      return { messages: delivered, nextAfter: delivered.at(-1)?.seq ?? after };
    }
    return boundedMessages(rows, {
      limit: cap,
      after,
      previewCodePoints: this.budgets.previewCodePoints,
      workItemIds: this.workItemIds(delivered),
    });
  }

  workItemIds(rows) {
    const result = new Map();
    if (!rows.length) return result;
    const placeholders = rows.map(() => '?').join(',');
    for (const row of this.store.all(
      `SELECT message_id,work_item_id FROM message_context WHERE message_id IN (${placeholders})`,
      ...rows.map(row => row.id),
    )) result.set(row.message_id, row.work_item_id);
    return result;
  }

  readBody({ groupId, messageId, hash, offset = 0, bodyLimit = 1024, schema = CONTEXT_SCHEMA_VERSION }) {
    if (typeof messageId !== 'string' || !messageId.trim()) throw new Error('缺少正文消息ID');
    const row = this.store.get('SELECT * FROM messages WHERE id=? AND group_id=?', messageId, groupId);
    if (!row) throw new Error('消息不存在、已被删除或不属于当前团队');
    return expandMessageText(row, { hash, offset, bodyLimit, schema });
  }

  // --- collaboration views ----------------------------------------------

  collaborationView(full, { schema = CONTEXT_SCHEMA_VERSION, itemId = null, goalId = null } = {}) {
    return projectCollaboration(full, {
      schema,
      itemId,
      goalId,
      budget: this.budgets.collaborationBytes,
      previewCodePoints: this.budgets.previewCodePoints,
    });
  }

  turnInput({ full, group, policy, input, schema = CONTEXT_SCHEMA_VERSION, goalId = null }) {
    return projectTurnInput({
      full,
      group,
      policy,
      input,
      schema,
      goalId,
      budget: this.budgets.turnInputBytes,
    });
  }

  // --- measurement (metadata only; never message bodies) -----------------

  snapshotMeta(groupId) {
    const state = groupId ? this.store.get('SELECT * FROM team_state WHERE group_id=?', groupId) : null;
    const goalVersion = state?.goal_version ?? null;
    const itemRevisions = {};
    if (groupId && goalVersion != null) {
      for (const item of this.store.all(
        'SELECT id,revision FROM work_items WHERE group_id=? AND goal_version=? ORDER BY rowid',
        groupId,
        goalVersion,
      )) itemRevisions[item.id] = item.revision;
    }
    return {
      goalVersion,
      contractVersion: state?.contract_version ?? null,
      revision: state?.revision ?? null,
      itemRevisions,
    };
  }

  measure({ groupId = null, endpointId, turnId = null, kind, schemaVersion = CONTEXT_SCHEMA_VERSION, bytes, detail = {} }) {
    const meta = this.snapshotMeta(groupId);
    const recorded = { ...detail };
    if (kind === 'rules' || kind === 'turn_input') recorded.itemRevisions ??= meta.itemRevisions;
    this.store.run(
      `INSERT INTO information_measurements
       (id,group_id,endpoint_id,turn_id,kind,schema_version,goal_version,contract_version,revision,bytes,detail,created)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      randomUUID(),
      groupId,
      endpointId,
      turnId,
      kind,
      schemaVersion,
      meta.goalVersion,
      meta.contractVersion,
      meta.revision,
      Math.max(0, Math.round(bytes)),
      json(recorded),
      now(),
    );
  }

  ruleBudgetExceeded(instructions, schemaVersion = CONTEXT_SCHEMA_VERSION) {
    return schemaVersion === CONTEXT_SCHEMA_VERSION && byteSize(instructions) > this.budgets.rulesBytes;
  }

  assertRuleBudget(instructions, schemaVersion = CONTEXT_SCHEMA_VERSION) {
    if (!this.ruleBudgetExceeded(instructions, schemaVersion)) return;
    throw new Error(`固定规则超过 ${this.budgets.rulesBytes} 字节预算；规则不会被截断，请缩小规则或调整预算`);
  }

  measureRules({ groupId, endpointId, turnId, schemaVersion, instructions, fixed }) {
    const bytes = byteSize(instructions);
    this.measure({
      groupId,
      endpointId,
      turnId,
      kind: 'rules',
      schemaVersion,
      bytes,
      detail: { fixed: fixed === true, overBudget: this.ruleBudgetExceeded(instructions, schemaVersion) },
    });
  }

  measureTurnInput({ groupId, endpointId, turnId, schemaVersion, prompt }) {
    this.measure({ groupId, endpointId, turnId, kind: 'turn_input', schemaVersion, bytes: byteSize(prompt), detail: {} });
  }

  measureToolResult({ groupId, endpointId, turnId, schemaVersion, name, result, detail = {} }) {
    const bytes = byteSize(result);
    this.measure({ groupId, endpointId, turnId, kind: 'tool_result', schemaVersion, bytes, detail: { name, ...detail } });
    return { bytes };
  }

  manifest(turnId) {
    const rows = this.store.all(
      `SELECT kind,schema_version,goal_version,contract_version,revision,bytes,detail,created
       FROM information_measurements WHERE turn_id=? ORDER BY created,rowid`,
      turnId,
    ).map(row => ({ ...row, detail: parse(row.detail) }));
    const sum = kind => rows.filter(row => row.kind === kind).reduce((total, row) => total + row.bytes, 0);
    return {
      turnId,
      schemaVersions: [...new Set(rows.map(row => row.schema_version))],
      rulesBytes: sum('rules'),
      turnInputBytes: sum('turn_input'),
      toolResultBytes: sum('tool_result'),
      toolCalls: rows.filter(row => row.kind === 'tool_result').length,
      expandCount: rows.filter(row => row.kind === 'tool_result' && row.detail.expansion === true).length,
      measurements: rows,
    };
  }
}
