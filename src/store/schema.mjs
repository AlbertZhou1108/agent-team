import { DEFAULT_USER_MODEL_RULES } from '../model-policy.mjs';

// 数据目录的 schema 版本；迁移按版本逐级执行，过新版本拒绝打开。
export const SCHEMA_VERSION = 25;

// 团队历史名称的规范化键：NFKC + trim + 小写；种子与 Collaboration 共用同一实现。
export function roleNameKey(name) {
  return name.normalize('NFKC').trim().toLowerCase();
}

// 以下 DDL 由「旧路径（upgradeFromV1 → migrate 全阶梯）在新库上的最终产物」逐字导出，
// 新库直建时按原顺序执行，保证与迁移路径生成完全一致的 sqlite_master 形状。
const CURRENT_TABLES = `CREATE TABLE agent_tasks(owner_id TEXT NOT NULL,group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,tasks TEXT NOT NULL,updated TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(owner_id,group_id));
CREATE TABLE archive_snapshots(
      group_id TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
      id TEXT NOT NULL UNIQUE,created TEXT NOT NULL,facts TEXT NOT NULL,
      summary TEXT,summary_created TEXT,error TEXT);
CREATE TABLE attached(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,outbox_id TEXT NOT NULL REFERENCES outbox(id) ON DELETE CASCADE);
CREATE TABLE attachment_settings(singleton INTEGER PRIMARY KEY CHECK(singleton=1),max_file_bytes INTEGER NOT NULL,max_files INTEGER NOT NULL,max_image_pixels INTEGER NOT NULL,updated TEXT NOT NULL);
CREATE TABLE attachments(id TEXT PRIMARY KEY,panel_agent_id TEXT NOT NULL REFERENCES panel_agents(id) ON DELETE CASCADE,original_name TEXT NOT NULL,media_type TEXT NOT NULL CHECK(media_type IN ('text/plain','image/png','image/jpeg')),size INTEGER NOT NULL,storage_name TEXT NOT NULL,created_at TEXT NOT NULL,panel_message_id TEXT REFERENCES panel_messages(id) ON DELETE CASCADE,ordinal INTEGER);
CREATE TABLE conversation_session_meta(conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,session_key TEXT NOT NULL,session TEXT,session_updated TEXT,policy_signature TEXT,schema_version INTEGER,format_source TEXT,format_created TEXT,format_updated TEXT,PRIMARY KEY(conversation_id,session_key));
CREATE TABLE conversations(id TEXT PRIMARY KEY,group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,member_id TEXT REFERENCES members(id) ON DELETE CASCADE,panel_agent_id TEXT REFERENCES panel_agents(id) ON DELETE CASCADE,context TEXT NOT NULL,peer TEXT,session TEXT,policy_signature TEXT,key TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL,CHECK((member_id IS NULL)!=(panel_agent_id IS NULL)));
CREATE TABLE "desktop_applications"(
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK(kind IN ('codex','dsh','claude','zcode')),
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
CREATE TABLE external_client_bindings(id TEXT PRIMARY KEY,principal_id TEXT NOT NULL REFERENCES external_principals(id) ON DELETE CASCADE,name TEXT NOT NULL,host TEXT NOT NULL,command TEXT,wake_config TEXT,key_hash TEXT NOT NULL UNIQUE,session TEXT,declared_capabilities TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),created TEXT NOT NULL,updated TEXT NOT NULL,last_seen TEXT, wake_state TEXT NOT NULL DEFAULT 'unverified', wake_mode TEXT, wake_reason TEXT, wake_fingerprint TEXT, wake_verified_at TEXT, wake_attempts INTEGER NOT NULL DEFAULT 0, wake_next_attempt TEXT, pull_only_accepted TEXT, app_id TEXT, surface TEXT NOT NULL DEFAULT 'cli' CHECK(surface IN ('cli','desktop')), controller_cwd TEXT, controller_cwd_updated TEXT, binding_kind TEXT NOT NULL DEFAULT 'conversation' CHECK(binding_kind IN ('conversation','activation')),UNIQUE(principal_id,name));
CREATE TABLE external_decisions(id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,requester_member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,controller_principal_id TEXT NOT NULL REFERENCES external_principals(id) ON DELETE CASCADE,request_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','answered','cancelled')),answer TEXT,answered_by_binding_id TEXT REFERENCES external_client_bindings(id) ON DELETE SET NULL,created TEXT NOT NULL,answered TEXT);
CREATE TABLE external_deliveries(id TEXT PRIMARY KEY,principal_id TEXT NOT NULL REFERENCES external_principals(id) ON DELETE CASCADE,group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,binding_id TEXT REFERENCES external_client_bindings(id) ON DELETE SET NULL,state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','delivered','error')),wake_state TEXT NOT NULL DEFAULT 'pending' CHECK(wake_state IN ('pending','sending','sent','unsupported','error')),wake_error TEXT,wake_updated TEXT,payload TEXT NOT NULL,created TEXT NOT NULL,delivered TEXT,error TEXT);
CREATE TABLE external_principals(id TEXT PRIMARY KEY,name TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL);
CREATE TABLE groups(id TEXT PRIMARY KEY,name TEXT NOT NULL,workspace TEXT NOT NULL,lead TEXT,created TEXT NOT NULL,charter TEXT,policy TEXT NOT NULL DEFAULT 'workspace-write',allow_shell INTEGER NOT NULL DEFAULT 1, state TEXT, workspace_pending TEXT, workspace_revision INTEGER NOT NULL DEFAULT 0);
CREATE TABLE history(seq INTEGER PRIMARY KEY AUTOINCREMENT,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,event TEXT NOT NULL,created TEXT NOT NULL,turn_id TEXT);
CREATE TABLE home_summaries(id TEXT PRIMARY KEY,panel_agent_id TEXT NOT NULL REFERENCES panel_agents(id) ON DELETE CASCADE,text TEXT NOT NULL,created TEXT NOT NULL);
CREATE TABLE interactions(id TEXT PRIMARY KEY,group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,member_id TEXT REFERENCES members(id) ON DELETE CASCADE,panel_agent_id TEXT REFERENCES panel_agents(id) ON DELETE CASCADE,conversation_id TEXT,context TEXT NOT NULL,turn_id TEXT NOT NULL,call_id TEXT NOT NULL,message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,panel_message_id TEXT,kind TEXT NOT NULL CHECK(kind IN ('choice','input','flow','takeover','handback','group_create','group_add','group_delete','member_model')),payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','answered','cancelled','failed')),answer TEXT,detail TEXT,answer_message_id TEXT,created TEXT NOT NULL,answered TEXT);
CREATE TABLE members(id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,name TEXT NOT NULL,host TEXT NOT NULL,role TEXT NOT NULL,profile TEXT NOT NULL DEFAULT '',removed TEXT, model_provider TEXT, model TEXT, reasoning_effort TEXT, effective_policy TEXT, capabilities TEXT NOT NULL DEFAULT '[]', capability_reason TEXT,UNIQUE(group_id,name));
CREATE TABLE message_origins(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,event_seq INTEGER REFERENCES history(seq) ON DELETE SET NULL,call_id TEXT NOT NULL,native_call_id TEXT);
CREATE TABLE message_step_refs(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,plan_id TEXT NOT NULL,step_id TEXT NOT NULL);
CREATE TABLE messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,sender TEXT NOT NULL,recipient TEXT NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL,reply_to TEXT,created TEXT NOT NULL, awaiting INTEGER NOT NULL DEFAULT 0, expects_reply INTEGER NOT NULL DEFAULT 0, required_capabilities TEXT NOT NULL DEFAULT '[]', min_context_window INTEGER DEFAULT NULL);
CREATE TABLE model_policy_presets(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,mode TEXT NOT NULL,rules TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL);
CREATE TABLE native_turn_refs(turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,ref TEXT NOT NULL,PRIMARY KEY(turn_id,ref));
CREATE TABLE note_tags(
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, color TEXT,
        created TEXT NOT NULL);
CREATE TABLE notes(
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
      archived TEXT, source_team_id TEXT, tags TEXT NOT NULL DEFAULT '[]', pinned_at TEXT);
CREATE TABLE operation_records(scope TEXT NOT NULL,scope_id TEXT NOT NULL DEFAULT '',client_key TEXT NOT NULL,payload TEXT,ref TEXT,created TEXT NOT NULL,PRIMARY KEY(scope,scope_id,client_key));
CREATE TABLE outbox(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,payload TEXT NOT NULL,accepted TEXT,error TEXT);
CREATE TABLE panel_agents(id TEXT PRIMARY KEY,singleton INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK(singleton=1),name TEXT NOT NULL,host TEXT NOT NULL,model_provider TEXT,model TEXT,reasoning_effort TEXT,workspace TEXT,access TEXT NOT NULL DEFAULT 'read-only' CHECK(access IN ('read-only','workspace-write','full-access')),created TEXT NOT NULL,updated TEXT NOT NULL);
CREATE TABLE panel_messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,panel_agent_id TEXT NOT NULL REFERENCES panel_agents(id) ON DELETE CASCADE,context TEXT NOT NULL CHECK(context IN ('private','coordination')),role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),text TEXT NOT NULL,active_team_id TEXT,created TEXT NOT NULL, receipt_id TEXT);
CREATE TABLE panel_team_bindings(panel_agent_id TEXT NOT NULL REFERENCES panel_agents(id) ON DELETE CASCADE,group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,relation TEXT NOT NULL CHECK(relation IN ('observer','main')),created TEXT NOT NULL,updated TEXT NOT NULL,PRIMARY KEY(panel_agent_id,group_id));
CREATE TABLE panel_updates(id TEXT PRIMARY KEY,panel_agent_id TEXT NOT NULL REFERENCES panel_agents(id) ON DELETE CASCADE,group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,source_turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,kind TEXT NOT NULL DEFAULT 'update' CHECK(kind IN ('update','continuation')),text TEXT NOT NULL,source_message_ids TEXT NOT NULL DEFAULT '[]',created TEXT NOT NULL,delivered_turn_id TEXT,delivered TEXT);
CREATE TABLE plan_events(id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,plan_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('frozen','step_cancelled')),owner_id TEXT,revision INTEGER,payload TEXT NOT NULL,created TEXT NOT NULL);
CREATE TABLE read_watermarks(
        scope TEXT NOT NULL CHECK(scope IN ('group','panel')),
        scope_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        updated TEXT NOT NULL,
        PRIMARY KEY(scope,scope_id));
CREATE TABLE team_controller_relations(
          group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
          binding_id TEXT NOT NULL REFERENCES external_client_bindings(id) ON DELETE CASCADE,
          principal_id TEXT NOT NULL REFERENCES external_principals(id) ON DELETE CASCADE,
          origin TEXT NOT NULL DEFAULT 'takeover' CHECK(origin IN ('creator','takeover')),
          revision INTEGER NOT NULL DEFAULT 1,
          created TEXT NOT NULL,
          updated TEXT NOT NULL,
          PRIMARY KEY(group_id,binding_id));
CREATE TABLE team_lead_controllers(group_id TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,controller_kind TEXT NOT NULL CHECK(controller_kind IN ('member','panel_agent','external_agent')),controller_id TEXT NOT NULL,controller_binding_id TEXT,state TEXT NOT NULL CHECK(state IN ('active','suspended')),original_lead_id TEXT,revision INTEGER NOT NULL DEFAULT 1,updated TEXT NOT NULL);
CREATE TABLE telemetry_observations(
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
CREATE TABLE telemetry_session_generations(
          endpoint_id TEXT NOT NULL,
          session_key TEXT NOT NULL,
          generation INTEGER NOT NULL DEFAULT 0,
          updated TEXT NOT NULL,
          PRIMARY KEY(endpoint_id,session_key)
        );
CREATE TABLE theme_packs(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,light TEXT NOT NULL,dark TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL);
CREATE TABLE turn_inputs(turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,PRIMARY KEY(turn_id,message_id));
CREATE TABLE turns(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,executor_kind TEXT NOT NULL,executor_id TEXT NOT NULL,group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,session TEXT,active_team_id TEXT,source_user_message_id TEXT,state TEXT NOT NULL,detail TEXT,created TEXT NOT NULL,ended TEXT);
CREATE TABLE workbench_dismissals(category TEXT NOT NULL,item_id TEXT NOT NULL,created TEXT NOT NULL,PRIMARY KEY(category,item_id));
CREATE TABLE workspace_events(
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK(kind IN ('pending','applied','cancelled')),
          from_path TEXT,
          to_path TEXT,
          revision INTEGER,
          detail TEXT,
          created TEXT NOT NULL);`;
