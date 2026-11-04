import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_ATTACHMENT_SETTINGS, normalizeAttachmentSettings, serializeAttachmentSettings } from './attachment-settings.mjs';

// 数据目录的 schema 版本；迁移按版本逐级执行，过新版本拒绝打开。
export const SCHEMA_VERSION = 7;

function modelObservations(rows) {
  return rows.flatMap(row => {
    const event = JSON.parse(row.event);
    return event.type === 'framework.model' ? [{ seq: row.seq, created: row.created, turnId: row.turn_id, ...event }] : [];
  });
}

function latestWith(observations, field, phases) {
  for (const phase of phases) {
    const found = [...observations].reverse().find(observation => observation.phase === phase && observation[field] != null);
    if (found) return { [field]: found[field], phase: found.phase, source: found.source, seq: found.seq, ...(found.turnId ? { turnId: found.turnId } : {}) };
  }
  return null;
}

function deriveCurrentModel(observations) {
  const latest = [...observations].reverse().find(observation => observation.phase !== 'usage' && (observation.model != null || observation.reasoningEffort != null));
  const current = latest?.turnId ? observations.filter(observation => observation.turnId === latest.turnId) : observations;
  return {
    currentModel: latestWith(current, 'model', ['assistant', 'verified', 'session', 'requested']),
    currentReasoningEffort: latestWith(current, 'reasoningEffort', ['verified', 'session', 'requested']),
  };
}

