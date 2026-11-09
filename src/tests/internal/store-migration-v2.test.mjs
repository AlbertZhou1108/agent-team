// v1 -> v2 数据迁移:会话/回合/历史/投递合并后必须无损，且外键自洽。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, SCHEMA_VERSION } from '../../store.mjs';
import { createLegacyV1 } from '../support/legacy-v1.mjs';

const NOW = '2026-01-01T00:00:00.000Z';

function seedV1(directory) {
  const db = createLegacyV1(directory);
  db.exec(`
    INSERT INTO groups(id,name,workspace,lead,created,charter,policy,allow_shell) VALUES('g','G','/tmp','m1','${NOW}',NULL,'communication',0);
    INSERT INTO members(id,group_id,name,host,role,profile,removed) VALUES
      ('m1','g','lead','fake','lead','',NULL),('m2','g','two','fake','member','',NULL);
    INSERT INTO endpoints(id,group_id,member_id,context,peer,session,key) VALUES
      ('e1','g','m1','coordination',NULL,'sess-e1','k1'),
      ('e2','g','m2','pair:m1','m1','sess-e2','k2');
    INSERT INTO panel_agents(id,singleton,name,host,model_provider,model,reasoning_effort,workspace,access,created,updated)
      VALUES('p1',1,'panel','fake',NULL,NULL,NULL,NULL,'read-only','${NOW}','${NOW}');
    INSERT INTO panel_sessions(id,panel_agent_id,context,group_id,session,policy_signature,key,created,updated) VALUES
      ('s1','p1','coordination','g','sess-s1','sig-s1','k3','${NOW}','${NOW}'),
      ('s2','p1','private',NULL,'sess-s2','sig-s2','k4','${NOW}','${NOW}');
    INSERT INTO panel_messages(id,panel_agent_id,context,role,text,active_team_id,created)
      VALUES('pm1','p1','private','user','private hello',NULL,'${NOW}');
    INSERT INTO messages(id,group_id,sender,recipient,kind,text,reply_to,created) VALUES
      ('msg1','g','m2','m1','send','hello',NULL,'${NOW}'),
      ('msg2','g','p1','user','send','panel reply',NULL,'${NOW}'),
      ('msg3','g','m2','m1','send','queued',NULL,'${NOW}');
    INSERT INTO turns(id,endpoint_id,session,created) VALUES('t1','e1','sess-t1','${NOW}');
    INSERT INTO runtime_attempts(turn_id,group_id,endpoint_id,state,policy,detail,created,ended)
      VALUES('t1','g','e1','completed','{}',NULL,'${NOW}','${NOW}');
    INSERT INTO turn_inputs(turn_id,message_id,ordinal) VALUES('t1','msg1',0);
    INSERT INTO history(seq,endpoint_id,event,created,turn_id) VALUES(1,'e1','{"type":"framework.output","text":"ok"}','${NOW}','t1');
    INSERT INTO message_origins(message_id,turn_id,event_seq,call_id,native_call_id) VALUES('msg1','t1',1,'c1',NULL);
    INSERT INTO panel_turns(id,session_id,panel_agent_id,context,group_id,active_team_id,state,created,ended,source_user_message_id)
      VALUES('pt1','s1','p1','coordination','g','g','completed','${NOW}','${NOW}',NULL);
    INSERT INTO panel_history(seq,session_id,turn_id,event,created) VALUES(1,'s1','pt1','{"type":"framework.output","text":"panel"}','${NOW}');
    INSERT INTO panel_message_origins(message_id,turn_id,event_seq,call_id,native_call_id) VALUES('msg2','pt1',1,'c2',NULL);
    INSERT INTO outbox(id,endpoint_id,payload,accepted,error) VALUES('o1','e1','{}','${NOW}',NULL);
    INSERT INTO panel_outbox(id,session_id,payload,accepted,error) VALUES('o2','s1','{}',NULL,'boom');
    INSERT INTO attached(message_id,outbox_id) VALUES('msg1','o1');
    INSERT INTO endpoint_session_bindings(endpoint_id,session_key,session,updated) VALUES('e1','default','sess-e1','${NOW}');
    INSERT INTO endpoint_session_policies(endpoint_id,session_key,signature) VALUES('e1','default','sig-e1');
    INSERT INTO endpoint_policy(endpoint_id,signature) VALUES('e1','sig-e1');
    INSERT INTO endpoint_context_formats(endpoint_id,session_key,schema_version,source,created,updated) VALUES('e1','default',2,'new-session','${NOW}','${NOW}');
    INSERT INTO panel_session_context_formats(session_id,schema_version,source,created,updated) VALUES('s1',2,'new-session','${NOW}','${NOW}');
    INSERT INTO panel_updates(id,panel_agent_id,group_id,source_turn_id,kind,text,source_message_ids,created,delivered_turn_id,delivered)
      VALUES('u1','p1','g','pt1','update','note','[]','${NOW}',NULL,NULL);
    INSERT INTO interactions(id,group_id,member_id,panel_agent_id,endpoint_id,context,turn_id,call_id,message_id,panel_message_id,kind,payload,state,detail,created)
      VALUES('i1','g','m1',NULL,'e1','coordination','t1','call1',NULL,NULL,'choice','{}','pending',NULL,'${NOW}');
    INSERT INTO team_creation_requests(operation_id,payload,group_id) VALUES('op-create','{}','g');
    INSERT INTO team_directive_requests(group_id,operation_id,message_id) VALUES('g','op-directive','msg1');
    INSERT INTO panel_message_requests(panel_agent_id,client_message_id,payload_hash,panel_message_id,created_at)
      VALUES('p1','cm-1','hash-1','pm1','${NOW}');
  `);
  db.close();
}

