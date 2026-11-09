// 数据目录 schema 版本号:新库/旧库统一标记、过新版本拒绝、重开幂等。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, SCHEMA_VERSION } from '../../store.mjs';
import { createLegacyV1 } from '../support/legacy-v1.mjs';

function tempDir(t) {
  const directory = mkdtempSync(join(tmpdir(), 'store-schema-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return directory;
}

const NOW = '2026-01-01T00:00:00.000Z';

test('a fresh database is stamped with the current schema version and keeps it across reopen', t => {
  const directory = tempDir(t);
  let store = new Store(directory);
  assert.equal(store.schemaVersion(), SCHEMA_VERSION);
  store.run(
    "INSERT INTO groups(id,name,workspace,lead,created,charter,policy,allow_shell) VALUES('g1','G','/tmp',NULL,?,NULL,'communication',0)",
    NOW,
  );
  store.close();

  store = new Store(directory);
  assert.equal(store.schemaVersion(), SCHEMA_VERSION);
  assert.equal(store.get('SELECT name FROM groups WHERE id=?', 'g1').name, 'G');
  store.close();
});

test('a v1 database (user_version=0) is stamped without losing rows', t => {
  const directory = tempDir(t);
  const legacy = createLegacyV1(directory);
  legacy.exec(
    "INSERT INTO groups(id,name,workspace,lead,created,charter,policy,allow_shell) VALUES('g1','legacy','/tmp',NULL,'2026-01-01T00:00:00.000Z',NULL,'communication',0)",
  );
  legacy.close();

  const store = new Store(directory);
  assert.equal(store.schemaVersion(), SCHEMA_VERSION);
  assert.equal(store.get('SELECT name FROM groups WHERE id=?', 'g1').name, 'legacy');
  store.close();
});

test('a v3 database gains the reply protocol and workbench dismissals on reopen', t => {
  const directory = tempDir(t);
  let store = new Store(directory);
  store.run('DROP INDEX IF EXISTS messages_expects_reply');
  store.run('ALTER TABLE messages DROP COLUMN expects_reply');
  store.run('DROP TABLE IF EXISTS workbench_dismissals');
  store.setSchemaVersion(3);
  store.close();

  store = new Store(directory);
  assert.equal(store.schemaVersion(), SCHEMA_VERSION);
  assert.ok(store.all('PRAGMA table_info(messages)').some(column => column.name === 'expects_reply'));
  assert.ok(store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workbench_dismissals'"));
  store.close();
});

test('a v4 database gains archive snapshots without backfilling old archived teams', t => {
  const directory = tempDir(t);
  let store = new Store(directory);
  store.run("INSERT INTO groups(id,name,workspace,created,state) VALUES('old','Old',?,?, 'archived')", directory, NOW);
  store.run('DROP TABLE archive_snapshots');
  store.setSchemaVersion(4);
  store.close();

  store = new Store(directory);
  assert.equal(store.schemaVersion(), SCHEMA_VERSION);
  assert.equal(store.get("SELECT name FROM groups WHERE id='old'").name, 'Old');
  assert.deepEqual(store.all('SELECT * FROM archive_snapshots'), []);
  store.close();
});

test('a v8 database rebuilds interactions so multi-step flow cards can be stored', t => {
  const directory = tempDir(t);
  let store = new Store(directory);
  store.run("INSERT INTO groups(id,name,workspace,created) VALUES('g1','G',?,?)", directory, NOW);
  store.run(
    "INSERT INTO interactions(id,group_id,context,turn_id,call_id,kind,payload,state,created) VALUES('i1','g1','coordination','t','c','choice','{\"kind\":\"choice\"}','pending',?)",
    NOW,
  );
  // 回退成 v8:把当前表 SQL 去掉 flow 再建回来,行原样搬迁。
  const v8Sql = store.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='interactions'").sql.replace(",'flow'", '');
  store.run('ALTER TABLE interactions RENAME TO interactions_v9');
  store.run(v8Sql);
  store.run('INSERT INTO interactions SELECT * FROM interactions_v9');
  store.run('DROP TABLE interactions_v9');
  store.setSchemaVersion(8);
  store.close();

  store = new Store(directory);
  assert.equal(store.schemaVersion(), SCHEMA_VERSION);
  assert.ok(store.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='interactions'").sql.includes("'flow'"));
  assert.equal(store.get('SELECT kind FROM interactions WHERE id=?', 'i1').kind, 'choice');
  store.run(
    "INSERT INTO interactions(id,group_id,context,turn_id,call_id,kind,payload,state,created) VALUES('i2','g1','coordination','t','c','flow','{}','pending',?)",
    NOW,
  );
  assert.equal(store.interaction('i2').kind, 'flow');
  store.close();
});

test('a v11 database gains external controller identities, controller kind and binding seat', t => {
  const directory = tempDir(t);
  let store = new Store(directory);
  store.run("INSERT INTO groups(id,name,workspace,created) VALUES('g1','G',?,?)", directory, NOW);
  store.run(
    "INSERT INTO members(id,group_id,name,host,role) VALUES('m1','g1','lead','fake','lead')",
  );
  store.run(
    "INSERT INTO team_lead_controllers(group_id,controller_kind,controller_id,state,original_lead_id,revision,updated) VALUES('g1','member','m1','active',NULL,1,?)",
    NOW,
  );
  const v11Sql = store.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='team_lead_controllers'").sql
    .replace(",'external_agent'", '');
  store.run('ALTER TABLE team_lead_controllers RENAME TO team_lead_controllers_v12');
  store.run(v11Sql);
  store.run('INSERT INTO team_lead_controllers SELECT * FROM team_lead_controllers_v12');
  store.run('DROP TABLE team_lead_controllers_v12');
  store.run('DROP TABLE external_decisions');
  store.run('DROP TABLE external_deliveries');
  store.run('DROP TABLE external_client_bindings');
  store.run('DROP TABLE external_principals');
  store.setSchemaVersion(11);
  store.close();

  store = new Store(directory);
  assert.equal(store.schemaVersion(), SCHEMA_VERSION);
  assert.equal(store.get("SELECT controller_kind FROM team_lead_controllers WHERE group_id='g1'").controller_kind, 'member');
  assert.match(
    store.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='team_lead_controllers'").sql,
    /external_agent/,
  );
  assert.ok(
    store.all('PRAGMA table_info(team_lead_controllers)').some(column => column.name === 'controller_binding_id'),
  );
  assert.ok(store.all('PRAGMA table_info(external_client_bindings)').some(column => column.name === 'command'));
  assert.ok(store.all('PRAGMA table_info(external_deliveries)').some(column => column.name === 'wake_state'));
  assert.ok(store.all('PRAGMA table_info(external_client_bindings)').some(column => column.name === 'wake_state'));
  assert.ok(store.all('PRAGMA table_info(members)').some(column => column.name === 'effective_policy'));
  assert.ok(store.all('PRAGMA table_info(messages)').some(column => column.name === 'required_capabilities'));
  store.run(
    "INSERT INTO external_principals(id,name,created,updated) VALUES('p1','user',?,?)",
    NOW, NOW,
  );
  assert.equal(store.get("SELECT name FROM external_principals WHERE id='p1'").name, 'user');
  store.close();
});

test('a v17 database gains read watermarks and treats existing history as read', t => {
  const directory = tempDir(t);
  let store = new Store(directory);
  store.run("INSERT INTO groups(id,name,workspace,created) VALUES('g1','G',?,?)", directory, NOW);
  store.run(
    "INSERT INTO messages(id,group_id,sender,recipient,kind,text,created) VALUES('m1','g1','lead','user','send','历史消息',?)",
    NOW,
  );
  store.run('DROP TABLE read_watermarks');
  store.run('ALTER TABLE panel_messages DROP COLUMN receipt_id');
  store.setSchemaVersion(17);
  store.close();

  store = new Store(directory);
  assert.equal(store.schemaVersion(), SCHEMA_VERSION);
  assert.ok(store.all('PRAGMA table_info(panel_messages)').some(column => column.name === 'receipt_id'));
  const baseline = store.get("SELECT seq FROM read_watermarks WHERE scope='group' AND scope_id='g1'");
  assert.equal(baseline.seq, store.get('SELECT MAX(seq) AS seq FROM messages').seq);
  store.close();
});

test('a database created by a newer schema is rejected instead of being opened', t => {
  const directory = tempDir(t);
  const store = new Store(directory);
  store.setSchemaVersion(SCHEMA_VERSION + 1);
  store.close();

  assert.throws(() => new Store(directory), /更新版本/);
});
