// v20 桌面域基础迁移:应用注册表、binding surface/cwd、主控关系与 workspace 状态。
// 用「回退手术」把当前库剥成 v19 形状再重开,验证迁移无丢失且既有席位播种成关系。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, SCHEMA_VERSION } from '../../store.mjs';

const NOW = '2026-01-01T00:00:00.000Z';

function tempDir(t) {
  const directory = mkdtempSync(join(tmpdir(), 'store-schema-v20-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  return directory;
}

/**
 * 把当前库回退成 v19 形状:删掉 v20 新表与新增列。
 * surface 带 CHECK、旧 app_id 曾带 FK,SQLite 拒绝直接 DROP COLUMN,
 * 按表信息重建一次绑定表;其余列直接剥。
 */
function downgradeToV19(store) {
  store.db.exec(`DROP TABLE workspace_events;
    DROP TABLE team_controller_relations;
    DROP TABLE desktop_applications;`);
  const dropped = new Set(['app_id', 'surface', 'controller_cwd', 'controller_cwd_updated']);
  const info = store.all('PRAGMA table_info(external_client_bindings)').filter(column => !dropped.has(column.name));
  const names = info.map(column => column.name);
  const primaryKey = info.filter(column => column.pk > 0).map(column => column.name);
  store.transaction(() => {
    store.db.exec('ALTER TABLE external_client_bindings RENAME TO bindings_v20_tmp');
    const columnSql = info.map(column =>
      `${column.name} ${column.type}${column.notnull ? ' NOT NULL' : ''}${column.dflt_value !== null ? ` DEFAULT ${column.dflt_value}` : ''}`,
    ).join(', ');
    store.db.exec(`CREATE TABLE external_client_bindings(${columnSql}${primaryKey.length ? `, PRIMARY KEY(${primaryKey.join(',')})` : ''})`);
    store.db.exec(`INSERT INTO external_client_bindings(${names.join(',')}) SELECT ${names.join(',')} FROM bindings_v20_tmp`);
    store.db.exec('DROP TABLE bindings_v20_tmp');
  });
  store.db.exec('ALTER TABLE groups DROP COLUMN workspace_pending');
  store.db.exec('ALTER TABLE groups DROP COLUMN workspace_revision');
  store.setSchemaVersion(19);
}

test('a fresh database carries the v20 desktop artifacts', t => {
  const directory = tempDir(t);
  const store = new Store(directory);
  assert.equal(store.schemaVersion(), SCHEMA_VERSION);
  const bindingColumns = store.all('PRAGMA table_info(external_client_bindings)').map(column => column.name);
  for (const column of ['app_id', 'surface', 'controller_cwd', 'controller_cwd_updated']) {
    assert.ok(bindingColumns.includes(column), `external_client_bindings 缺少 ${column}`);
  }
  const groupColumns = store.all('PRAGMA table_info(groups)').map(column => column.name);
  for (const column of ['workspace_pending', 'workspace_revision']) {
    assert.ok(groupColumns.includes(column), `groups 缺少 ${column}`);
  }
  for (const table of ['desktop_applications', 'team_controller_relations', 'workspace_events']) {
    assert.ok(store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", table), `缺少 ${table}`);
  }
  store.close();
});

test('a v19 database migrates without loss and seeds controller relations from seats', t => {
  const directory = tempDir(t);
  let store = new Store(directory);
  // v19 时代的真实数据:principal + binding + 外部主控团队 + 成员会话与消息。
  store.run("INSERT INTO external_principals(id,name,created,updated) VALUES('p1','本机用户',?,?)", NOW, NOW);
  store.run(
    `INSERT INTO external_client_bindings(id,principal_id,name,host,command,key_hash,session,declared_capabilities,status,created,updated)
     VALUES('b1','p1','主控会话','codex','codex','hash-b1','thread-1','["session.deliver","turn.observe"]','active',?,?)`,
    NOW, NOW,
  );
  store.run("INSERT INTO groups(id,name,workspace,lead,created,charter,policy,allow_shell) VALUES('g1','G','/tmp/w1',NULL,?,NULL,'read-only',0)", NOW);
  store.run(
    `INSERT INTO team_lead_controllers(group_id,controller_kind,controller_id,controller_binding_id,state,original_lead_id,revision,updated)
     VALUES('g1','external_agent','p1','b1','active',NULL,3,?)`,
    NOW,
  );
  store.run("INSERT INTO members(id,group_id,name,host,role) VALUES('m1','g1','成员','fake','member')");
  store.run("INSERT INTO conversations(id,group_id,member_id,panel_agent_id,context,session,key,created,updated) VALUES('c1','g1','m1',NULL,'pair:lead','native-1','k1',?,?)", NOW, NOW);
  store.run("INSERT INTO messages(id,group_id,sender,recipient,kind,text,created) VALUES('msg1','g1','p1','m1','send','派工',?)", NOW);
  downgradeToV19(store);
  store.close();

  store = new Store(directory);
  assert.equal(store.schemaVersion(), SCHEMA_VERSION);
  // 数据不丢:绑定、团队、消息、成员会话原样保留。
  const binding = store.get('SELECT * FROM external_client_bindings WHERE id=?', 'b1');
  assert.equal(binding.session, 'thread-1');
  assert.deepEqual(JSON.parse(binding.declared_capabilities), ['session.deliver', 'turn.observe']);
  assert.equal(binding.surface, 'cli');
  assert.equal(store.get('SELECT text FROM messages WHERE id=?', 'msg1').text, '派工');
  assert.equal(store.get('SELECT session FROM conversations WHERE id=?', 'c1').session, 'native-1');
  assert.equal(store.get('SELECT workspace FROM groups WHERE id=?', 'g1').workspace, '/tmp/w1');
  assert.equal(store.get('SELECT workspace_revision FROM groups WHERE id=?', 'g1').workspace_revision, 0);
  // 席位播种成 creator 关系,revision 沿用席位版本。
  const relation = store.get('SELECT * FROM team_controller_relations WHERE group_id=? AND binding_id=?', 'g1', 'b1');
  assert.equal(relation.principal_id, 'p1');
  assert.equal(relation.origin, 'creator');
  assert.equal(relation.revision, 3);
  store.close();
});

test('a migrated v19 database keeps desktop state usable for new writes', t => {
  const directory = tempDir(t);
  let store = new Store(directory);
  store.run("INSERT INTO groups(id,name,workspace,created) VALUES('g1','G',?,?)", '/tmp/w1', NOW);
  downgradeToV19(store);
  store.close();

  store = new Store(directory);
  // 迁移后的库接受 v20 新事实:应用注册 upsert、待定切换、事件留痕。
  store.run(
    `INSERT INTO desktop_applications(id,kind,surface,install_path,engine_path,readiness,created,updated)
     VALUES('app1','codex','desktop','/Applications/ChatGPT.app','/engine','available',?,?)`,
    NOW, NOW,
  );
  store.run('UPDATE groups SET workspace_pending=? WHERE id=?', '/tmp/w2', 'g1');
  store.run(
    "INSERT INTO workspace_events(group_id,kind,from_path,to_path,revision,created) VALUES('g1','pending','/tmp/w1','/tmp/w2',1,?)",
    NOW,
  );
  assert.equal(store.get('SELECT workspace_pending FROM groups WHERE id=?', 'g1').workspace_pending, '/tmp/w2');
  assert.equal(store.get("SELECT count(*) AS count FROM workspace_events WHERE group_id='g1'").count, 1);
  store.close();
});
