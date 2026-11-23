// 数据目录 schema 版本号、增量迁移与持久化耐久策略:新库/旧库统一标记、过新版本拒绝、重开幂等。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, SCHEMA_VERSION } from '../../store.mjs';
import * as teams from '../../aggregates/teams.mjs';
import { createLegacyV1 } from '../support/legacy-v1.mjs';

function tempDir(t) {
  const directory = mkdtempSync(join(tmpdir(), 'store-schema-'));
  t.after(() => { try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ } });
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

test('v19 drops the unused probe column without losing declared capabilities', t => {
  const directory = tempDir(t);
  let store = new Store(directory);
  store.run("INSERT INTO external_principals(id,name,created,updated) VALUES('p1','u',?,?)", NOW, NOW);
  // 当前 schema 已无 probed 列；手工加回，模拟 v18 库。
  store.db.exec("ALTER TABLE external_client_bindings ADD COLUMN probed_capabilities TEXT NOT NULL DEFAULT '[]'");
  store.run(
    `INSERT INTO external_client_bindings(id,principal_id,name,host,key_hash,session,declared_capabilities,probed_capabilities,status,created,updated)
     VALUES('b1','p1','main','codex','h',NULL,'["session.deliver"]','["session.deliver"]','active',?,?)`,
    NOW, NOW,
  );
  store.db.exec('PRAGMA user_version=18');
  store.close();

  store = new Store(directory);
  const columns = store.all('PRAGMA table_info(external_client_bindings)').map(column => column.name);
  assert.equal(columns.includes('probed_capabilities'), false);
  const row = store.get('SELECT declared_capabilities FROM external_client_bindings WHERE id=?', 'b1');
  assert.deepEqual(JSON.parse(row.declared_capabilities), ['session.deliver']);
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
  // v14 之后的桌面域事实表也一并剥掉,保持 v11 形状(关系表引用绑定表,先删它)。
  store.run('DROP TABLE IF EXISTS workspace_events');
  store.run('DROP TABLE IF EXISTS team_controller_relations');
  store.run('DROP TABLE IF EXISTS desktop_applications');
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

test('a v20 database gains desktop disable controls and bundle version', t => {
  const directory = tempDir(t);
  let store = new Store(directory);
  store.run(
    `INSERT INTO desktop_applications(id,kind,surface,install_path,engine_path,readiness,created,updated)
     VALUES('app1','codex','desktop','/Applications/ChatGPT.app','/engine','available',?,?)`,
    NOW, NOW,
  );
  store.run('ALTER TABLE desktop_applications DROP COLUMN user_disabled');
  store.run('ALTER TABLE desktop_applications DROP COLUMN disabled_reason');
  store.run('ALTER TABLE desktop_applications DROP COLUMN bundle_version');
  store.setSchemaVersion(20);
  store.close();

  store = new Store(directory);
  assert.equal(store.schemaVersion(), SCHEMA_VERSION);
  const columns = store.all('PRAGMA table_info(desktop_applications)').map(column => column.name);
  for (const column of ['user_disabled', 'disabled_reason', 'bundle_version']) {
    assert.ok(columns.includes(column), `desktop_applications 缺少 ${column}`);
  }
  // 存量行保留;停用/版本列按默认值补齐。
  const row = store.get('SELECT * FROM desktop_applications WHERE id=?', 'app1');
  assert.equal(row.user_disabled, 0);
  assert.equal(row.bundle_version, null);
  store.run('UPDATE desktop_applications SET user_disabled=1,bundle_version=? WHERE id=?', '26.1111.71704', 'app1');
  assert.equal(store.get('SELECT user_disabled FROM desktop_applications WHERE id=?', 'app1').user_disabled, 1);
  store.close();
});

test('a v21 database gains the activation binding kind without changing existing bindings', t => {
  const directory = tempDir(t);
  let store = new Store(directory);
  store.run("INSERT INTO external_principals(id,name,created,updated) VALUES('p1','本机用户',?,?)", NOW, NOW);
  store.run(
    `INSERT INTO external_client_bindings(id,principal_id,name,host,key_hash,session,declared_capabilities,status,created,updated)
     VALUES('b1','p1','CLI 会话','codex','hash','thread-1','[]','active',?,?)`,
    NOW, NOW,
  );
  store.db.exec('ALTER TABLE external_client_bindings DROP COLUMN binding_kind');
  store.setSchemaVersion(21);
  store.close();

  store = new Store(directory);
  assert.equal(store.schemaVersion(), SCHEMA_VERSION);
  // 存量 binding 保留且按默认值成为会话连接。
  const row = store.get('SELECT binding_kind,session FROM external_client_bindings WHERE id=?', 'b1');
  assert.equal(row.binding_kind, 'conversation');
  assert.equal(row.session, 'thread-1');
  // 激活连接可以落库并受 CHECK 约束保护。
  store.run(
    `INSERT INTO external_client_bindings(id,principal_id,name,host,key_hash,declared_capabilities,surface,binding_kind,status,created,updated)
     VALUES('b2','p1','Codex Desktop 接入','codex','hash2','[]','desktop','activation','active',?,?)`,
    NOW, NOW,
  );
  assert.throws(
    () => store.run(
      `INSERT INTO external_client_bindings(id,principal_id,name,host,key_hash,declared_capabilities,binding_kind,status,created,updated)
       VALUES('b3','p1','坏连接','codex','hash3','[]','weird','active',?,?)`,
      NOW, NOW,
    ),
    /CHECK/,
  );
  store.close();
});

test('a v23 database gains home_summaries on upgrade without losing existing panel agents', t => {
  const directory = tempDir(t);
  let store = new Store(directory);
  store.run(
    "INSERT INTO panel_agents(id,name,host,created,updated) VALUES('pa1','Panel','fake',?,?)",
    NOW, NOW,
  );
  store.run('DROP TABLE home_summaries');
  store.setSchemaVersion(23);
  store.close();

  store = new Store(directory);
  assert.equal(store.schemaVersion(), SCHEMA_VERSION);
  assert.ok(store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='home_summaries'"));
  store.run(
    "INSERT INTO home_summaries(id,panel_agent_id,text,created) VALUES('hs1','pa1','汇总正文',?)",
    NOW,
  );
  assert.equal(store.get("SELECT text FROM home_summaries WHERE id='hs1'").text, '汇总正文');
  store.close();
});

test('a v24 database gains the dispatch context-window column without losing messages', t => {
  const directory = tempDir(t);
  let store = new Store(directory);
  store.run("INSERT INTO groups(id,name,workspace,created) VALUES('g1','G',?,?)", directory, NOW);
  store.run(
    `INSERT INTO messages(id,group_id,sender,recipient,kind,text,created,required_capabilities) VALUES('m1','g1','lead','worker','send','历史派工',?,'["exec.read"]')`,
    NOW,
  );
  // 当前 schema 已有 min_context_window；手工去掉并回退版本号,模拟 v24 库。
  store.db.exec('ALTER TABLE messages DROP COLUMN min_context_window');
  store.setSchemaVersion(24);
  store.close();

  store = new Store(directory);
  assert.equal(store.schemaVersion(), SCHEMA_VERSION);
  const columns = store.all('PRAGMA table_info(messages)').map(column => column.name);
  assert.ok(columns.includes('min_context_window'), 'messages 缺少 min_context_window');
  const row = store.get('SELECT text,required_capabilities,min_context_window FROM messages WHERE id=?', 'm1');
  assert.equal(row.text, '历史派工');
  assert.deepEqual(JSON.parse(row.required_capabilities), ['exec.read']);
  // 旧消息没有门槛值,升级后保持无约束。
  assert.equal(row.min_context_window, null);
  store.run('UPDATE messages SET min_context_window=32000 WHERE id=?', 'm1');
  assert.equal(store.get('SELECT min_context_window FROM messages WHERE id=?', 'm1').min_context_window, 32000);
  store.close();
});


test('a v25 database gains member policy columns and the member_policy interaction kind', t => {
  const directory = tempDir(t);
  const freshDirectory = tempDir(t);
  let store = new Store(directory);
  store.run("INSERT INTO groups(id,name,workspace,created) VALUES('g1','G',?,?)", directory, NOW);
  store.run("INSERT INTO members(id,group_id,name,host,role) VALUES('m1','g1','worker','fake','member')");
  store.run(`INSERT INTO messages(id,group_id,sender,recipient,kind,text,created) VALUES('msg1','g1','lead','m1','send','历史派工',?)`, NOW);
  store.run(`INSERT INTO interactions(id,group_id,context,turn_id,call_id,kind,payload,created) VALUES('i1','g1','pair:lead','t1','c1','member_model','{}',?)`, NOW);
  // 回退为 v25 形状：members 去掉三列，interactions 重建为不含 member_policy 的 CHECK。
  store.db.exec(`ALTER TABLE members DROP COLUMN policy_ceiling;
    ALTER TABLE members DROP COLUMN allow_shell;
    ALTER TABLE members DROP COLUMN allow_browser;`);
  store.db.exec(`ALTER TABLE interactions RENAME TO interactions_v25;
    CREATE TABLE interactions(id TEXT PRIMARY KEY,group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,member_id TEXT REFERENCES members(id) ON DELETE CASCADE,panel_agent_id TEXT REFERENCES panel_agents(id) ON DELETE CASCADE,conversation_id TEXT,context TEXT NOT NULL,turn_id TEXT NOT NULL,call_id TEXT NOT NULL,message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,panel_message_id TEXT,kind TEXT NOT NULL CHECK(kind IN ('choice','input','flow','takeover','handback','group_create','group_add','group_delete','member_model')),payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','answered','cancelled','failed')),answer TEXT,detail TEXT,answer_message_id TEXT,created TEXT NOT NULL,answered TEXT);
    INSERT INTO interactions SELECT * FROM interactions_v25;
    DROP TABLE interactions_v25;
    CREATE INDEX IF NOT EXISTS interactions_group ON interactions(group_id,created);
    CREATE INDEX IF NOT EXISTS interactions_panel ON interactions(panel_agent_id,created);`);
  assert.ok(!store.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='interactions'").sql.includes('member_policy'));
  store.setSchemaVersion(25);
  store.close();

  store = new Store(directory);
  try {
    assert.equal(SCHEMA_VERSION, 26);
    assert.equal(store.schemaVersion(), SCHEMA_VERSION);
    // 旧成员自动继承群策略(NULL)，浏览器默认关闭。
    const member = store.get("SELECT * FROM members WHERE id='m1'");
    assert.equal(member.name, 'worker');
    assert.equal(member.policy_ceiling, null);
    assert.equal(member.allow_shell, null);
    assert.equal(member.allow_browser, 0);
    assert.equal(store.get("SELECT text FROM messages WHERE id='msg1'").text, '历史派工');
    assert.equal(store.get("SELECT kind FROM interactions WHERE id='i1'").kind, 'member_model');
    // interactions 重建后列名与新库一致，并接受 member_policy。
    const interactionColumns = store.all('PRAGMA table_info(interactions)').map(column => column.name);
    assert.ok(interactionColumns.includes('conversation_id'));
    assert.ok(!interactionColumns.includes('endpoint_id'));
    const interactionsSql = store.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='interactions'").sql;
    assert.ok(interactionsSql.includes("'member_policy'"));
    store.run(`INSERT INTO interactions(id,group_id,context,turn_id,call_id,kind,payload,created) VALUES('i2','g1','coordination','t2','c2','member_policy','{}',?)`, NOW);
    assert.equal(store.get("SELECT kind FROM interactions WHERE id='i2'").kind, 'member_policy');

    // 新库与迁移库的 members/interactions 列形状完全一致。
    const fresh = new Store(freshDirectory);
    try {
      const shape = (database, table) => database.all(`PRAGMA table_info(${table})`)
        .map(column => [column.name, column.type, column.notnull, column.dflt_value, column.pk]);
      assert.deepEqual(shape(store, 'members'), shape(fresh, 'members'));
      assert.deepEqual(shape(store, 'interactions'), shape(fresh, 'interactions'));
      const normalize = sql => sql.replace(/\s+/g, ' ').trim();
      for (const table of ['members', 'interactions']) {
        assert.equal(
          normalize(store.get("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", table).sql),
          normalize(fresh.get("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", table).sql),
          table + ' 的迁移 DDL 与新库直建不一致',
        );
      }
    } finally {
      fresh.close();
    }

    // 聚合写点：插入时可带策略字段，运行期可整体更新（NULL 表示继承）。
    teams.insertMember(store, {
      id: 'm2', groupId: 'g1', name: '审查', host: 'fake', role: 'member',
      policyCeiling: 'read-only', allowShell: false, allowBrowser: true,
    });
    let created = store.get("SELECT * FROM members WHERE id='m2'");
    assert.equal(created.policy_ceiling, 'read-only');
    assert.equal(created.allow_shell, 0);
    assert.equal(created.allow_browser, 1);
    teams.updateMemberPolicy(store, { memberId: 'm2', policyCeiling: null, allowShell: null, allowBrowser: false });
    created = store.get("SELECT * FROM members WHERE id='m2'");
    assert.equal(created.policy_ceiling, null);
    assert.equal(created.allow_shell, null);
    assert.equal(created.allow_browser, 0);
  } finally {
    store.close();
  }
});

test('a database created by a newer schema is rejected instead of being opened', t => {
  const directory = tempDir(t);
  const store = new Store(directory);
  store.setSchemaVersion(SCHEMA_VERSION + 1);
  store.close();

  assert.throws(() => new Store(directory), /更新版本/);
});

test('store keeps WAL durability at NORMAL so per-event commits do not fsync', t => {
  const directory = tempDir(t);
  const store = new Store(directory);
  try {
    assert.equal(store.get('PRAGMA journal_mode').journal_mode, 'wal');
    // SQLite 的 synchronous 取值:0=OFF, 1=NORMAL, 2=FULL, 3=EXTRA
    assert.equal(store.get('PRAGMA synchronous').synchronous, 1);
  } finally {
    store.close();
  }
});

test('a v5 database gains the notes table and indexes on reopen', t => {
  const directory = tempDir(t);
  let store = new Store(directory);
  store.run('DROP TABLE notes');
  store.setSchemaVersion(5);
  store.close();

  store = new Store(directory);
  assert.equal(store.schemaVersion(), SCHEMA_VERSION);
  assert.ok(store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='notes'"));
  const indexes = store.all("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='notes'").map(row => row.name);
  assert.ok(indexes.includes('notes_state'));
  assert.ok(indexes.includes('notes_archived'));
  store.close();
});

test('notes reject unknown states and tolerate an empty table', t => {
  const directory = tempDir(t);
  const store = new Store(directory);
  assert.deepEqual(store.all('SELECT * FROM notes'), []);
  store.run(
    "INSERT INTO notes(id,title,body,state,created,updated) VALUES('a','t','b','active',?,?)",
    NOW,
    NOW,
  );
  assert.throws(() => store.run(
    "INSERT INTO notes(id,title,body,state,created,updated) VALUES('b','t','b','doing',?,?)",
    NOW,
    NOW,
  ), /CHECK/);
  store.close();
});

test('a v7 database gains the optional source team without touching existing notes', t => {
  const directory = tempDir(t);
  let store = new Store(directory);
  store.run("INSERT INTO notes(id,title,body,state,created,updated) VALUES('a','t','b','active',?,?)", NOW, NOW);
  store.run('DROP INDEX IF EXISTS notes_source_team');
  store.run('ALTER TABLE notes DROP COLUMN source_team_id');
  store.setSchemaVersion(7);
  store.close();

  store = new Store(directory);
  assert.equal(store.schemaVersion(), SCHEMA_VERSION);
  assert.ok(store.all('PRAGMA table_info(notes)').some(column => column.name === 'source_team_id'));
  assert.ok(store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='notes'") && store.get("SELECT 1 FROM sqlite_master WHERE type='index' AND name='notes_source_team'"));
  assert.equal(store.get("SELECT source_team_id FROM notes WHERE id='a'").source_team_id, null, '历史笔记一律无来源');
  store.close();
});

test('notes keep no foreign key to groups so deleting a team cannot cascade into private notes', t => {
  const directory = tempDir(t);
  const store = new Store(directory);
  const column = store.all('PRAGMA table_info(notes)').find(item => item.name === 'source_team_id');
  assert.ok(column, 'source_team_id 必须存在');
  assert.equal(column.notnull, 0, '无来源是合法状态');
  assert.deepEqual(store.all('PRAGMA foreign_key_list(notes)'), [], '来源是裸 id，刻意不加外键');
  store.close();
});

test('a v9 database gains tag columns, the tag registry and the pinned index on reopen', t => {
  const directory = tempDir(t);
  let store = new Store(directory);
  store.run("INSERT INTO notes(id,title,body,state,created,updated) VALUES('a','t','b','active',?,?)", NOW, NOW);
  store.setSchemaVersion(9);
  store.close();

  store = new Store(directory);
  assert.equal(store.schemaVersion(), SCHEMA_VERSION);
  const columns = store.all('PRAGMA table_info(notes)').map(column => column.name);
  assert.ok(columns.includes('tags'), 'tags JSON 列必须存在');
  assert.ok(columns.includes('pinned_at'), 'pinned_at 列必须存在');
  const restored = store.get("SELECT tags,pinned_at FROM notes WHERE id='a'");
  assert.equal(restored.tags, '[]', '历史笔记默认无标签');
  assert.equal(restored.pinned_at, null, '历史笔记默认未置顶');
  assert.ok(store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='note_tags'"));
  const tagIndexes = store.all("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='notes'").map(row => row.name);
  assert.ok(tagIndexes.includes('notes_pinned'));
  store.run("INSERT INTO note_tags(id,name,color,created) VALUES('t1','重要','#22c55e',?)", NOW);
  assert.throws(() => store.run("INSERT INTO note_tags(id,name,color,created) VALUES('t2','重要',NULL,?)", NOW), /UNIQUE/);
  store.close();
});

test('v10 databases gain plan tables and agent_tasks.revision', t => {
  const directory = tempDir(t);
  const legacy = new Store(directory);
  legacy.db.exec(`DROP TABLE plan_events;
    DROP TABLE message_step_refs;
    ALTER TABLE agent_tasks DROP COLUMN revision;
    PRAGMA user_version=10;`);
  legacy.db.close();

  const upgraded = new Store(directory);
  assert.equal(upgraded.schemaVersion(), SCHEMA_VERSION);
  assert.ok(upgraded.all("SELECT 1 FROM sqlite_master WHERE type='table' AND name='plan_events'").length);
  assert.ok(upgraded.all("SELECT 1 FROM sqlite_master WHERE type='table' AND name='message_step_refs'").length);
  assert.ok(upgraded.all('PRAGMA table_info(agent_tasks)').some(column => column.name === 'revision'));
  upgraded.db.close();
});

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
  const binding = store.get('SELECT * FROM external_client_bindings WHERE id=?', 'b1');
  assert.equal(binding.session, 'thread-1');
  assert.deepEqual(JSON.parse(binding.declared_capabilities), ['session.deliver', 'turn.observe']);
  assert.equal(binding.surface, 'cli');
  assert.equal(store.get('SELECT text FROM messages WHERE id=?', 'msg1').text, '派工');
  assert.equal(store.get('SELECT session FROM conversations WHERE id=?', 'c1').session, 'native-1');
  assert.equal(store.get('SELECT workspace FROM groups WHERE id=?', 'g1').workspace, '/tmp/w1');
  assert.equal(store.get('SELECT workspace_revision FROM groups WHERE id=?', 'g1').workspace_revision, 0);
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

function downgradeToV22(store) {
  store.transaction(() => {
    store.db.exec(`ALTER TABLE desktop_applications RENAME TO desktop_applications_v23_tmp;
      CREATE TABLE desktop_applications(
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('codex','dsh','claude')),
        surface TEXT NOT NULL DEFAULT 'desktop' CHECK(surface IN ('cli','desktop')),
        install_path TEXT,
        engine_path TEXT,
        engine_version TEXT,
        readiness TEXT NOT NULL DEFAULT 'unavailable' CHECK(readiness IN ('available','unavailable')),
        pull_only INTEGER NOT NULL DEFAULT 0,
        controller_state TEXT,
        engine_state TEXT,
        diagnostics TEXT,
        fingerprint TEXT,
        verified_at TEXT,
        lifecycle_note TEXT,
        created TEXT NOT NULL,
        updated TEXT NOT NULL,
        user_disabled INTEGER NOT NULL DEFAULT 0,
        disabled_reason TEXT,
        bundle_version TEXT,
        UNIQUE(kind,surface,install_path));
      INSERT INTO desktop_applications SELECT * FROM desktop_applications_v23_tmp;
      DROP TABLE desktop_applications_v23_tmp;`);
  });
  store.setSchemaVersion(22);
}

test('a v22 database widens the desktop kind enum without losing rows', t => {
  const directory = tempDir(t);
  let store = new Store(directory);
  store.run(
    `INSERT INTO desktop_applications(id,kind,surface,install_path,bundle_version,readiness,pull_only,verified_at,created,updated)
     VALUES('app1','codex','desktop','/Applications/ChatGPT.app','26.1111.71704','available',1,?, ?, ?)`,
    '2026-11-20T00:00:00.000Z', NOW, NOW,
  );
  downgradeToV22(store);
  store.close();

  store = new Store(directory);
  assert.equal(store.schemaVersion(), SCHEMA_VERSION);
  const row = store.get('SELECT * FROM desktop_applications WHERE id=?', 'app1');
  assert.equal(row.kind, 'codex');
  assert.equal(row.readiness, 'available');
  assert.equal(row.pull_only, 1);
  assert.equal(row.bundle_version, '26.1111.71704');
  store.run(
    `INSERT INTO desktop_applications(id,kind,surface,install_path,created,updated)
     VALUES('app2','zcode','desktop','/Applications/ZCode.app',?,?)`,
    NOW, NOW,
  );
  assert.throws(
    () => store.run(
      `INSERT INTO desktop_applications(id,kind,surface,install_path,created,updated)
       VALUES('app3','workbuddy','desktop','/x',?,?)`,
      NOW, NOW,
    ),
    /CHECK/,
  );
  store.close();
});

test('a fresh database carries the widened kind enum directly', t => {
  const directory = tempDir(t);
  const store = new Store(directory);
  const tableSql = store.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='desktop_applications'").sql;
  assert.match(tableSql, /'zcode'/);
  assert.equal(store.schemaVersion(), SCHEMA_VERSION);
  store.close();
});