export class Store {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.directory = resolve(directory);
    this.db = new DatabaseSync(resolve(directory, 'groups.sqlite'));
    chmodSync(resolve(directory, 'groups.sqlite'), 0o600);
    // 版本必须在建表前读取:新库与 v0 旧库都返回 0，用 groups 表是否存在区分。
    const existingVersion = this.schemaVersion();
    if (existingVersion > SCHEMA_VERSION) {
      this.db.close();
      throw new Error(`数据目录由更新版本的 Agent Team 创建（schema ${existingVersion}），当前版本只支持到 ${SCHEMA_VERSION}`);
    }
    this.isFreshDatabase = !this.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='groups'");
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
    if (existingVersion < 2) this.upgradeFromV1();
    this.migrateSchema(existingVersion);
    this.ensureV2Schema();
    if (this.schemaVersion() !== SCHEMA_VERSION) this.setSchemaVersion(SCHEMA_VERSION);
  }

  // v0/v1 数据目录先补齐到 v1 形状，再交给 v1->v2 迁移。仅在 user_version < SCHEMA_VERSION 时执行。
  upgradeFromV1() {
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
      CREATE TABLE IF NOT EXISTS groups(id TEXT PRIMARY KEY,name TEXT NOT NULL,workspace TEXT NOT NULL,lead TEXT,created TEXT NOT NULL,charter TEXT,policy TEXT NOT NULL DEFAULT 'workspace-write',allow_shell INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS team_creation_requests(operation_id TEXT PRIMARY KEY,payload TEXT NOT NULL,group_id TEXT REFERENCES groups(id) ON DELETE SET NULL);
      CREATE TABLE IF NOT EXISTS members(id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,name TEXT NOT NULL,host TEXT NOT NULL,role TEXT NOT NULL,profile TEXT NOT NULL DEFAULT '',removed TEXT,UNIQUE(group_id,name));
      CREATE TABLE IF NOT EXISTS endpoints(id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,context TEXT NOT NULL,peer TEXT,session TEXT,key TEXT NOT NULL,UNIQUE(member_id,context));
      CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,sender TEXT NOT NULL,recipient TEXT NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL,reply_to TEXT,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,endpoint_id TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,payload TEXT NOT NULL,accepted TEXT,error TEXT);
      CREATE TABLE IF NOT EXISTS attached(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,outbox_id TEXT NOT NULL REFERENCES outbox(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS history(seq INTEGER PRIMARY KEY AUTOINCREMENT,endpoint_id TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,event TEXT NOT NULL,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS panel_agents(id TEXT PRIMARY KEY,singleton INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK(singleton=1),name TEXT NOT NULL,host TEXT NOT NULL,model_provider TEXT,model TEXT,reasoning_effort TEXT,workspace TEXT,access TEXT NOT NULL DEFAULT 'read-only' CHECK(access IN ('read-only','workspace-write','full-access')),created TEXT NOT NULL,updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS panel_sessions(id TEXT PRIMARY KEY,panel_agent_id TEXT NOT NULL REFERENCES panel_agents(id) ON DELETE CASCADE,context TEXT NOT NULL CHECK(context IN ('private','coordination')),group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,session TEXT,policy_signature TEXT,key TEXT NOT NULL UNIQUE,created TEXT NOT NULL,updated TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS panel_private_session ON panel_sessions(panel_agent_id) WHERE context='private';
      CREATE UNIQUE INDEX IF NOT EXISTS panel_coordination_session ON panel_sessions(panel_agent_id,group_id) WHERE context='coordination';
      CREATE TABLE IF NOT EXISTS panel_team_bindings(panel_agent_id TEXT NOT NULL REFERENCES panel_agents(id) ON DELETE CASCADE,group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,relation TEXT NOT NULL CHECK(relation IN ('observer','main')),created TEXT NOT NULL,updated TEXT NOT NULL,PRIMARY KEY(panel_agent_id,group_id));
      CREATE TABLE IF NOT EXISTS team_lead_controllers(group_id TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,controller_kind TEXT NOT NULL CHECK(controller_kind IN ('member','panel_agent')),controller_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('active','suspended')),original_lead_id TEXT,revision INTEGER NOT NULL DEFAULT 1,updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS panel_messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,panel_agent_id TEXT NOT NULL REFERENCES panel_agents(id) ON DELETE CASCADE,context TEXT NOT NULL CHECK(context IN ('private','coordination')),role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),text TEXT NOT NULL,active_team_id TEXT,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS panel_updates(id TEXT PRIMARY KEY,panel_agent_id TEXT NOT NULL REFERENCES panel_agents(id) ON DELETE CASCADE,group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,source_turn_id TEXT REFERENCES panel_turns(id) ON DELETE SET NULL,kind TEXT NOT NULL DEFAULT 'update' CHECK(kind IN ('update','continuation')),text TEXT NOT NULL,source_message_ids TEXT NOT NULL DEFAULT '[]',created TEXT NOT NULL,delivered_turn_id TEXT,delivered TEXT);
      CREATE TABLE IF NOT EXISTS panel_turns(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES panel_sessions(id) ON DELETE CASCADE,panel_agent_id TEXT NOT NULL REFERENCES panel_agents(id) ON DELETE CASCADE,context TEXT NOT NULL,group_id TEXT,active_team_id TEXT,state TEXT NOT NULL,created TEXT NOT NULL,ended TEXT);
      CREATE TABLE IF NOT EXISTS panel_history(seq INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL REFERENCES panel_sessions(id) ON DELETE CASCADE,turn_id TEXT,event TEXT NOT NULL,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS panel_outbox(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES panel_sessions(id) ON DELETE CASCADE,payload TEXT NOT NULL,accepted TEXT,error TEXT);
      CREATE TABLE IF NOT EXISTS panel_attached(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,outbox_id TEXT NOT NULL REFERENCES panel_outbox(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS panel_turn_inputs(turn_id TEXT NOT NULL REFERENCES panel_turns(id) ON DELETE CASCADE,message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,PRIMARY KEY(turn_id,message_id));
      CREATE TABLE IF NOT EXISTS panel_message_origins(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,turn_id TEXT NOT NULL REFERENCES panel_turns(id) ON DELETE CASCADE,event_seq INTEGER REFERENCES panel_history(seq) ON DELETE SET NULL,call_id TEXT NOT NULL,native_call_id TEXT);
      CREATE TABLE IF NOT EXISTS interactions(id TEXT PRIMARY KEY,group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,member_id TEXT REFERENCES members(id) ON DELETE CASCADE,panel_agent_id TEXT REFERENCES panel_agents(id) ON DELETE CASCADE,endpoint_id TEXT,context TEXT NOT NULL,turn_id TEXT NOT NULL,call_id TEXT NOT NULL,message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,panel_message_id TEXT,kind TEXT NOT NULL CHECK(kind IN ('choice','input','takeover','handback','group_create','group_add','group_delete','member_model')),payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','answered','cancelled','failed')),answer TEXT,detail TEXT,answer_message_id TEXT,created TEXT NOT NULL,answered TEXT);
      CREATE TABLE IF NOT EXISTS agent_tasks(owner_id TEXT NOT NULL,group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,tasks TEXT NOT NULL,updated TEXT NOT NULL,PRIMARY KEY(owner_id,group_id));
      CREATE TABLE IF NOT EXISTS model_policy_presets(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,mode TEXT NOT NULL,rules TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS theme_packs(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,light TEXT NOT NULL,dark TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attachment_settings(singleton INTEGER PRIMARY KEY CHECK(singleton=1),max_file_bytes INTEGER NOT NULL,max_files INTEGER NOT NULL,max_image_pixels INTEGER NOT NULL,updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY,panel_agent_id TEXT NOT NULL REFERENCES panel_agents(id) ON DELETE CASCADE,original_name TEXT NOT NULL,media_type TEXT NOT NULL CHECK(media_type IN ('text/plain','image/png','image/jpeg')),size INTEGER NOT NULL,storage_name TEXT NOT NULL,created_at TEXT NOT NULL,panel_message_id TEXT REFERENCES panel_messages(id) ON DELETE CASCADE,ordinal INTEGER);
      CREATE TABLE IF NOT EXISTS panel_message_requests(panel_agent_id TEXT NOT NULL REFERENCES panel_agents(id) ON DELETE CASCADE,client_message_id TEXT NOT NULL,payload_hash TEXT NOT NULL,panel_message_id TEXT NOT NULL REFERENCES panel_messages(id) ON DELETE CASCADE,created_at TEXT NOT NULL,PRIMARY KEY(panel_agent_id,client_message_id));
      CREATE INDEX IF NOT EXISTS interactions_group ON interactions(group_id,created);
      CREATE INDEX IF NOT EXISTS agent_tasks_group ON agent_tasks(group_id);
      CREATE INDEX IF NOT EXISTS messages_inbox ON messages(recipient,seq);
      CREATE INDEX IF NOT EXISTS messages_group ON messages(group_id,seq);
      CREATE INDEX IF NOT EXISTS history_endpoint ON history(endpoint_id,seq);
      CREATE INDEX IF NOT EXISTS panel_messages_agent ON panel_messages(panel_agent_id,seq);
      CREATE INDEX IF NOT EXISTS panel_updates_pending ON panel_updates(panel_agent_id,group_id,delivered_turn_id,created);
      CREATE INDEX IF NOT EXISTS panel_history_session ON panel_history(session_id,seq);
      CREATE INDEX IF NOT EXISTS panel_history_turn ON panel_history(turn_id,seq);
      CREATE INDEX IF NOT EXISTS attachments_message ON attachments(panel_message_id);
      CREATE INDEX IF NOT EXISTS attachments_agent ON attachments(panel_agent_id);`);
    // 这些表由其它模块在 Bus 构造时创建；Store 迁移发生在那之前，先补 v1 形状以保证迁移 SQL 可读。
    this.db.exec(`CREATE TABLE IF NOT EXISTS runtime_attempts(turn_id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,endpoint_id TEXT NOT NULL,state TEXT NOT NULL,policy TEXT NOT NULL,detail TEXT,created TEXT NOT NULL,ended TEXT);
      CREATE INDEX IF NOT EXISTS runtime_group ON runtime_attempts(group_id,state);
      CREATE TABLE IF NOT EXISTS endpoint_policy(endpoint_id TEXT PRIMARY KEY REFERENCES endpoints(id) ON DELETE CASCADE,signature TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS endpoint_session_bindings(endpoint_id TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,session_key TEXT NOT NULL,session TEXT NOT NULL,updated TEXT NOT NULL,PRIMARY KEY(endpoint_id,session_key));
      CREATE TABLE IF NOT EXISTS endpoint_session_policies(endpoint_id TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,session_key TEXT NOT NULL,signature TEXT NOT NULL,PRIMARY KEY(endpoint_id,session_key));
      CREATE TABLE IF NOT EXISTS endpoint_context_formats(endpoint_id TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,session_key TEXT NOT NULL,schema_version INTEGER NOT NULL,source TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL,PRIMARY KEY(endpoint_id,session_key));
      CREATE TABLE IF NOT EXISTS panel_session_context_formats(session_id TEXT PRIMARY KEY REFERENCES panel_sessions(id) ON DELETE CASCADE,schema_version INTEGER NOT NULL,source TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL);`);
    for (const [name, definition] of [
      ['model_provider', 'TEXT'],
      ['model', 'TEXT'],
      ['reasoning_effort', 'TEXT'],
    ]) {
      if (!this.all('PRAGMA table_info(members)').some(column => column.name === name)) {
        this.db.exec(`ALTER TABLE members ADD COLUMN ${name} ${definition}`);
      }
    }
    this.transaction(() => {
      this.db.exec(`CREATE TABLE IF NOT EXISTS turns(id TEXT PRIMARY KEY,endpoint_id TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,session TEXT,created TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS turn_inputs(turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,PRIMARY KEY(turn_id,message_id));
        CREATE TABLE IF NOT EXISTS native_turn_refs(turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,ref TEXT NOT NULL,PRIMARY KEY(turn_id,ref));
        CREATE TABLE IF NOT EXISTS message_origins(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,event_seq INTEGER REFERENCES history(seq) ON DELETE SET NULL,call_id TEXT NOT NULL,native_call_id TEXT);`);
      if (!this.all('PRAGMA table_info(history)').some(column => column.name === 'turn_id')) this.db.exec('ALTER TABLE history ADD COLUMN turn_id TEXT REFERENCES turns(id) ON DELETE CASCADE');
      this.db.exec('CREATE INDEX IF NOT EXISTS history_turn ON history(turn_id,seq); CREATE INDEX IF NOT EXISTS inputs_message ON turn_inputs(message_id);');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS telemetry_observations(
          id TEXT PRIMARY KEY,
          group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
          executor_kind TEXT NOT NULL,
          executor_id TEXT NOT NULL,
          endpoint_id TEXT NOT NULL,
          session_key TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          turn_kind TEXT NOT NULL,
          host TEXT NOT NULL,
          host_session_namespace TEXT NOT NULL,
          host_session_id TEXT,
          instance_id TEXT NOT NULL,
          instance_generation INTEGER NOT NULL DEFAULT 0,
          native_turn_id TEXT NOT NULL DEFAULT '',
          step_id TEXT NOT NULL DEFAULT '',
          request_id TEXT NOT NULL DEFAULT '',
          attempt_id TEXT NOT NULL DEFAULT '',
          source TEXT NOT NULL,
          scope TEXT NOT NULL,
          aggregation TEXT NOT NULL,
          observed_at TEXT NOT NULL,
          payload TEXT NOT NULL,
          created TEXT NOT NULL,
          updated TEXT NOT NULL,
          UNIQUE(executor_kind,executor_id,endpoint_id,session_key,turn_id,instance_id,source,scope,aggregation,native_turn_id,step_id,request_id,attempt_id)
        );
        CREATE INDEX IF NOT EXISTS telemetry_observations_group ON telemetry_observations(group_id,observed_at);
        CREATE TABLE IF NOT EXISTS telemetry_session_generations(
          endpoint_id TEXT NOT NULL,
          session_key TEXT NOT NULL,
          generation INTEGER NOT NULL DEFAULT 0,
          updated TEXT NOT NULL,
          PRIMARY KEY(endpoint_id,session_key)
        );
      `);
    });
    const ensureColumn = (table, name, definition) => {
      if (!this.all(`PRAGMA table_info(${table})`).some(column => column.name === name)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
        return true;
      }
      return false;
    };
    ensureColumn('panel_sessions', 'policy_signature', 'TEXT');
    ensureColumn('panel_turns', 'source_user_message_id', 'TEXT');
    ensureColumn('panel_messages', 'context', "TEXT NOT NULL DEFAULT 'private'");
    ensureColumn('panel_updates', 'kind', "TEXT NOT NULL DEFAULT 'update'");
    ensureColumn('groups', 'charter', 'TEXT');
    ensureColumn('groups', 'policy', "TEXT NOT NULL DEFAULT 'workspace-write'");
    ensureColumn('groups', 'allow_shell', 'INTEGER NOT NULL DEFAULT 1');
    ensureColumn('groups', 'state', 'TEXT');
    ensureColumn('panel_agents', 'workspace', 'TEXT');
    const panelAccessAdded = ensureColumn('panel_agents', 'access', "TEXT NOT NULL DEFAULT 'read-only'");
    if (panelAccessAdded) {
      // 旧 Panel Agent 迁移为只读访问级别；私人宿主会话按新策略重建，聊天记录保留。
      this.db.prepare("UPDATE panel_sessions SET session=NULL,policy_signature=NULL,updated=? WHERE context='private'")
        .run(new Date().toISOString());
    }
    this.migrate();
  }


  schemaVersion() {
    return Number(this.db.prepare('PRAGMA user_version').get().user_version ?? 0);
  }

  setSchemaVersion(version) {
    if (!Number.isInteger(version) || version < 0) throw new Error('无效的 schema 版本');
    this.db.exec(`PRAGMA user_version = ${version}`);
  }

  // 版本迁移钩子:按 user_version 逐级执行。v1 -> v2 的会话/回合/投递合并
  // 在单个事务内完成，失败回滚；迁移后由 foreign_key_check 兜底。
  migrateSchema(fromVersion) {
    if (fromVersion >= SCHEMA_VERSION) return;
    if (fromVersion < 2) this.migrateV2();
    if (fromVersion < 3) this.migrateV3();
    if (fromVersion < 4) this.migrateV4();
    if (fromVersion < 5) this.migrateV5();
    if (fromVersion < 6) this.migrateV6();
    if (fromVersion < 7) this.migrateV7();
  }

  // v3:把"待投递"从推导事实变成 messages.awaiting 存储事实，并给 outbox 建待投递部分索引。
  // 只有 kind='send' 且接收者不是 user 的消息置 1；进入 outbox/attached 后清零。
  migrateV3() {
    const hasAwaiting = this.all('PRAGMA table_info(messages)').some(column => column.name === 'awaiting');
    this.transaction(() => {
      if (!hasAwaiting) this.db.exec('ALTER TABLE messages ADD COLUMN awaiting INTEGER NOT NULL DEFAULT 0');
      this.db.exec(`UPDATE messages SET awaiting = CASE WHEN kind='send' AND recipient!='user'
          AND NOT EXISTS(SELECT 1 FROM attached a WHERE a.message_id=messages.id) THEN 1 ELSE 0 END;
        CREATE INDEX IF NOT EXISTS messages_awaiting ON messages(seq) WHERE awaiting=1;
        CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(accepted) WHERE accepted IS NULL;`);
    });
  }

  // v4:Agent 间请求-答复协议与工作台清理状态。
  // expects_reply 只标记"发信人期待答复"的正式消息;答复用既有 reply_to 指回请求。
  migrateV4() {
    const hasExpectsReply = this.all('PRAGMA table_info(messages)').some(column => column.name === 'expects_reply');
    this.transaction(() => {
      if (!hasExpectsReply) this.db.exec('ALTER TABLE messages ADD COLUMN expects_reply INTEGER NOT NULL DEFAULT 0');
      this.db.exec(`CREATE INDEX IF NOT EXISTS messages_expects_reply ON messages(seq) WHERE expects_reply=1;
        CREATE INDEX IF NOT EXISTS messages_reply_to ON messages(reply_to) WHERE reply_to IS NOT NULL;
        CREATE TABLE IF NOT EXISTS workbench_dismissals(category TEXT NOT NULL,item_id TEXT NOT NULL,created TEXT NOT NULL,PRIMARY KEY(category,item_id));`);
    });
  }

  // v5:每个归档团队一份独立事实快照，摘要按需生成。
  migrateV5() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS archive_snapshots(
      group_id TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
      id TEXT NOT NULL UNIQUE,created TEXT NOT NULL,facts TEXT NOT NULL,
      summary TEXT,summary_created TEXT,error TEXT);`);
  }

  // v6:随心记。笔记不挂团队、不记录执行状态；Panel Agent 交互只通过一段提示词。
  migrateV6() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS notes(
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      title_manual INTEGER NOT NULL DEFAULT 0,
      body TEXT NOT NULL,
      todos TEXT NOT NULL DEFAULT '[]',
      due TEXT,
      state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','done','archived')),
      archived_from TEXT CHECK(archived_from IN ('active','done')),
      revision INTEGER NOT NULL DEFAULT 1,
      created TEXT NOT NULL,
      updated TEXT NOT NULL,
      completed TEXT,
      archived TEXT);
      CREATE INDEX IF NOT EXISTS notes_state ON notes(state, updated DESC);
      CREATE INDEX IF NOT EXISTS notes_archived ON notes(archived DESC) WHERE state='archived';`);
  }

  // v7:会话域三表(bindings/policies/context_formats)合一为 conversation_session_meta
  // (panel 会话只写 policy/format 不写 binding,读 binding 时须过滤 session IS NOT NULL);
  // 三张幂等去重表(team_creation_requests/team_directive_requests/panel_message_requests)
  // 合一为 operation_records(scope+scope_id+client_key 定位,payload 比对内容,ref 指回业务行)。
  // 只迁移存在旧表的库;新库由 ensureV2Schema 直接建新形状。
  migrateV7() {
    const hasTable = name => Boolean(this.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name));
    const now = new Date().toISOString();
    this.transaction(() => {
      // 目标表必须在迁移内自建:v6 库走到这里时 ensureV2Schema 还没执行。
      this.db.exec(`CREATE TABLE IF NOT EXISTS conversation_session_meta(conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,session_key TEXT NOT NULL,session TEXT,session_updated TEXT,policy_signature TEXT,schema_version INTEGER,format_source TEXT,format_created TEXT,format_updated TEXT,PRIMARY KEY(conversation_id,session_key));
        CREATE TABLE IF NOT EXISTS operation_records(scope TEXT NOT NULL,scope_id TEXT NOT NULL DEFAULT '',client_key TEXT NOT NULL,payload TEXT,ref TEXT,created TEXT NOT NULL,PRIMARY KEY(scope,scope_id,client_key));
        CREATE INDEX IF NOT EXISTS operation_records_ref ON operation_records(scope,ref);`);
      if (hasTable('conversation_session_bindings')) {
        this.db.exec(`INSERT INTO conversation_session_meta(conversation_id,session_key,session,session_updated)
            SELECT conversation_id,session_key,session,updated FROM conversation_session_bindings;`);
      }
      if (hasTable('conversation_session_policies')) {
        this.db.exec(`INSERT INTO conversation_session_meta(conversation_id,session_key,policy_signature)
            SELECT conversation_id,session_key,signature FROM conversation_session_policies WHERE true
            ON CONFLICT(conversation_id,session_key) DO UPDATE SET policy_signature=excluded.policy_signature;`);
      }
      if (hasTable('conversation_context_formats')) {
        this.db.exec(`INSERT INTO conversation_session_meta(conversation_id,session_key,schema_version,format_source,format_created,format_updated)
            SELECT conversation_id,session_key,schema_version,source,created,updated FROM conversation_context_formats WHERE true
            ON CONFLICT(conversation_id,session_key) DO UPDATE SET schema_version=excluded.schema_version,format_source=excluded.format_source,format_created=excluded.format_created,format_updated=excluded.format_updated;`);
      }
      this.db.exec(`DROP TABLE IF EXISTS conversation_session_bindings;
        DROP TABLE IF EXISTS conversation_session_policies;
        DROP TABLE IF EXISTS conversation_context_formats;`);
      if (hasTable('team_creation_requests')) {
        this.db.exec(`INSERT INTO operation_records(scope,scope_id,client_key,payload,ref,created)
          SELECT 'group-create','',operation_id,payload,COALESCE(group_id,''),'${now}' FROM team_creation_requests;`);
      }
      if (hasTable('team_directive_requests')) {
        this.db.exec(`INSERT INTO operation_records(scope,scope_id,client_key,payload,ref,created)
          SELECT 'team-directive',group_id,operation_id,NULL,message_id,'${now}' FROM team_directive_requests;`);
      }
      if (hasTable('panel_message_requests')) {
        this.db.exec(`INSERT INTO operation_records(scope,scope_id,client_key,payload,ref,created)
          SELECT 'panel-private-message',panel_agent_id,client_message_id,payload_hash,panel_message_id,created_at FROM panel_message_requests;`);
      }
      this.db.exec(`DROP TABLE IF EXISTS team_creation_requests;
        DROP TABLE IF EXISTS team_directive_requests;
        DROP TABLE IF EXISTS panel_message_requests;`);
    });
  }

  // v2 目标 schema。新库/已迁移库都可重复执行；迁移过程中先改名旧表再调用它建新表。
  ensureV2Schema() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,member_id TEXT REFERENCES members(id) ON DELETE CASCADE,panel_agent_id TEXT REFERENCES panel_agents(id) ON DELETE CASCADE,context TEXT NOT NULL,peer TEXT,session TEXT,policy_signature TEXT,key TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL,CHECK((member_id IS NULL)!=(panel_agent_id IS NULL)));
      CREATE UNIQUE INDEX IF NOT EXISTS conversations_member ON conversations(member_id,context) WHERE member_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS conversations_panel_private ON conversations(panel_agent_id) WHERE panel_agent_id IS NOT NULL AND context='private';
      CREATE UNIQUE INDEX IF NOT EXISTS conversations_panel_coordination ON conversations(panel_agent_id,group_id) WHERE panel_agent_id IS NOT NULL AND context='coordination';
      CREATE INDEX IF NOT EXISTS conversations_group ON conversations(group_id);
      CREATE TABLE IF NOT EXISTS turns(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,executor_kind TEXT NOT NULL,executor_id TEXT NOT NULL,group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,session TEXT,active_team_id TEXT,source_user_message_id TEXT,state TEXT NOT NULL,detail TEXT,created TEXT NOT NULL,ended TEXT);
      CREATE INDEX IF NOT EXISTS turns_group_state ON turns(group_id,state);
      CREATE INDEX IF NOT EXISTS turns_conversation ON turns(conversation_id,created);
      CREATE INDEX IF NOT EXISTS turns_state ON turns(state);
      CREATE TABLE IF NOT EXISTS turn_inputs(turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,PRIMARY KEY(turn_id,message_id));
      CREATE INDEX IF NOT EXISTS inputs_message ON turn_inputs(message_id);
      CREATE TABLE IF NOT EXISTS native_turn_refs(turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,ref TEXT NOT NULL,PRIMARY KEY(turn_id,ref));
      CREATE TABLE IF NOT EXISTS history(seq INTEGER PRIMARY KEY AUTOINCREMENT,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,event TEXT NOT NULL,created TEXT NOT NULL,turn_id TEXT);
      CREATE INDEX IF NOT EXISTS history_conversation ON history(conversation_id,seq);
      CREATE INDEX IF NOT EXISTS history_turn ON history(turn_id,seq);
      CREATE TABLE IF NOT EXISTS message_origins(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,event_seq INTEGER REFERENCES history(seq) ON DELETE SET NULL,call_id TEXT NOT NULL,native_call_id TEXT);
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,payload TEXT NOT NULL,accepted TEXT,error TEXT);
      CREATE TABLE IF NOT EXISTS attached(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,outbox_id TEXT NOT NULL REFERENCES outbox(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS conversation_session_meta(conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,session_key TEXT NOT NULL,session TEXT,session_updated TEXT,policy_signature TEXT,schema_version INTEGER,format_source TEXT,format_created TEXT,format_updated TEXT,PRIMARY KEY(conversation_id,session_key));
      CREATE TABLE IF NOT EXISTS operation_records(scope TEXT NOT NULL,scope_id TEXT NOT NULL DEFAULT '',client_key TEXT NOT NULL,payload TEXT,ref TEXT,created TEXT NOT NULL,PRIMARY KEY(scope,scope_id,client_key));
      CREATE INDEX IF NOT EXISTS operation_records_ref ON operation_records(scope,ref);
      CREATE TABLE IF NOT EXISTS panel_updates(id TEXT PRIMARY KEY,panel_agent_id TEXT NOT NULL REFERENCES panel_agents(id) ON DELETE CASCADE,group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,source_turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,kind TEXT NOT NULL DEFAULT 'update' CHECK(kind IN ('update','continuation')),text TEXT NOT NULL,source_message_ids TEXT NOT NULL DEFAULT '[]',created TEXT NOT NULL,delivered_turn_id TEXT,delivered TEXT);
      CREATE INDEX IF NOT EXISTS panel_updates_pending ON panel_updates(panel_agent_id,group_id,delivered_turn_id,created);
      CREATE TABLE IF NOT EXISTS interactions(id TEXT PRIMARY KEY,group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,member_id TEXT REFERENCES members(id) ON DELETE CASCADE,panel_agent_id TEXT REFERENCES panel_agents(id) ON DELETE CASCADE,conversation_id TEXT,context TEXT NOT NULL,turn_id TEXT NOT NULL,call_id TEXT NOT NULL,message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,panel_message_id TEXT,kind TEXT NOT NULL CHECK(kind IN ('choice','input','takeover','handback','group_create','group_add','group_delete','member_model')),payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','answered','cancelled','failed')),answer TEXT,detail TEXT,answer_message_id TEXT,created TEXT NOT NULL,answered TEXT);
      CREATE INDEX IF NOT EXISTS interactions_group ON interactions(group_id,created);
      CREATE INDEX IF NOT EXISTS interactions_panel ON interactions(panel_agent_id,created);`);
  }

  // v1 -> v2:会话、回合、输入、历史、来源、投递队列各合并为单表。
  // SQLite 在 foreign_keys=OFF 时仍会改写 REFERENCES(实测)，必须同时 legacy_alter_table=ON；
  // 旧历史 seq 保持不变，Panel 历史整体平移到成员历史之后，并同步修正其 origins.event_seq。
  migrateV2() {
    const hasTable = name => Boolean(this.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name));
    if (hasTable('conversations') && !hasTable('endpoints') && !hasTable('panel_sessions')) return;
    if (!hasTable('endpoints') || !hasTable('panel_sessions')) throw new Error('v2 迁移缺少 v1 会话表');
    const now = new Date().toISOString();
    this.db.exec('PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON;');
    try {
      this.transaction(() => {
        this.db.exec(`ALTER TABLE turns RENAME TO turns_v1;
          ALTER TABLE turn_inputs RENAME TO turn_inputs_v1;
          ALTER TABLE message_origins RENAME TO message_origins_v1;
          ALTER TABLE history RENAME TO history_v1;
          ALTER TABLE outbox RENAME TO outbox_v1;
          ALTER TABLE attached RENAME TO attached_v1;
          ALTER TABLE panel_updates RENAME TO panel_updates_v1;
          ALTER TABLE interactions RENAME TO interactions_v1;
          DROP INDEX IF EXISTS history_endpoint;
          DROP INDEX IF EXISTS history_turn;
          DROP INDEX IF EXISTS inputs_message;
          DROP INDEX IF EXISTS panel_updates_pending;
          DROP INDEX IF EXISTS interactions_group;
          DROP INDEX IF EXISTS interactions_panel;`);
        this.ensureV2Schema();
        this.db.exec(`INSERT INTO conversations(id,group_id,member_id,panel_agent_id,context,peer,session,policy_signature,key,created,updated)
            SELECT e.id,e.group_id,e.member_id,NULL,e.context,e.peer,e.session,(SELECT p.signature FROM endpoint_policy p WHERE p.endpoint_id=e.id),e.key,'${now}','${now}' FROM endpoints e;
          INSERT INTO conversations(id,group_id,member_id,panel_agent_id,context,peer,session,policy_signature,key,created,updated)
            SELECT s.id,s.group_id,NULL,s.panel_agent_id,s.context,NULL,s.session,s.policy_signature,s.key,s.created,s.updated FROM panel_sessions s;
          INSERT INTO turns(id,conversation_id,executor_kind,executor_id,group_id,session,active_team_id,source_user_message_id,state,detail,created,ended)
            SELECT t.id,t.endpoint_id,'member',e.member_id,e.group_id,t.session,NULL,NULL,COALESCE(r.state,'unknown'),r.detail,COALESCE(r.created,t.created),r.ended
            FROM turns_v1 t LEFT JOIN runtime_attempts r ON r.turn_id=t.id LEFT JOIN endpoints e ON e.id=t.endpoint_id;
          INSERT INTO turns(id,conversation_id,executor_kind,executor_id,group_id,session,active_team_id,source_user_message_id,state,detail,created,ended)
            SELECT p.id,p.session_id,'panel_agent',p.panel_agent_id,p.group_id,s.session,p.active_team_id,p.source_user_message_id,p.state,NULL,p.created,p.ended
            FROM panel_turns p LEFT JOIN panel_sessions s ON s.id=p.session_id;
          INSERT INTO turn_inputs SELECT * FROM turn_inputs_v1;
          INSERT INTO turn_inputs SELECT * FROM panel_turn_inputs;
          INSERT INTO history(seq,conversation_id,event,created,turn_id) SELECT seq,endpoint_id,event,created,turn_id FROM history_v1;`);
        const offset = Number(this.get('SELECT COALESCE(MAX(seq),0) AS seq FROM history').seq ?? 0);
        this.db.exec(`INSERT INTO history(seq,conversation_id,event,created,turn_id) SELECT seq+${offset},session_id,event,created,turn_id FROM panel_history;
          INSERT INTO message_origins(message_id,turn_id,event_seq,call_id,native_call_id) SELECT message_id,turn_id,event_seq,call_id,native_call_id FROM message_origins_v1;
          INSERT INTO message_origins(message_id,turn_id,event_seq,call_id,native_call_id) SELECT message_id,turn_id,CASE WHEN event_seq IS NULL THEN NULL ELSE event_seq+${offset} END,call_id,native_call_id FROM panel_message_origins;
          INSERT INTO outbox(id,conversation_id,payload,accepted,error) SELECT id,endpoint_id,payload,accepted,error FROM outbox_v1;
          INSERT INTO outbox(id,conversation_id,payload,accepted,error) SELECT id,session_id,payload,accepted,error FROM panel_outbox;
          INSERT INTO attached SELECT * FROM attached_v1;
          INSERT INTO attached SELECT * FROM panel_attached;
          INSERT INTO conversation_session_meta(conversation_id,session_key,session,session_updated) SELECT endpoint_id,session_key,session,updated FROM endpoint_session_bindings;
          INSERT INTO conversation_session_meta(conversation_id,session_key,policy_signature) SELECT endpoint_id,session_key,signature FROM endpoint_session_policies WHERE true
            ON CONFLICT(conversation_id,session_key) DO UPDATE SET policy_signature=excluded.policy_signature;
          INSERT INTO conversation_session_meta(conversation_id,session_key,schema_version,format_source,format_created,format_updated) SELECT endpoint_id,session_key,schema_version,source,created,updated FROM endpoint_context_formats WHERE true
            ON CONFLICT(conversation_id,session_key) DO UPDATE SET schema_version=excluded.schema_version,format_source=excluded.format_source,format_created=excluded.format_created,format_updated=excluded.format_updated;
          INSERT INTO conversation_session_meta(conversation_id,session_key,schema_version,format_source,format_created,format_updated) SELECT session_id,'default',schema_version,source,created,updated FROM panel_session_context_formats WHERE true
            ON CONFLICT(conversation_id,session_key) DO UPDATE SET schema_version=excluded.schema_version,format_source=excluded.format_source,format_created=excluded.format_created,format_updated=excluded.format_updated;
          INSERT INTO panel_updates(id,panel_agent_id,group_id,source_turn_id,kind,text,source_message_ids,created,delivered_turn_id,delivered)
            SELECT id,panel_agent_id,group_id,source_turn_id,kind,text,source_message_ids,created,delivered_turn_id,delivered FROM panel_updates_v1;
          INSERT INTO interactions(id,group_id,member_id,panel_agent_id,conversation_id,context,turn_id,call_id,message_id,panel_message_id,kind,payload,state,answer,detail,answer_message_id,created,answered)
            SELECT id,group_id,member_id,panel_agent_id,endpoint_id,context,turn_id,call_id,message_id,panel_message_id,kind,payload,state,answer,detail,answer_message_id,created,answered FROM interactions_v1;
          UPDATE conversations SET policy_signature=(SELECT p.signature FROM endpoint_policy p WHERE p.endpoint_id=conversations.id)
            WHERE member_id IS NOT NULL AND EXISTS(SELECT 1 FROM endpoint_policy p WHERE p.endpoint_id=conversations.id);
          DROP TABLE turns_v1; DROP TABLE turn_inputs_v1; DROP TABLE message_origins_v1; DROP TABLE history_v1;
          DROP TABLE outbox_v1; DROP TABLE attached_v1; DROP TABLE panel_updates_v1; DROP TABLE interactions_v1;
          DROP TABLE endpoints; DROP TABLE panel_sessions; DROP TABLE runtime_attempts; DROP TABLE panel_turns;
          DROP TABLE panel_turn_inputs; DROP TABLE panel_message_origins; DROP TABLE panel_history;
          DROP TABLE panel_outbox; DROP TABLE panel_attached; DROP TABLE endpoint_session_bindings;
          DROP TABLE endpoint_session_policies; DROP TABLE endpoint_policy; DROP TABLE endpoint_context_formats;
          DROP TABLE panel_session_context_formats;`);
        if (this.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='team_requests'")) {
          this.db.exec(`ALTER TABLE team_requests RENAME TO team_requests_v1;
            CREATE TABLE team_requests(id TEXT PRIMARY KEY,panel_agent_id TEXT NOT NULL REFERENCES panel_agents(id) ON DELETE CASCADE,source_user_message_id TEXT NOT NULL REFERENCES panel_messages(id) ON DELETE CASCADE,source_turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,call_id TEXT,group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,controller_id TEXT NOT NULL,operation_id TEXT NOT NULL,message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,original_text TEXT NOT NULL,text TEXT NOT NULL,created TEXT NOT NULL,UNIQUE(panel_agent_id,source_user_message_id,operation_id));
            INSERT INTO team_requests SELECT id,panel_agent_id,source_user_message_id,source_turn_id,call_id,group_id,controller_id,operation_id,message_id,original_text,text,created FROM team_requests_v1;
            DROP TABLE team_requests_v1;`);
        }
        const violations = this.all('PRAGMA foreign_key_check');
        if (violations.length) throw new Error(`v2 迁移外键校验失败: ${JSON.stringify(violations.slice(0, 3))}`);
      });
    } finally {
      this.db.exec('PRAGMA legacy_alter_table=OFF; PRAGMA foreign_keys=ON;');
    }
  }

  // ADR 0004: task-flow persistence is gone. Old databases shed their process
  // tables and columns; message history, host sessions and telemetry remain.
  migrate() {
    const flowTables = [
      'preparations', 'preparation_policy', 'contract_versions', 'team_state',
      'work_items', 'work_records', 'change_requests', 'collaboration_operations',
      'message_context', 'message_dispositions', 'user_outputs',
      'team_charter_versions', 'goal_drafts', 'goals', 'goal_contract_versions',
      'goal_events', 'team_goal_operations', 'panel_action_requests',
    ];
    for (const table of flowTables) this.db.exec(`DROP TABLE IF EXISTS ${table}`);
    this.migrateInteractions();
    this.migrateAgentTasks();
    this.migrateAttachments();
    for (const [table, column] of [
      ['members', 'joined_goal_version'], ['members', 'removed_goal_version'],
      ['runtime_attempts', 'contract_version'], ['runtime_attempts', 'goal_id'],
      ['groups', 'revision'],
    ]) {
      if (this.all(`PRAGMA table_info(${table})`).some(column_ => column_.name === column)) {
        // SQLite refuses DROP COLUMN while an index references the column; retired
        // task-flow indexes (e.g. runtime_attempts_goal) must go first.
        const referenced = new RegExp(`\\b${column}\\b`);
        for (const index of this.all("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL", table)) {
          if (referenced.test(index.sql)) this.db.exec(`DROP INDEX IF EXISTS ${index.name}`);
        }
        this.db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
      }
    }
  }
  // attachments 的 media_type CHECK 扩展(image/jpeg)走重建:SQLite 不能改 CHECK。
  migrateAttachments() {
    const info = this.all('PRAGMA table_info(attachments)');
    if (!info.length) return;
    const tableSql = this.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='attachments'")?.sql ?? '';
    if (tableSql.includes("'image/jpeg'")) return;
    this.transaction(() => {
      this.db.exec(`ALTER TABLE attachments RENAME TO attachments_legacy;
        CREATE TABLE attachments(id TEXT PRIMARY KEY,panel_agent_id TEXT NOT NULL REFERENCES panel_agents(id) ON DELETE CASCADE,original_name TEXT NOT NULL,media_type TEXT NOT NULL CHECK(media_type IN ('text/plain','image/png','image/jpeg')),size INTEGER NOT NULL,storage_name TEXT NOT NULL,created_at TEXT NOT NULL,panel_message_id TEXT REFERENCES panel_messages(id) ON DELETE CASCADE,ordinal INTEGER);
        INSERT INTO attachments(id,panel_agent_id,original_name,media_type,size,storage_name,created_at,panel_message_id,ordinal) SELECT id,panel_agent_id,original_name,media_type,size,storage_name,created_at,panel_message_id,ordinal FROM attachments_legacy;
        DROP TABLE attachments_legacy;
        CREATE INDEX IF NOT EXISTS attachments_message ON attachments(panel_message_id);
        CREATE INDEX IF NOT EXISTS attachments_agent ON attachments(panel_agent_id);`);
    });
  }
  // agent_tasks 主键从 owner_id 演进为 (owner_id,group_id):
  // Panel Agent 在多个团队各有一份任务列表,单列主键会让跨团队写入互相覆盖。
  migrateAgentTasks() {
    const info = this.all('PRAGMA table_info(agent_tasks)');
    if (!info.length) return;
    const pkColumns = info.filter(column => column.pk > 0).sort((a, b) => a.pk - b.pk).map(column => column.name);
    if (pkColumns.length === 2) return;
    this.transaction(() => {
      this.db.exec(`ALTER TABLE agent_tasks RENAME TO agent_tasks_legacy;
        CREATE TABLE agent_tasks(owner_id TEXT NOT NULL,group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,tasks TEXT NOT NULL,updated TEXT NOT NULL,PRIMARY KEY(owner_id,group_id));
        INSERT INTO agent_tasks(owner_id,group_id,tasks,updated) SELECT owner_id,group_id,tasks,updated FROM agent_tasks_legacy;
        DROP TABLE agent_tasks_legacy;
        CREATE INDEX IF NOT EXISTS agent_tasks_group ON agent_tasks(group_id);`);
    });
  }
  // interactions 结构演进统一走重建:请求方泛化(v2)、动作类 kind 扩展(v3)。
  // 用 sqlite_master 里的 CHECK 文本探测当前表是否包含全部所需 kind。
  migrateInteractions() {    const info = this.all('PRAGMA table_info(interactions)');
    if (!info.length) return;
    const tableSql = this.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='interactions'")?.sql ?? '';
    const neededKinds = ['choice', 'input', 'takeover', 'handback', 'group_create', 'group_add', 'group_delete', 'member_model'];
    const missingKinds = neededKinds.filter(kind => !tableSql.includes(`'${kind}'`));
    const needsRebuild = missingKinds.length > 0 || !info.some(column => column.name === 'panel_agent_id');
    if (needsRebuild) {
      const cols = new Set(info.map(column => column.name));
      const pick = (name, fallback = 'NULL') => (cols.has(name) ? name : fallback);
      this.transaction(() => {
        this.db.exec(`ALTER TABLE interactions RENAME TO interactions_legacy;
          CREATE TABLE interactions(id TEXT PRIMARY KEY,group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,member_id TEXT REFERENCES members(id) ON DELETE CASCADE,panel_agent_id TEXT REFERENCES panel_agents(id) ON DELETE CASCADE,endpoint_id TEXT,context TEXT NOT NULL,turn_id TEXT NOT NULL,call_id TEXT NOT NULL,message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,panel_message_id TEXT,kind TEXT NOT NULL CHECK(kind IN ('choice','input','takeover','handback','group_create','group_add','group_delete','member_model')),payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','answered','cancelled','failed')),answer TEXT,detail TEXT,answer_message_id TEXT,created TEXT NOT NULL,answered TEXT);
          INSERT INTO interactions(id,group_id,member_id,panel_agent_id,endpoint_id,context,turn_id,call_id,message_id,panel_message_id,kind,payload,state,answer,detail,answer_message_id,created,answered)
            SELECT id,group_id,member_id,${pick('panel_agent_id')},${pick('endpoint_id')},context,turn_id,call_id,message_id,${pick('panel_message_id')},kind,payload,state,answer,${pick('detail')},answer_message_id,created,answered FROM interactions_legacy;
          DROP TABLE interactions_legacy;
          CREATE INDEX IF NOT EXISTS interactions_group ON interactions(group_id,created);`);
      });
    }
    // v1/v2 库重建后与新建库统一补齐 panel 索引;不能放进 schema 块,
    // 否则对未迁移的旧表建索引会在 migrate 之前失败。
    this.db.exec('CREATE INDEX IF NOT EXISTS interactions_panel ON interactions(panel_agent_id,created)');
  }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  get(sql, ...args) { return this.db.prepare(sql).get(...args); }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  group(id) {
    const group = this.get('SELECT * FROM groups WHERE id=?', id);
    if (!group) throw new Error('群不存在');
    return group;
  }
  member(id) {
    const member = this.get('SELECT * FROM members WHERE id=? AND removed IS NULL', id);
    if (!member) throw new Error('成员不存在或已移除');
    return member;
  }
  // 会话统一入口:v2 起只有 conversations 单表；调用方不关心存储形态。
  conversation(kind, ownerId, context, { peer = null, groupId = null } = {}) {
    if (kind === 'member') {
      const member = this.member(ownerId);
      let row = this.get('SELECT * FROM conversations WHERE member_id=? AND context=?', ownerId, context);
      if (!row) {
        const id = randomUUID();
        const now = new Date().toISOString();
        this.run('INSERT INTO conversations(id,group_id,member_id,panel_agent_id,context,peer,session,policy_signature,key,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
          id, member.group_id, member.id, null, context, peer, null, null, randomBytes(32).toString('hex'), now, now);
        row = this.get('SELECT * FROM conversations WHERE id=?', id);
      }
      return { ...row, owner_kind: 'member', owner_id: row.member_id };
    }
    if (kind === 'panel_agent') {
      const existing = context === 'private'
        ? this.get("SELECT * FROM conversations WHERE panel_agent_id=? AND context='private'", ownerId)
        : this.get("SELECT * FROM conversations WHERE panel_agent_id=? AND context='coordination' AND group_id=?", ownerId, groupId);
      if (existing) return { ...existing, owner_kind: 'panel_agent', owner_id: existing.panel_agent_id };
      if (context === 'coordination') this.group(groupId);
      const id = `panel-session-${randomUUID()}`;
      const now = new Date().toISOString();
      this.run('INSERT INTO conversations(id,group_id,member_id,panel_agent_id,context,peer,session,policy_signature,key,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        id, groupId ?? null, null, ownerId, context, null, null, null, randomBytes(32).toString('hex'), now, now);
      return { ...this.get('SELECT * FROM conversations WHERE id=?', id), owner_kind: 'panel_agent', owner_id: ownerId };
    }
    throw new Error(`未知的会话类型: ${kind}`);
  }
  conversationById(id) {
    const row = this.get('SELECT * FROM conversations WHERE id=?', id);
    if (!row) return null;
    return { ...row, owner_kind: row.member_id ? 'member' : 'panel_agent', owner_id: row.member_id ?? row.panel_agent_id };
  }
  // 身份只读投影:身份表仍是两张，执行层只读公共字段；不做表合并。
  actor(kind, id) {
    if (kind === 'member') {
      const row = this.get('SELECT * FROM members WHERE id=? AND removed IS NULL', id);
      return row ? { ...row, kind: 'member' } : null;
    }
    if (kind === 'panel_agent') {
      const row = this.get('SELECT * FROM panel_agents WHERE id=?', id);
      return row ? { ...row, kind: 'panel_agent' } : null;
    }
    return null;
  }
  actors() {
    const members = this.all('SELECT * FROM members WHERE removed IS NULL ORDER BY rowid').map(row => ({ ...row, kind: 'member' }));
    const panelAgent = this.panelAgent();
    return panelAgent ? [...members, { ...panelAgent, kind: 'panel_agent' }] : members;
  }
  // 会话列表投影:两种 owner 统一形状；Panel 只有 coordination 会话，私聊不进入团队列表。
  conversationsForGroup(groupId, { includePrivate = false } = {}) {
    const rows = this.all(`SELECT * FROM conversations WHERE 1=1${includePrivate ? '' : " AND context!='private'"}${groupId === undefined ? '' : ' AND group_id=?'}`,
      ...(groupId === undefined ? [] : [groupId]));
    return rows.map(row => ({ ...row, owner_kind: row.member_id ? 'member' : 'panel_agent', owner_id: row.member_id ?? row.panel_agent_id }));
  }
  setConversationSession(id, session) {
    const changed = this.run('UPDATE conversations SET session=?,updated=? WHERE id=?', session, new Date().toISOString(), id);
    if (!changed.changes) throw new Error('会话不存在');
  }
  setConversationPolicySignature(id, signature, sessionKey = 'default') {
    const changed = this.run('UPDATE conversations SET policy_signature=?,updated=? WHERE id=?', signature, new Date().toISOString(), id);
    if (!changed.changes) throw new Error('会话不存在');
    this.run('INSERT INTO conversation_session_meta(conversation_id,session_key,policy_signature) VALUES(?,?,?) ON CONFLICT(conversation_id,session_key) DO UPDATE SET policy_signature=excluded.policy_signature', id, sessionKey, signature);
  }
  endpoint(memberId, context, peer = null) {
    return this.conversation('member', memberId, context, { peer });
  }
  panelAgent() {
    return this.get('SELECT * FROM panel_agents ORDER BY created LIMIT 1') ?? null;
  }
  // 消息附件查询(纯 DB);availability 由附件模块结合文件现状补充。
  panelAttachments(messageId) {
    return this.all('SELECT id,original_name,media_type,size,storage_name FROM attachments WHERE panel_message_id=? ORDER BY ordinal', messageId);
  }
  // 附件上传设置:空表读取默认值,首次保存 upsert;校验收口在 attachment-settings.mjs。
  attachmentSettings() {
    const row = this.get('SELECT max_file_bytes,max_files,max_image_pixels,updated FROM attachment_settings WHERE singleton=1');
    if (!row) return { ...DEFAULT_ATTACHMENT_SETTINGS, updated: null };
    return serializeAttachmentSettings(row);
  }
  updateAttachmentSettings(value) {
    const settings = normalizeAttachmentSettings(value);
    const now = new Date().toISOString();
    this.run(
      `INSERT INTO attachment_settings(singleton,max_file_bytes,max_files,max_image_pixels,updated) VALUES(1,?,?,?,?)
       ON CONFLICT(singleton) DO UPDATE SET max_file_bytes=excluded.max_file_bytes,max_files=excluded.max_files,max_image_pixels=excluded.max_image_pixels,updated=excluded.updated`,
      settings.maxFileBytes,
      settings.maxFilesPerMessage,
      settings.maxImagePixels,
      now,
    );
    return this.attachmentSettings();
  }
  panelSession(panelAgentId, context, groupId = null) {
    return this.conversation('panel_agent', panelAgentId, context, { groupId });
  }
  authenticatePanelSession(id, key) {
    const conversation = this.get('SELECT * FROM conversations WHERE id=? AND key=? AND panel_agent_id IS NOT NULL', id, key);
    if (!conversation) throw new Error('Panel Agent 会话来源无效');
    const panelAgent = this.get('SELECT * FROM panel_agents WHERE id=?', conversation.panel_agent_id);
    if (!panelAgent) throw new Error('Panel Agent 不存在');
    return { session: { ...conversation, owner_kind: 'panel_agent', owner_id: conversation.panel_agent_id }, panelAgent };
  }
  authenticate(id, key) {
    const conversation = this.get('SELECT * FROM conversations WHERE id=? AND key=? AND member_id IS NOT NULL', id, key);
    if (!conversation) throw new Error('会话来源无效');
    this.member(conversation.member_id);
    return { ...conversation, owner_kind: 'member', owner_id: conversation.member_id };
  }
  append(groupId, sender, recipient, kind, text, replyTo = null, expectsReply = false) {
    this.group(groupId);
    const id = randomUUID();
    // user 收件人不会进入投递队列；note/system 随下一次批量交付，不参与 pending 扫描。
    const awaiting = kind === 'send' && recipient !== 'user' ? 1 : 0;
    const expects = kind === 'send' && expectsReply ? 1 : 0;
    this.run('INSERT INTO messages(id,group_id,sender,recipient,kind,text,reply_to,created,awaiting,expects_reply) VALUES(?,?,?,?,?,?,?,?,?,?)', id, groupId, sender, recipient, kind, text, replyTo, new Date().toISOString(), awaiting, expects);
    return this.get('SELECT * FROM messages WHERE id=?', id);
  }

  dismissWorkbench(category, itemId) {
    this.run('INSERT OR IGNORE INTO workbench_dismissals(category,item_id,created) VALUES(?,?,?)', category, itemId, new Date().toISOString());
  }
  pending() {
    return this.all(`SELECT m.* FROM messages m JOIN groups g ON g.id=m.group_id
      WHERE (g.state IS NULL OR g.state='open') AND m.kind='send' AND m.awaiting=1
      AND (
        EXISTS(SELECT 1 FROM members r WHERE r.id=m.recipient AND r.removed IS NULL)
        OR EXISTS(SELECT 1 FROM team_lead_controllers c WHERE c.group_id=m.group_id AND c.controller_kind='panel_agent' AND c.controller_id=m.recipient AND c.state='active')
      ) ORDER BY m.seq`);
  }
  // 历史保留:删除 cutoff 之前且已可安全丢弃的数据。
  // 保留:待投递消息、待响应互动卡、运行中/待核实回合的输入、Panel 私聊消息与未交付队列。
  pruneHistory({ retentionDays = 30, now = Date.now() } = {}) {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) throw new Error('保留天数无效');
    const cutoff = new Date(now - retentionDays * 86400000).toISOString();
    return this.transaction(() => {
      const messages = this.run(`DELETE FROM messages WHERE created < ? AND awaiting=0
        AND NOT EXISTS(SELECT 1 FROM attached a JOIN outbox o ON o.id=a.outbox_id WHERE a.message_id=messages.id AND o.accepted IS NULL)
        AND NOT EXISTS(SELECT 1 FROM interactions i WHERE i.message_id=messages.id AND i.state='pending')
        AND NOT EXISTS(SELECT 1 FROM turn_inputs ti JOIN turns t ON t.id=ti.turn_id WHERE ti.message_id=messages.id AND t.state IN ('running','unknown'))`, cutoff);
      const turns = this.run("DELETE FROM turns WHERE created < ? AND state NOT IN ('running','unknown')", cutoff);
      const history = this.run('DELETE FROM history WHERE created < ? AND (turn_id IS NULL OR turn_id NOT IN (SELECT id FROM turns))', cutoff);
      const outbox = this.run('DELETE FROM outbox WHERE accepted IS NOT NULL AND accepted < ?', cutoff);
      const schemas = this.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='turn_context_schemas'")
        ? this.run('DELETE FROM turn_context_schemas WHERE turn_id NOT IN (SELECT id FROM turns)')
        : { changes: 0 };
      const dismissals = this.run('DELETE FROM workbench_dismissals WHERE created < ?', cutoff);
      return { messages: messages.changes, turns: turns.changes, history: history.changes, outbox: outbox.changes, schemas: schemas.changes, dismissals: dismissals.changes, cutoff };
    });
  }
  createInteraction({ id, groupId = null, memberId = null, panelAgentId = null, endpointId = null, context, turnId, callId, messageId = null, panelMessageId = null, kind, payload, detail = null }) {
    this.run('INSERT INTO interactions(id,group_id,member_id,panel_agent_id,conversation_id,context,turn_id,call_id,message_id,panel_message_id,kind,payload,state,detail,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id, groupId, memberId, panelAgentId, endpointId, context, turnId, callId, messageId, panelMessageId, kind, JSON.stringify(payload), 'pending', detail, new Date().toISOString());
    return this.interaction(id);
  }
  interaction(id) {
    return this.get('SELECT * FROM interactions WHERE id=?', id) ?? null;
  }
  setInteractionState(id, state, answer = null, answerMessageId = null, detail = null) {
    this.run('UPDATE interactions SET state=?,answer=?,detail=?,answer_message_id=?,answered=? WHERE id=?',
      state,
      answer === null ? null : JSON.stringify(answer),
      detail,
      answerMessageId,
      state === 'answered' || state === 'failed' ? new Date().toISOString() : null,
      id);
    return this.interaction(id);
  }
  interactions(groupId) {
    return this.all('SELECT * FROM interactions WHERE group_id=? ORDER BY created DESC, rowid DESC LIMIT 100', groupId);
  }
  panelInteractions() {
    return this.all('SELECT * FROM interactions WHERE panel_agent_id IS NOT NULL ORDER BY created DESC, rowid DESC LIMIT 100');
  }
  pendingMemberInteractions(groupId, memberId) {
    return this.all("SELECT * FROM interactions WHERE group_id=? AND member_id=? AND state='pending'", groupId, memberId);
  }
  prepare(message, conversation, canBatch = () => true) {
    return this.transaction(() => {
      if (this.get('SELECT 1 FROM attached WHERE message_id=?', message.id)) return null;
      if (conversation.member_id) this.member(conversation.member_id);
      const notes = this.all(`SELECT m.* FROM messages m WHERE m.recipient=? AND m.kind IN ('note','system')
        AND NOT EXISTS(SELECT 1 FROM attached a WHERE a.message_id=m.id) ORDER BY m.seq`, message.recipient);
      const candidates = this.all(`SELECT m.* FROM messages m WHERE ${conversation.context === 'coordination' ? '' : 'm.sender=? AND '}m.recipient=? AND m.kind='send' AND m.id!=?
        AND m.awaiting=1 ORDER BY m.seq`, ...(conversation.context === 'coordination' ? [] : [message.sender]), message.recipient, message.id);
      const additional = [];
      for (const candidate of candidates) if (canBatch([message, ...additional, candidate])) additional.push(candidate);
      const payload = { groupId: message.group_id, conversation: conversation.context === 'coordination' ? 'coordination' : [message.sender, message.recipient].sort(), message, ...(additional.length ? { additionalMessages: additional } : {}), notes };
      const id = randomUUID();
      this.run('INSERT INTO outbox(id,conversation_id,payload) VALUES(?,?,?)', id, conversation.id, JSON.stringify(payload));
      for (const item of [message, ...additional, ...notes]) {
        this.run('INSERT INTO attached VALUES(?,?)', item.id, id);
        this.run('UPDATE messages SET awaiting=0 WHERE id=?', item.id);
      }
      return { id, conversation_id: conversation.id, owner_kind: conversation.owner_kind, payload: JSON.stringify(payload), accepted: null, error: null };
    });
  }
  prepareDelivery(conversation, message, canBatch = () => true) {
    return this.prepare(message, conversation, canBatch);
  }
  // 待投递队列的统一读取:v1 仍是两张表,顺序保持"先 Panel 后成员"，与旧 pump 一致。
  pendingDeliveries() {
    // 部分索引覆盖 accepted IS NULL;ORDER BY rowid 会迫使 SQLite 全表扫描,排序放到 JS。
    return this.all(`SELECT o.rowid AS rowid,o.*,c.member_id,c.panel_agent_id FROM outbox o JOIN conversations c ON c.id=o.conversation_id
      WHERE o.accepted IS NULL AND o.error IS NULL`)
      .sort((a, b) => a.rowid - b.rowid)
      .map(row => ({ ...row, owner_kind: row.member_id ? 'member' : 'panel_agent' }));
  }
  hasPendingDelivery(conversationId) {
    return Boolean(this.get('SELECT 1 FROM outbox WHERE conversation_id=? AND accepted IS NULL AND error IS NULL', conversationId));
  }
  setDeliveryAccepted(entry, accepted = new Date().toISOString()) {
    this.run('UPDATE outbox SET accepted=? WHERE id=?', accepted, entry.id);
  }
  setDeliveryError(entry, error) {
    this.run('UPDATE outbox SET error=? WHERE id=?', error, entry.id);
  }
  deliveryAccepted(entry) {
    return this.get('SELECT accepted FROM outbox WHERE id=?', entry.id)?.accepted ?? null;
  }
  panelAppend(panelAgentId, context, role, text, activeTeamId = null) {
    const id = randomUUID();
    this.run(
      'INSERT INTO panel_messages(id,panel_agent_id,context,role,text,active_team_id,created) VALUES(?,?,?,?,?,?,?)',
      id,
      panelAgentId,
      context,
      role,
      text,
      activeTeamId,
      new Date().toISOString(),
    );
    return this.get('SELECT * FROM panel_messages WHERE id=?', id);
  }
  panelHistory(conversationId, event, turnId = null) {
    return Number(this.run(
      'INSERT INTO history(conversation_id,event,created,turn_id) VALUES(?,?,?,?)',
      conversationId,
      JSON.stringify(event),
      new Date().toISOString(),
      turnId,
    ).lastInsertRowid);
  }
  // 回合统一入口:两种执行者都写同一张 turns；调用方只传 owner 类型。
  createTurn(conversation, {
    executorKind,
    executorId = null,
    inputs = [],
    state = 'running',
    activeTeamId = null,
    sourceUserMessageId = null,
  } = {}) {
    return this.transaction(() => {
      const id = randomUUID();
      this.run(
        'INSERT INTO turns(id,conversation_id,executor_kind,executor_id,group_id,session,active_team_id,source_user_message_id,state,detail,created) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        id,
        conversation.id,
        executorKind,
        executorId ?? conversation.owner_id ?? conversation.member_id ?? conversation.panel_agent_id,
        conversation.group_id ?? null,
        conversation.session ?? null,
        activeTeamId,
        sourceUserMessageId,
        state,
        null,
        new Date().toISOString(),
      );
      inputs.forEach((message, ordinal) => this.run('INSERT INTO turn_inputs VALUES(?,?,?)', id, message.id, ordinal));
      return id;
    });
  }
  // 状态写点收敛:所有执行者写同一列 turns.state。
  setTurnState(turnId, state, { detail = null, ended = new Date().toISOString() } = {}) {
    this.run('UPDATE turns SET state=?,detail=?,ended=? WHERE id=?', state, detail, ended, turnId);
    return state;
  }
  setTurnSession(turnId, session) {
    this.run('UPDATE turns SET session=? WHERE id=?', session, turnId);
  }
  // 总线重启后的单次恢复:无法证明宿主已停止的回合一律标 unknown，等待用户核实。
  recoverInterruptedTurns() {
    const result = this.run("UPDATE turns SET state='unknown',detail='总线重启，需要用户核实宿主是否已停止' WHERE state='running'");
    return { turns: result.changes };
  }
  history(conversationId, event, turnId = null) {
    const conversation = this.get('SELECT context,member_id FROM conversations WHERE id=?', conversationId);
    if (!conversation || (conversation.member_id && conversation.context === 'private')) return null;
    return Number(this.run('INSERT INTO history(conversation_id,event,created,turn_id) VALUES(?,?,?,?)', conversationId, JSON.stringify(event), new Date().toISOString(), turnId).lastInsertRowid);
  }
  publicTurn(id) {
    return this.get('SELECT t.*,c.group_id,c.member_id,c.context,c.peer FROM turns t JOIN conversations c ON c.id=t.conversation_id WHERE t.id=? AND c.context!=\'private\'', id);
  }
  messageTrace(id) {
    const message = this.get('SELECT id,kind FROM messages WHERE id=?', id);
    if (!message) {
      // Panel 私聊消息存于 panel_messages,未记录回合来源(v6 无消息→turn 映射);
      // 按成员私聊同语义返回 private,前端据此显示「没有可用轨迹」而不是把已知消息当 404。
      if (!this.get('SELECT id FROM panel_messages WHERE id=?', id)) return null;
      return { messageId: id, source: { kind: 'private' }, inputAttempts: [] };
    }
    const origin = this.get(`SELECT o.*,c.context,c.id AS conversation_id,c.member_id,c.panel_agent_id,t.executor_kind,t.group_id AS turn_group_id
      FROM message_origins o JOIN turns t ON t.id=o.turn_id JOIN conversations c ON c.id=t.conversation_id WHERE o.message_id=?`, id);
    const source = !origin
      ? { kind: message.kind === 'system' ? 'system' : 'unknown' }
      : origin.executor_kind === 'panel_agent'
        ? {
            kind: origin.context === 'private' ? 'private' : 'panel',
            turnId: origin.turn_id,
            endpointId: null,
            panelAgentId: origin.panel_agent_id,
            groupId: origin.turn_group_id,
            eventSeq: origin.event_seq,
            callId: origin.call_id,
            nativeCallId: origin.native_call_id,
          }
        : origin.context === 'private'
          ? { kind: 'private' }
          : { kind: 'group', turnId: origin.turn_id, endpointId: origin.conversation_id, eventSeq: origin.event_seq, callId: origin.call_id, nativeCallId: origin.native_call_id };
    const inputAttempts = this.all(
      `SELECT t.id,t.conversation_id AS endpoint_id,t.session,t.created FROM turn_inputs i JOIN turns t ON t.id=i.turn_id
       JOIN conversations c ON c.id=t.conversation_id WHERE i.message_id=? AND c.context!='private' ORDER BY t.rowid`,
      id,
    );
    return { messageId: id, source, inputAttempts };
  }
  endpointModels(id, after = 0) {
    const conversation = this.get("SELECT id FROM conversations WHERE id=? AND context!='private'", id);
    if (!conversation) return null;
    const all = modelObservations(this.all('SELECT seq,turn_id,created,event FROM history WHERE conversation_id=? ORDER BY seq', id));
    const observations = all.filter(observation => observation.seq > after).slice(0, 200);
    return { ...deriveCurrentModel(all), observations, nextAfter: observations.at(-1)?.seq ?? after };
  }
  endpointModelSummary(id) {
    const revision = this.get('SELECT MAX(seq) AS seq,COUNT(*) AS count FROM history WHERE conversation_id=?', id);
    this.modelSummaryCache ??= new Map();
    const cached = this.modelSummaryCache.get(id);
    if (cached?.seq === revision.seq && cached?.count === revision.count) return cached.value;
    const value = deriveCurrentModel(modelObservations(this.all(
      'SELECT seq,turn_id,created,event FROM history WHERE conversation_id=? ORDER BY seq', id,
    )));
    this.modelSummaryCache.set(id, { ...revision, value });
    return value;
  }
  turnTrace(id, after = 0) {
    const turn = this.get(`SELECT t.*,c.group_id,c.member_id,c.panel_agent_id,c.context,c.peer
      FROM turns t JOIN conversations c ON c.id=t.conversation_id WHERE t.id=? AND c.context!='private'`, id);
    if (!turn) return null;
    const events = this.all('SELECT * FROM history WHERE turn_id=? AND seq>? ORDER BY seq LIMIT 200', id, after);
    const observations = modelObservations(this.all('SELECT seq,turn_id,created,event FROM history WHERE turn_id=? ORDER BY seq', id));
    return {
      turn: {
        id: turn.id,
        endpoint_id: turn.conversation_id,
        session: turn.session,
        created: turn.created,
        group_id: turn.group_id,
        member_id: turn.executor_kind === 'panel_agent' ? turn.panel_agent_id : turn.member_id,
        context: turn.context,
        peer: turn.peer ?? null,
      },
      nativeTurnRefs: this.all('SELECT ref FROM native_turn_refs WHERE turn_id=? ORDER BY rowid', id).map(row => row.ref),
      inputMessages: this.all('SELECT m.id,m.kind,i.ordinal FROM turn_inputs i JOIN messages m ON m.id=i.message_id WHERE i.turn_id=? ORDER BY i.ordinal', id),
      outgoingMessages: this.all('SELECT message_id,event_seq,call_id,native_call_id FROM message_origins WHERE turn_id=? ORDER BY rowid', id),
      ...deriveCurrentModel(observations),
      modelObservations: observations,
      events,
      nextAfter: events.at(-1)?.seq ?? after,
    };
  }
  close() { this.db.close(); }
}
