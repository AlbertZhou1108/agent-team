import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store.mjs';
import { EventLog } from '../../src/event-log.mjs';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'agent-eventlog-'));
  const store = new Store(directory);
  // 手工补一条 panel session,事件表有外键约束。
  store.run(
    "INSERT INTO panel_agents(id,name,host,created,updated) VALUES('a','P','dsh','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')",
  );
  store.run(
    "INSERT INTO conversations(id,group_id,panel_agent_id,context,key,created,updated) VALUES('s',NULL,'a','private','secret','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')",
  );
  const group = store.run(
    "INSERT INTO groups(id,name,workspace,created,policy) VALUES('g','G','/tmp','2026-01-01T00:00:00.000Z','workspace-write')",
  );
  return { directory, store, group };
}

function rows(store, sql) {
  return store.all(sql).map(row => ({ ...row, event: JSON.parse(row.event) }));
}

test('coalesces consecutive token deltas of one stream into a single row', () => {
  const { directory, store } = fixture();
  // 用假定时器接管刷新,验证合并发生在 flush 之前。
  const log = new EventLog(store, { flushMs: 60000 });
  try {
    for (const text of ['你', '好', '！']) {
      assert.equal(log.panel('s', { type: 'framework.reasoning.delta', text }, 't1'), null);
    }
    assert.equal(rows(store, 'SELECT * FROM history').length, 0, 'flush 前不应落库');
    log.flush();
    const stored = rows(store, 'SELECT * FROM history ORDER BY seq');
    assert.equal(stored.length, 1);
    assert.equal(stored[0].event.type, 'framework.reasoning.delta');
    assert.equal(stored[0].event.text, '你好！');
    assert.equal(stored[0].event.coalesced, 3);
    assert.ok(stored[0].event.from && stored[0].event.to);
  } finally {
    log.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('flushes pending deltas before a structured event so seq order is preserved', () => {
  const { directory, store } = fixture();
  const log = new EventLog(store, { flushMs: 60000 });
  try {
    log.panel('s', { type: 'framework.reasoning.delta', text: '思考' }, 't1');
    // 结构化事件必须立刻可见,且排在增量之后。
    const seq = log.panel('s', { type: 'framework.tool_call', name: 'teams_list' }, 't1');
    assert.equal(typeof seq, 'number');
    const stored = rows(store, 'SELECT * FROM history ORDER BY seq');
    assert.deepEqual(stored.map(row => row.event.type), [
      'framework.reasoning.delta',
      'framework.tool_call',
    ]);
  } finally {
    log.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('keeps different streams and different payload kinds apart', () => {
  const { directory, store } = fixture();
  const log = new EventLog(store, { flushMs: 60000 });
  try {
    log.panel('s', { type: 'framework.reasoning.delta', text: 'A' }, 't1');
    // 交错到达的另一条流:不能合并进上一行。
    log.panel('s', { type: 'framework.reasoning.delta', text: 'B' }, 't2');
    log.panel('s', { type: 'framework.reasoning.delta', text: 'C' }, 't1');
    // claude 的 thinking 增量与 text 增量是不同载荷。
    log.panel('s', { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'X' } } }, 't1');
    log.panel('s', { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Y' } } }, 't1');
    log.flush();
    const stored = rows(store, 'SELECT * FROM history ORDER BY seq');
    // 同一流的增量即使在缓冲里被别的流插队,也合并回同一行(A + C);
    // 不同流、不同载荷各自成行。
    assert.equal(stored.length, 4);
    assert.deepEqual(
      stored.filter(row => row.event.type === 'framework.reasoning.delta').map(row => row.event.text).sort(),
      ['AC', 'B'],
    );
  } finally {
    log.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('member history returns null for private endpoints and stores elsewhere', () => {
  const { directory, store } = fixture();
  const log = new EventLog(store, { flushMs: 60000 });
  try {
    // private 端点写入 history 的语义是"不记录",必须保持返回 null。
    for (const [id, memberId, context, key] of [
      ['e1', 'm1', 'private', 'k1'],
      ['e2', 'm2', 'coordination', 'k2'],
    ]) {
      store.run(
        "INSERT INTO members(id,group_id,name,host,role) VALUES(?,'g',?,'dsh','member')",
        memberId,
        memberId,
      );
      store.run(
        'INSERT INTO conversations(id,group_id,member_id,context,key,created,updated) VALUES(?,?,?,?,?,?,?)',
        id,
        'g',
        memberId,
        context,
        key,
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
      );
    }
    assert.equal(log.member('e1', { type: 'framework.text.delta', text: 'x' }, null), null);
    log.member('e2', { type: 'framework.text.delta', text: 'y' }, null);
    log.flush();
    const stored = rows(store, 'SELECT * FROM history ORDER BY seq');
    assert.equal(stored.length, 1);
    assert.equal(stored[0].event.text, 'y');
  } finally {
    log.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