const CURRENT_INDEXES = `CREATE INDEX agent_tasks_group ON agent_tasks(group_id);
CREATE INDEX attachments_agent ON attachments(panel_agent_id);
CREATE INDEX attachments_message ON attachments(panel_message_id);
CREATE INDEX conversations_group ON conversations(group_id);
CREATE UNIQUE INDEX conversations_member ON conversations(member_id,context) WHERE member_id IS NOT NULL;
CREATE UNIQUE INDEX conversations_panel_coordination ON conversations(panel_agent_id,group_id) WHERE panel_agent_id IS NOT NULL AND context='coordination';
CREATE UNIQUE INDEX conversations_panel_private ON conversations(panel_agent_id) WHERE panel_agent_id IS NOT NULL AND context='private';
CREATE INDEX external_bindings_principal ON external_client_bindings(principal_id,status);
CREATE INDEX external_decisions_pending ON external_decisions(group_id,state,created);
CREATE INDEX external_deliveries_pending ON external_deliveries(principal_id,state,created);
CREATE INDEX history_conversation ON history(conversation_id,seq);
CREATE INDEX history_turn ON history(turn_id,seq);
CREATE INDEX home_summaries_agent ON home_summaries(panel_agent_id,created DESC);
CREATE INDEX inputs_message ON turn_inputs(message_id);
CREATE INDEX interactions_group ON interactions(group_id,created);
CREATE INDEX interactions_panel ON interactions(panel_agent_id,created);
CREATE INDEX messages_awaiting ON messages(seq) WHERE awaiting=1;
CREATE INDEX messages_expects_reply ON messages(seq) WHERE expects_reply=1;
CREATE INDEX messages_group ON messages(group_id,seq);
CREATE INDEX messages_inbox ON messages(recipient,seq);
CREATE INDEX messages_reply_to ON messages(reply_to) WHERE reply_to IS NOT NULL;
CREATE INDEX notes_archived ON notes(archived DESC) WHERE state='archived';
CREATE INDEX notes_pinned ON notes(pinned_at DESC) WHERE pinned_at IS NOT NULL;
CREATE INDEX notes_source_team ON notes(source_team_id, updated DESC);
CREATE INDEX notes_state ON notes(state, updated DESC);
CREATE INDEX operation_records_ref ON operation_records(scope,ref);
CREATE INDEX outbox_pending ON outbox(accepted) WHERE accepted IS NULL;
CREATE INDEX panel_messages_agent ON panel_messages(panel_agent_id,seq);
CREATE INDEX panel_updates_pending ON panel_updates(panel_agent_id,group_id,delivered_turn_id,created);
CREATE INDEX plan_events_group ON plan_events(group_id,plan_id,created);
CREATE INDEX team_controller_relations_binding ON team_controller_relations(binding_id);
CREATE INDEX telemetry_observations_group ON telemetry_observations(group_id,observed_at);
CREATE INDEX turns_conversation ON turns(conversation_id,created);
CREATE INDEX turns_group_state ON turns(group_id,state);
CREATE INDEX turns_state ON turns(state);
CREATE INDEX workspace_events_group ON workspace_events(group_id,seq);`;

