// 30 天保留:只删已可安全丢弃的投递/回合/历史，保留待投递、待响应、待核实与 Panel 私聊。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store.mjs';

const DAY = 86400000;
const old = new Date(Date.now() - 40 * DAY).toISOString();
const fresh = new Date(Date.now() - 1 * DAY).toISOString();

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'store-retention-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const store = new Store(directory);
  store.run("INSERT INTO groups(id,name,workspace,created) VALUES('g','G','/tmp',?)", old);
  store.run("INSERT INTO members(id,group_id,name,host,role) VALUES('m1','g','one','fake','lead'),('m2','g','two','fake','member')");
  store.run("INSERT INTO panel_agents(id,singleton,name,host,access,created,updated) VALUES('p1',1,'panel','fake','read-only',?,?)", old, old);
  const conversation = store.conversation('member', 'm1', 'coordination');
  store.db.exec('CREATE TABLE IF NOT EXISTS turn_context_schemas(turn_id TEXT PRIMARY KEY,scope TEXT NOT NULL,schema_version INTEGER NOT NULL,session_key TEXT,created TEXT NOT NULL)');
  const appendAt = (sender, recipient, kind, text, created) => {
    const message = store.append('g', sender, recipient, kind, text);
    store.run('UPDATE messages SET created=? WHERE id=?', created, message.id);
    return message;
  };
  const turnAt = (id, state, created) => {
    store.run(
      'INSERT INTO turns(id,conversation_id,executor_kind,executor_id,group_id,state,created) VALUES(?,?,?,?,?,?,?)',
      id, conversation.id, 'member', 'm1', 'g', state, created,
    );
  };
  return { store, conversation, appendAt, turnAt };
}

test('prunes delivered history older than the retention window and keeps live data', t => {
  const { store, conversation, appendAt, turnAt } = setup(t);

  // 已交付 / 排队中 / 失败重试中的消息。
  const delivered = appendAt('m2', 'm1', 'send', 'old delivered', old);
  const deliveredEntry = store.prepare(delivered, conversation);
  store.run('UPDATE outbox SET accepted=? WHERE id=?', old, deliveredEntry.id);
  const queued = appendAt('m2', 'm1', 'send', 'queued', old);
  const queuedEntry = store.prepare(queued, conversation);
  const failed = appendAt('m2', 'm1', 'send', 'failed', old);
  const failedEntry = store.prepare(failed, conversation);
  store.run('UPDATE outbox SET error=? WHERE id=?', 'boom', failedEntry.id);

  // 新消息单独入队，避免把后面构造的待投递消息一起合批。
  const freshMessage = appendAt('m2', 'm1', 'send', 'fresh', fresh);
  const freshEntry = store.prepare(freshMessage, conversation);
  store.run('UPDATE outbox SET accepted=? WHERE id=?', fresh, freshEntry.id);

  // 保留项:待投递、待响应互动卡、待核实回合输入、Panel 私聊。
  const pending = appendAt('m2', 'm1', 'send', 'pending', old);
  const interactionMessage = appendAt('user', 'm1', 'send', 'card anchor', old);
  store.run('UPDATE messages SET awaiting=0 WHERE id=?', interactionMessage.id);
  store.createInteraction({ id: 'i1', groupId: 'g', memberId: 'm1', context: 'coordination', turnId: 'iturn', callId: 'c1', messageId: interactionMessage.id, kind: 'choice', payload: {} });
  const unknownInput = appendAt('m2', 'm1', 'send', 'unknown input', old);
  store.run('UPDATE messages SET awaiting=0 WHERE id=?', unknownInput.id);
  turnAt('unknown-turn', 'unknown', old);
  store.run('INSERT INTO turn_inputs(turn_id,message_id,ordinal) VALUES(?,?,0)', 'unknown-turn', unknownInput.id);
  const userFacing = appendAt('m1', 'user', 'send', 'old answer', old);
  store.run("INSERT INTO panel_messages(id,panel_agent_id,context,role,text,created) VALUES('pm1','p1','private','user','private hello',?)", old);

  // 旧已完成回合 / 旧待核实回合 / 新回合，以及各自的历史与 schema 记录。
  turnAt('completed-turn', 'completed', old);
  turnAt('fresh-turn', 'completed', fresh);
  store.run("INSERT INTO history(conversation_id,event,created,turn_id) VALUES(?,'{}',?,'completed-turn')", conversation.id, old);
  store.run("INSERT INTO history(conversation_id,event,created,turn_id) VALUES(?,'{}',?,'unknown-turn')", conversation.id, old);
  store.run("INSERT INTO history(conversation_id,event,created,turn_id) VALUES(?,'{}',?,NULL)", conversation.id, old);
  store.run("INSERT INTO turn_context_schemas(turn_id,scope,schema_version,session_key,created) VALUES('completed-turn','member',2,'default',?)", old);
  store.run("INSERT INTO turn_context_schemas(turn_id,scope,schema_version,session_key,created) VALUES('unknown-turn','member',2,'default',?)", old);

  const result = store.pruneHistory({ retentionDays: 30 });
  const ids = sql => store.all(sql).map(row => row.id);

  assert.ok(!ids('SELECT id FROM messages').includes(delivered.id), '已交付旧消息应删除');
  assert.ok(ids('SELECT id FROM messages').includes(queued.id), '排队消息应保留');
  assert.ok(ids('SELECT id FROM messages').includes(failed.id), '失败待重试消息应保留');
  assert.ok(ids('SELECT id FROM messages').includes(pending.id), '待投递消息应保留');
  assert.ok(ids('SELECT id FROM messages').includes(interactionMessage.id), '待响应互动卡锚点应保留');
  assert.ok(ids('SELECT id FROM messages').includes(unknownInput.id), '待核实回合输入应保留');
  assert.ok(ids('SELECT id FROM messages').includes(freshMessage.id), '未过期消息应保留');
  assert.ok(!ids('SELECT id FROM messages').includes(userFacing.id), '旧用户可见消息应删除');

  assert.deepEqual(ids('SELECT id FROM turns ORDER BY id'), ['fresh-turn', 'unknown-turn']);
  assert.deepEqual(store.all('SELECT turn_id FROM history WHERE turn_id IS NOT NULL ORDER BY turn_id').map(row => row.turn_id), ['unknown-turn']);
  assert.deepEqual(ids('SELECT id FROM outbox ORDER BY id'), [failedEntry.id, queuedEntry.id, freshEntry.id].sort());
  assert.equal(store.get("SELECT COUNT(*) AS n FROM turn_context_schemas WHERE turn_id='completed-turn'").n, 0);
  assert.equal(store.get("SELECT COUNT(*) AS n FROM turn_context_schemas WHERE turn_id='unknown-turn'").n, 1);
  assert.equal(store.get('SELECT text FROM panel_messages WHERE id=?', 'pm1').text, 'private hello');
  assert.ok(result.messages >= 2);
  assert.ok(result.turns >= 1);
  assert.ok(result.history >= 2);
  assert.ok(result.outbox >= 1);
  store.close();
});