test('v1 data is migrated to the unified v2 schema without loss', t => {
  const directory = mkdtempSync(join(tmpdir(), 'store-v2-migrate-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  seedV1(directory);

  const store = new Store(directory);
  assert.equal(store.schemaVersion(), SCHEMA_VERSION);
  assert.ok(store.all('PRAGMA table_info(messages)').some(column => column.name === 'expects_reply'));
  assert.ok(store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workbench_dismissals'"));

  // 会话:两条成员 + 两条 Panel，id 原样保留。
  assert.deepEqual(
    store.all('SELECT id,context,member_id,panel_agent_id FROM conversations ORDER BY id').map(row => ({ ...row })),
    [
      { id: 'e1', context: 'coordination', member_id: 'm1', panel_agent_id: null },
      { id: 'e2', context: 'pair:m1', member_id: 'm2', panel_agent_id: null },
      { id: 's1', context: 'coordination', member_id: null, panel_agent_id: 'p1' },
      { id: 's2', context: 'private', member_id: null, panel_agent_id: 'p1' },
    ],
  );
  assert.equal(store.get('SELECT policy_signature FROM conversations WHERE id=?', 'e1').policy_signature, 'sig-e1');
  assert.equal(store.get('SELECT policy_signature FROM conversations WHERE id=?', 's1').policy_signature, 'sig-s1');

  // 回合:状态、执行者、团队上下文都来自旧表。
  const turns = store.all('SELECT id,conversation_id,executor_kind,executor_id,group_id,state FROM turns ORDER BY id').map(row => ({ ...row }));
  assert.deepEqual(turns, [
    { id: 'pt1', conversation_id: 's1', executor_kind: 'panel_agent', executor_id: 'p1', group_id: 'g', state: 'completed' },
    { id: 't1', conversation_id: 'e1', executor_kind: 'member', executor_id: 'm1', group_id: 'g', state: 'completed' },
  ]);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM turn_inputs').n, 1);

  // 历史:成员 seq 保留，Panel 历史平移到其后；origin 的 event_seq 必须跟着偏移。
  assert.deepEqual(store.all('SELECT seq,conversation_id,turn_id FROM history ORDER BY seq').map(row => ({ ...row })), [
    { seq: 1, conversation_id: 'e1', turn_id: 't1' },
    { seq: 2, conversation_id: 's1', turn_id: 'pt1' },
  ]);
  assert.equal(store.get('SELECT event_seq FROM message_origins WHERE message_id=?', 'msg1').event_seq, 1);
  assert.equal(store.get('SELECT event_seq FROM message_origins WHERE message_id=?', 'msg2').event_seq, 2);

  // 队列:两张表合并，accepted/error 原样保留。
  assert.deepEqual(store.all('SELECT id,conversation_id,accepted,error FROM outbox ORDER BY id').map(row => ({ ...row })), [
    { id: 'o1', conversation_id: 'e1', accepted: NOW, error: null },
    { id: 'o2', conversation_id: 's1', accepted: null, error: 'boom' },
  ]);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM attached').n, 1);
  // v3 待投递标记:已进入 attached 的清零，未投递的 send 置 1，user 收件人不参与投递。
  assert.deepEqual(
    store.all('SELECT id,awaiting FROM messages ORDER BY id').map(row => ({ ...row })),
    [{ id: 'msg1', awaiting: 0 }, { id: 'msg2', awaiting: 0 }, { id: 'msg3', awaiting: 1 }],
  );

  // 绑定/策略/格式(v7 合一为 conversation_session_meta)、Panel 私聊消息、互动卡都保留。
  const meta = store.get('SELECT * FROM conversation_session_meta WHERE conversation_id=?', 'e1');
  assert.equal(meta.session, 'sess-e1');
  assert.equal(meta.policy_signature, 'sig-e1');
  assert.equal(meta.schema_version, 2);
  assert.equal(store.get("SELECT schema_version FROM conversation_session_meta WHERE conversation_id=? AND session_key='default'", 's1').schema_version, 2);
  assert.equal(store.get('SELECT text FROM panel_messages WHERE id=?', 'pm1').text, 'private hello');
  assert.equal(store.get('SELECT conversation_id FROM interactions WHERE id=?', 'i1').conversation_id, 'e1');
  assert.equal(store.get('SELECT source_turn_id FROM panel_updates WHERE id=?', 'u1').source_turn_id, 'pt1');

  // v7 幂等表合一:三张旧表的行进入 operation_records(scope+scope_id+client_key 定位)。
  assert.deepEqual(store.all('SELECT scope,scope_id,client_key,payload,ref FROM operation_records ORDER BY scope').map(row => ({ ...row })), [
    { scope: 'group-create', scope_id: '', client_key: 'op-create', payload: '{}', ref: 'g' },
    { scope: 'panel-private-message', scope_id: 'p1', client_key: 'cm-1', payload: 'hash-1', ref: 'pm1' },
    { scope: 'team-directive', scope_id: 'g', client_key: 'op-directive', payload: null, ref: 'msg1' },
  ]);

  // 旧表全部清掉，外键自洽。
  assert.deepEqual(store.all('PRAGMA foreign_key_check'), []);
  assert.deepEqual(store.all("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('endpoints','panel_sessions','panel_turns','runtime_attempts','panel_history','panel_outbox','conversation_session_bindings','conversation_session_policies','conversation_context_formats','team_creation_requests','team_directive_requests','panel_message_requests')"), []);
  store.close();
});

test('reopening a migrated directory is idempotent', t => {
  const directory = mkdtempSync(join(tmpdir(), 'store-v2-reopen-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  seedV1(directory);
  let store = new Store(directory);
  const before = store.all('SELECT id FROM conversations ORDER BY id').map(row => row.id);
  store.close();
  store = new Store(directory);
  assert.equal(store.schemaVersion(), SCHEMA_VERSION);
  assert.deepEqual(store.all('SELECT id FROM conversations ORDER BY id').map(row => row.id), before);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM history').n, 2);
  store.close();
});