// 这些表此前由 Collaboration / TeamRequests / Information 惰性建表；
// 收归 Store 后，单独 new Store(dir) 即得到完整 v24 表结构。
const AUXILIARY_TABLES = `CREATE TABLE IF NOT EXISTS global_model_policy(singleton INTEGER PRIMARY KEY CHECK(singleton=1),mode TEXT NOT NULL,rules TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS team_model_policy(group_id TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,mode TEXT NOT NULL,rules TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS role_names(group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,name_key TEXT NOT NULL,member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,PRIMARY KEY(group_id,name_key));
CREATE TABLE IF NOT EXISTS team_requests(
        id TEXT PRIMARY KEY, panel_agent_id TEXT NOT NULL REFERENCES panel_agents(id) ON DELETE CASCADE,
        source_user_message_id TEXT NOT NULL REFERENCES panel_messages(id) ON DELETE CASCADE,
        source_turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE, call_id TEXT,
        group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE, controller_id TEXT NOT NULL,
        operation_id TEXT NOT NULL, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        original_text TEXT NOT NULL, text TEXT NOT NULL, created TEXT NOT NULL,
        UNIQUE(panel_agent_id,source_user_message_id,operation_id));
CREATE TABLE IF NOT EXISTS team_request_receipts(
        seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,
        request_id TEXT NOT NULL REFERENCES team_requests(id) ON DELETE CASCADE, source_turn_id TEXT NOT NULL,
        operation_id TEXT NOT NULL, text TEXT NOT NULL, source_message_ids TEXT NOT NULL,
        created TEXT NOT NULL,UNIQUE(request_id,operation_id));
CREATE TABLE IF NOT EXISTS information_measurements(
        id TEXT PRIMARY KEY,
        group_id TEXT,
        endpoint_id TEXT NOT NULL,
        turn_id TEXT,
        kind TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        bytes INTEGER NOT NULL,
        detail TEXT NOT NULL,
        created TEXT NOT NULL
      );
CREATE TABLE IF NOT EXISTS turn_context_schemas(
        turn_id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        session_key TEXT,
        created TEXT NOT NULL
      );`;
