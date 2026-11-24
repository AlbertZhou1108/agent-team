import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, SCHEMA_VERSION } from '../../store.mjs';
import * as teams from '../../aggregates/teams.mjs';
import { createLegacyV1 } from '../support/legacy-v1.mjs';
import { EventLog } from '../../event-log.mjs';

describe('schema-version', () => {
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
  // 回退为 v25 形状：同时剥离 v26 与后续版本追加列，按真实升级阶梯依次经 migrateV26 → migrateV27。
  store.db.exec(`ALTER TABLE groups DROP COLUMN workflow_template;
    ALTER TABLE members DROP COLUMN worktree_branch;
    ALTER TABLE members DROP COLUMN worktree_path;
    ALTER TABLE members DROP COLUMN workspace_mode;
    ALTER TABLE members DROP COLUMN policy_ceiling;
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
    assert.ok(SCHEMA_VERSION >= 26);
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

test('a v26 database gains workflow_template and member worktree isolation columns', t => {
  const directory = tempDir(t);
  const freshDirectory = tempDir(t);
  let store = new Store(directory);
  store.run("INSERT INTO groups(id,name,workspace,created) VALUES('g1','G',?,?)", directory, NOW);
  store.run("INSERT INTO members(id,group_id,name,host,role) VALUES('m1','g1','worker','fake','member')");
  store.db.exec(`ALTER TABLE groups DROP COLUMN workflow_template;
    ALTER TABLE members DROP COLUMN workspace_mode;
    ALTER TABLE members DROP COLUMN worktree_path;
    ALTER TABLE members DROP COLUMN worktree_branch;`);
  store.setSchemaVersion(26);
  store.close();

  store = new Store(directory);
  try {
    assert.equal(SCHEMA_VERSION, 27);
    assert.equal(store.schemaVersion(), SCHEMA_VERSION);
    const group = store.get("SELECT * FROM groups WHERE id='g1'");
    assert.equal(group.workflow_template, null);
    const member = store.get("SELECT * FROM members WHERE id='m1'");
    assert.equal(member.workspace_mode, 'inherit');
    assert.equal(member.worktree_path, null);
    assert.equal(member.worktree_branch, null);

    // 约束校验:workspace_mode 只允许 'inherit' / 'worktree'。
    assert.throws(
      () => store.run("INSERT INTO members(id,group_id,name,host,role,workspace_mode) VALUES('bad','g1','bad','fake','member','custom')"),
      /CHECK/,
    );

    const fresh = new Store(freshDirectory);
    try {
      const shape = (database, table) => database.all(`PRAGMA table_info(${table})`)
        .map(column => [column.name, column.type, column.notnull, column.dflt_value, column.pk]);
      assert.deepEqual(shape(store, 'groups'), shape(fresh, 'groups'));
      assert.deepEqual(shape(store, 'members'), shape(fresh, 'members'));
      const normalize = sql => sql.replace(/\s+/g, ' ').trim();
      for (const table of ['groups', 'members']) {
        assert.equal(
          normalize(store.get("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", table).sql),
          normalize(fresh.get("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", table).sql),
          `${table} 的迁移 DDL 与新库直建不一致`,
        );
      }
    } finally {
      fresh.close();
    }

    teams.insertGroup(store, {
      id: 'g2', name: 'G2', workspace: directory, created: NOW,
      charter: null, policy: 'workspace-write', allowShell: 1, workflowTemplate: 'standard-dev',
    });
    assert.equal(store.get("SELECT workflow_template FROM groups WHERE id='g2'").workflow_template, 'standard-dev');
    teams.insertMember(store, {
      id: 'm2', groupId: 'g2', name: 'coder', host: 'fake', role: 'member',
      workspaceMode: 'worktree', worktreePath: '/tmp/wt/m2', worktreeBranch: 'agent-team/g2-coder',
    });
    const wtMember = store.get("SELECT * FROM members WHERE id='m2'");
    assert.equal(wtMember.workspace_mode, 'worktree');
    assert.equal(wtMember.worktree_path, '/tmp/wt/m2');
    assert.equal(wtMember.worktree_branch, 'agent-team/g2-coder');
    teams.updateMemberWorkspace(store, { memberId: 'm2', workspaceMode: 'inherit', worktreePath: null, worktreeBranch: null });
    assert.equal(store.get("SELECT workspace_mode FROM members WHERE id='m2'").workspace_mode, 'inherit');
  } finally {
    store.close();
  }
});
});

describe('store-migration-v2', () => {
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
  t.after(() => { try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ } });
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
  t.after(() => { try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ } });
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
});

describe('store-retention', () => {
const DAY = 86400000;
const old = new Date(Date.now() - 40 * DAY).toISOString();
const fresh = new Date(Date.now() - 1 * DAY).toISOString();

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'store-retention-'));
  t.after(() => { try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ } });
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

test('retention keeps pending external deliveries and decision requests', t => {
  const { store, appendAt } = setup(t);
  store.run(
    "INSERT INTO external_principals(id,name,created,updated) VALUES('p','user',?,?)",
    old, old,
  );
  store.run(
    `INSERT INTO external_client_bindings(
       id,principal_id,name,host,key_hash,session,declared_capabilities,status,created,updated
     ) VALUES('b','p','main','fake','hash',NULL,'{}','active',?,?)`,
    old, old,
  );
  store.run(
    `INSERT INTO team_lead_controllers(
       group_id,controller_kind,controller_id,controller_binding_id,state,original_lead_id,revision,updated
     ) VALUES('g','external_agent','p','b','active',NULL,1,?)`,
    old,
  );
  const incoming = appendAt('m2', 'p', 'send', 'pending controller report', old);
  store.run('UPDATE messages SET awaiting=0 WHERE id=?', incoming.id);
  store.run(
    `INSERT INTO external_deliveries(
       id,principal_id,group_id,message_id,binding_id,state,payload,created
     ) VALUES('d','p','g',?,'b','pending','{}',?)`,
    incoming.id, old,
  );
  const request = appendAt('m2', 'p', 'send', 'decision request', old);
  store.run('UPDATE messages SET awaiting=0 WHERE id=?', request.id);
  store.run(
    `INSERT INTO external_decisions(
       id,group_id,requester_member_id,controller_principal_id,request_message_id,payload,state,created
     ) VALUES('dec','g','m2','p',?,'{}','pending',?)`,
    request.id, old,
  );

  store.pruneHistory({ retentionDays: 30 });
  assert.equal(store.get('SELECT count(*) AS n FROM messages WHERE id=?', incoming.id).n, 1);
  assert.equal(store.get('SELECT count(*) AS n FROM messages WHERE id=?', request.id).n, 1);
  assert.equal(store.get("SELECT state FROM external_deliveries WHERE id='d'").state, 'pending');
  assert.equal(store.get("SELECT state FROM external_decisions WHERE id='dec'").state, 'pending');
  store.close();
});
});

describe('transaction-nesting', () => {
const NOW = '2026-01-01T00:00:00.000Z';

function tempStore(t) {
  const directory = mkdtempSync(join(tmpdir(), 'store-transaction-'));
  const store = new Store(directory);
  t.after(() => {
    store.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  });
  return store;
}

function insertGroup(store, id) {
  store.run(
    'INSERT INTO groups(id,name,workspace,lead,created,charter,policy,allow_shell) VALUES(?,?,?,?,?,?,?,?)',
    id, id, '/tmp', null, NOW, null, 'workspace-write', 0,
  );
}

function insertMember(store, id, groupId) {
  store.run(
    'INSERT INTO members(id,group_id,name,host,role,profile) VALUES(?,?,?,?,?,?)',
    id, groupId, id, 'codex', 'executor', '',
  );
}

test('nested transactions commit together with the outer transaction', t => {
  const store = tempStore(t);
  insertGroup(store, 'g1');
  store.transaction(() => {
    insertMember(store, 'm1', 'g1');
    store.transaction(() => {
      insertMember(store, 'm2', 'g1');
    });
  });
  assert.equal(store.get("SELECT count(*) AS c FROM members WHERE group_id='g1'").c, 2);
});

test('an inner failure rolls back only the inner savepoint', t => {
  const store = tempStore(t);
  insertGroup(store, 'g1');
  store.transaction(() => {
    insertMember(store, 'outer', 'g1');
    assert.throws(() => {
      store.transaction(() => {
        insertMember(store, 'inner', 'g1');
        throw new Error('boom');
      });
    }, /boom/);
    insertMember(store, 'after', 'g1');
  });
  assert.ok(store.get("SELECT 1 FROM members WHERE id='outer'"));
  assert.equal(store.get("SELECT 1 FROM members WHERE id='inner'"), undefined);
  assert.ok(store.get("SELECT 1 FROM members WHERE id='after'"));
});

test('an outer rollback discards inner committed savepoints', t => {
  const store = tempStore(t);
  insertGroup(store, 'g1');
  assert.throws(() => {
    store.transaction(() => {
      store.transaction(() => insertMember(store, 'kept-until-outer-fails', 'g1'));
      throw new Error('outer');
    });
  }, /outer/);
  assert.equal(store.get("SELECT count(*) AS c FROM members WHERE id='kept-until-outer-fails'").c, 0);
});

test('three levels of nesting roll back the failed level only', t => {
  const store = tempStore(t);
  insertGroup(store, 'g1');
  store.transaction(() => {
    insertMember(store, 'a', 'g1');
    store.transaction(() => {
      insertMember(store, 'b', 'g1');
      assert.throws(() => {
        store.transaction(() => {
          insertMember(store, 'c', 'g1');
          throw new Error('level-3');
        });
      }, /level-3/);
      insertMember(store, 'd', 'g1');
    });
    insertMember(store, 'e', 'g1');
  });
  const ids = store.all('SELECT id FROM members ORDER BY id').map(row => row.id);
  assert.deepEqual(ids, ['a', 'b', 'd', 'e']);
});

test('transaction depth is restored after a failure and the next top-level transaction runs', t => {
  const store = tempStore(t);
  insertGroup(store, 'g1');
  assert.throws(() => store.transaction(() => {
    store.transaction(() => {
      throw new Error('nested');
    });
  }), /nested/);
  store.transaction(() => insertMember(store, 'ok', 'g1'));
  assert.ok(store.get("SELECT 1 FROM members WHERE id='ok'"));
});

test('EventLog flush inside a transaction joins the outer transaction', t => {
  const store = tempStore(t);
  insertGroup(store, 'g1');
  insertMember(store, 'm1', 'g1');
  const conversation = store.conversation('member', 'm1', 'coordination');
  const log = new EventLog(store, { flushMs: 60000 });
  t.after(() => log.close());

  // 事务内冲刷不再抛嵌套事务错误,且随外层回滚一起丢弃。
  assert.throws(() => {
    store.transaction(() => {
      log.member(conversation.id, { type: 'framework.text.delta', text: 'rolled back' });
      log.flush();
      throw new Error('outer rollback');
    });
  }, /outer rollback/);
  assert.equal(store.all('SELECT * FROM history').length, 0);

  // 同样的冲刷在提交事务后应落库。
  store.transaction(() => {
    log.member(conversation.id, { type: 'framework.text.delta', text: 'committed' });
    log.flush();
  });
  const rows = store.all('SELECT event FROM history');
  assert.equal(rows.length, 1);
  assert.equal(JSON.parse(rows[0].event).text, 'committed');
});
});