const AUXILIARY_INDEXES = `CREATE INDEX IF NOT EXISTS team_requests_agent ON team_requests(panel_agent_id,created);
CREATE INDEX IF NOT EXISTS team_requests_group ON team_requests(group_id,created);
CREATE INDEX IF NOT EXISTS team_request_receipts_request ON team_request_receipts(request_id,seq);
CREATE INDEX IF NOT EXISTS information_measurements_turn ON information_measurements(turn_id,kind);
CREATE INDEX IF NOT EXISTS information_measurements_group ON information_measurements(group_id,created);`;

function ensureGlobalModelPolicyPresetColumn(store) {
  if (!store.all('PRAGMA table_info(global_model_policy)').some(column => column.name === 'preset_id')) {
    store.db.exec('ALTER TABLE global_model_policy ADD COLUMN preset_id TEXT');
  }
}

// 新库：一次性直建当前版本全部表与索引，跳过历史阶梯。
export function ensureCurrentSchema(store) {
  store.db.exec(CURRENT_TABLES);
  store.db.exec(CURRENT_INDEXES);
  store.db.exec(AUXILIARY_TABLES);
  store.db.exec(AUXILIARY_INDEXES);
  ensureGlobalModelPolicyPresetColumn(store);
}

// 旧库：迁移阶梯跑完后幂等补齐惰性表与历史列（老库可能从未构造过对应服务）。
export function ensureAuxiliarySchema(store) {
  store.db.exec(AUXILIARY_TABLES);
  store.db.exec(AUXILIARY_INDEXES);
  ensureGlobalModelPolicyPresetColumn(store);
}

export function ensureV2Schema(store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,member_id TEXT REFERENCES members(id) ON DELETE CASCADE,panel_agent_id TEXT REFERENCES panel_agents(id) ON DELETE CASCADE,context TEXT NOT NULL,peer TEXT,session TEXT,policy_signature TEXT,key TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL,CHECK((member_id IS NULL)!=(panel_agent_id IS NULL)));
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
      CREATE TABLE IF NOT EXISTS interactions(id TEXT PRIMARY KEY,group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,member_id TEXT REFERENCES members(id) ON DELETE CASCADE,panel_agent_id TEXT REFERENCES panel_agents(id) ON DELETE CASCADE,conversation_id TEXT,context TEXT NOT NULL,turn_id TEXT NOT NULL,call_id TEXT NOT NULL,message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,panel_message_id TEXT,kind TEXT NOT NULL CHECK(kind IN ('choice','input','flow','takeover','handback','group_create','group_add','group_delete','member_model')),payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','answered','cancelled','failed')),answer TEXT,detail TEXT,answer_message_id TEXT,created TEXT NOT NULL,answered TEXT);
      CREATE INDEX IF NOT EXISTS interactions_group ON interactions(group_id,created);
      CREATE INDEX IF NOT EXISTS interactions_panel ON interactions(panel_agent_id,created);
      CREATE TABLE IF NOT EXISTS home_summaries(id TEXT PRIMARY KEY,panel_agent_id TEXT NOT NULL REFERENCES panel_agents(id) ON DELETE CASCADE,text TEXT NOT NULL,created TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS home_summaries_agent ON home_summaries(panel_agent_id,created DESC);`);
  }

  // v1 -> v2:会话、回合、输入、历史、来源、投递队列各合并为单表。
  // SQLite 在 foreign_keys=OFF 时仍会改写 REFERENCES(实测)，必须同时 legacy_alter_table=ON；
  // 旧历史 seq 保持不变，Panel 历史整体平移到成员历史之后，并同步修正其 origins.event_seq。

// Store 构造末尾统一补齐模型策略单行与历史角色名称（原 Collaboration 构造期职责）。
export function seedGlobalModelPolicyAndRoleNames(store) {
  if (!store.get('SELECT 1 FROM global_model_policy WHERE singleton=1')) {
    const legacy = store.get('SELECT mode,rules,created,updated FROM team_model_policy ORDER BY updated DESC LIMIT 1');
    store.run(
      'INSERT INTO global_model_policy(singleton,mode,rules,created,updated) VALUES(1,?,?,?,?)',
      legacy?.mode ?? 'user',
      legacy?.rules ?? DEFAULT_USER_MODEL_RULES,
      legacy?.created ?? new Date().toISOString(),
      legacy?.updated ?? new Date().toISOString(),
    );
  }
  for (const member of store.all('SELECT id,group_id,name FROM members ORDER BY rowid')) {
    const key = roleNameKey(member.name);
    const prior = store.get('SELECT member_id FROM role_names WHERE group_id=? AND name_key=?', member.group_id, key);
    if (prior && prior.member_id !== member.id) throw new Error('历史成员名称规范化后重复，无法安全迁移角色名称');
    store.run('INSERT OR IGNORE INTO role_names(group_id,name_key,member_id) VALUES(?,?,?)', member.group_id, key, member.id);
  }
}
