// v1 schema fixture（2026-11-03 生成，来自 92367b5 + P0 版本号改造前的 schema）。
//
// 用途:迁移测试必须从一个"旧的、不再随代码演进"的库开始。此文件是静态快照，
// 不要随 store.mjs 的表结构变化修改；v2 迁移用例只依赖这里的 v1 形状。
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

export const LEGACY_V1_DDL = [
  `CREATE TABLE agent_tasks(owner_id TEXT NOT NULL,group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,tasks TEXT NOT NULL,updated TEXT NOT NULL,PRIMARY KEY(owner_id,group_id))`,
  `CREATE TABLE attached(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,outbox_id TEXT NOT NULL REFERENCES outbox(id) ON DELETE CASCADE)`,
  `CREATE TABLE attachment_settings(singleton INTEGER PRIMARY KEY CHECK(singleton=1),max_file_bytes INTEGER NOT NULL,max_files INTEGER NOT NULL,max_image_pixels INTEGER NOT NULL,updated TEXT NOT NULL)`,
  `CREATE TABLE attachments(id TEXT PRIMARY KEY,panel_agent_id TEXT NOT NULL REFERENCES panel_agents(id) ON DELETE CASCADE,original_name TEXT NOT NULL,media_type TEXT NOT NULL CHECK(media_type IN ('text/plain','image/png','image/jpeg')),size INTEGER NOT NULL,storage_name TEXT NOT NULL,created_at TEXT NOT NULL,panel_message_id TEXT REFERENCES panel_messages(id) ON DELETE CASCADE,ordinal INTEGER)`,
  `CREATE TABLE endpoint_context_formats(
        endpoint_id TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
        session_key TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        source TEXT NOT NULL,
        created TEXT NOT NULL,
        updated TEXT NOT NULL,
        PRIMARY KEY(endpoint_id,session_key)
      )`,
  `CREATE TABLE endpoint_policy(endpoint_id TEXT PRIMARY KEY REFERENCES endpoints(id) ON DELETE CASCADE,signature TEXT NOT NULL)`,
  `CREATE TABLE endpoint_session_bindings(endpoint_id TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,session_key TEXT NOT NULL,session TEXT NOT NULL,updated TEXT NOT NULL,PRIMARY KEY(endpoint_id,session_key))`,
  `CREATE TABLE endpoint_session_policies(endpoint_id TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,session_key TEXT NOT NULL,signature TEXT NOT NULL,PRIMARY KEY(endpoint_id,session_key))`,
  `CREATE TABLE endpoints(id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,context TEXT NOT NULL,peer TEXT,session TEXT,key TEXT NOT NULL,UNIQUE(member_id,context))`,
  `CREATE TABLE global_model_policy(singleton INTEGER PRIMARY KEY CHECK(singleton=1),mode TEXT NOT NULL,rules TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL, preset_id TEXT)`,
  `CREATE TABLE groups(id TEXT PRIMARY KEY,name TEXT NOT NULL,workspace TEXT NOT NULL,lead TEXT,created TEXT NOT NULL,charter TEXT,policy TEXT NOT NULL DEFAULT 'workspace-write',allow_shell INTEGER NOT NULL DEFAULT 1, state TEXT)`,
  `CREATE TABLE history(seq INTEGER PRIMARY KEY AUTOINCREMENT,endpoint_id TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,event TEXT NOT NULL,created TEXT NOT NULL, turn_id TEXT REFERENCES turns(id) ON DELETE CASCADE)`,
  `CREATE TABLE information_measurements(
        id TEXT PRIMARY KEY,
        group_id TEXT,
        endpoint_id TEXT NOT NULL,
        turn_id TEXT,
        kind TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        bytes INTEGER NOT NULL,
        detail TEXT NOT NULL,
        created TEXT NOT NULL
      )`,
  `CREATE TABLE interactions(id TEXT PRIMARY KEY,group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,member_id TEXT REFERENCES members(id) ON DELETE CASCADE,panel_agent_id TEXT REFERENCES panel_agents(id) ON DELETE CASCADE,endpoint_id TEXT,context TEXT NOT NULL,turn_id TEXT NOT NULL,call_id TEXT NOT NULL,message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,panel_message_id TEXT,kind TEXT NOT NULL CHECK(kind IN ('choice','input','takeover','handback','group_create','group_add','group_delete','member_model')),payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','answered','cancelled','failed')),answer TEXT,detail TEXT,answer_message_id TEXT,created TEXT NOT NULL,answered TEXT)`,
  `CREATE TABLE members(id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,name TEXT NOT NULL,host TEXT NOT NULL,role TEXT NOT NULL,profile TEXT NOT NULL DEFAULT '',removed TEXT, model_provider TEXT, model TEXT, reasoning_effort TEXT,UNIQUE(group_id,name))`,
  `CREATE TABLE message_origins(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,event_seq INTEGER REFERENCES history(seq) ON DELETE SET NULL,call_id TEXT NOT NULL,native_call_id TEXT)`,
  `CREATE TABLE messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,sender TEXT NOT NULL,recipient TEXT NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL,reply_to TEXT,created TEXT NOT NULL)`,
  `CREATE TABLE model_policy_presets(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,mode TEXT NOT NULL,rules TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL)`,
  `CREATE TABLE native_turn_refs(turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,ref TEXT NOT NULL,PRIMARY KEY(turn_id,ref))`,
  `CREATE TABLE outbox(id TEXT PRIMARY KEY,endpoint_id TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,payload TEXT NOT NULL,accepted TEXT,error TEXT)`,
  `CREATE TABLE panel_agents(id TEXT PRIMARY KEY,singleton INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK(singleton=1),name TEXT NOT NULL,host TEXT NOT NULL,model_provider TEXT,model TEXT,reasoning_effort TEXT,workspace TEXT,access TEXT NOT NULL DEFAULT 'read-only' CHECK(access IN ('read-only','workspace-write','full-access')),created TEXT NOT NULL,updated TEXT NOT NULL)`,
  `CREATE TABLE panel_attached(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,outbox_id TEXT NOT NULL REFERENCES panel_outbox(id) ON DELETE CASCADE)`,
  `CREATE TABLE panel_history(seq INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL REFERENCES panel_sessions(id) ON DELETE CASCADE,turn_id TEXT,event TEXT NOT NULL,created TEXT NOT NULL)`,
  `CREATE TABLE panel_message_origins(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,turn_id TEXT NOT NULL REFERENCES panel_turns(id) ON DELETE CASCADE,event_seq INTEGER REFERENCES panel_history(seq) ON DELETE SET NULL,call_id TEXT NOT NULL,native_call_id TEXT)`,
  `CREATE TABLE panel_message_requests(panel_agent_id TEXT NOT NULL REFERENCES panel_agents(id) ON DELETE CASCADE,client_message_id TEXT NOT NULL,payload_hash TEXT NOT NULL,panel_message_id TEXT NOT NULL REFERENCES panel_messages(id) ON DELETE CASCADE,created_at TEXT NOT NULL,PRIMARY KEY(panel_agent_id,client_message_id))`,
  `CREATE TABLE panel_messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,panel_agent_id TEXT NOT NULL REFERENCES panel_agents(id) ON DELETE CASCADE,context TEXT NOT NULL CHECK(context IN ('private','coordination')),role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),text TEXT NOT NULL,active_team_id TEXT,created TEXT NOT NULL)`,
  `CREATE TABLE panel_outbox(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES panel_sessions(id) ON DELETE CASCADE,payload TEXT NOT NULL,accepted TEXT,error TEXT)`,
  `CREATE TABLE panel_session_context_formats(
        session_id TEXT PRIMARY KEY REFERENCES panel_sessions(id) ON DELETE CASCADE,
        schema_version INTEGER NOT NULL,
        source TEXT NOT NULL,
        created TEXT NOT NULL,
        updated TEXT NOT NULL
      )`,
  `CREATE TABLE panel_sessions(id TEXT PRIMARY KEY,panel_agent_id TEXT NOT NULL REFERENCES panel_agents(id) ON DELETE CASCADE,context TEXT NOT NULL CHECK(context IN ('private','coordination')),group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,session TEXT,policy_signature TEXT,key TEXT NOT NULL UNIQUE,created TEXT NOT NULL,updated TEXT NOT NULL)`,
  `CREATE TABLE panel_team_bindings(panel_agent_id TEXT NOT NULL REFERENCES panel_agents(id) ON DELETE CASCADE,group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,relation TEXT NOT NULL CHECK(relation IN ('observer','main')),created TEXT NOT NULL,updated TEXT NOT NULL,PRIMARY KEY(panel_agent_id,group_id))`,
  `CREATE TABLE panel_turn_inputs(turn_id TEXT NOT NULL REFERENCES panel_turns(id) ON DELETE CASCADE,message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,PRIMARY KEY(turn_id,message_id))`,
  `CREATE TABLE panel_turns(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES panel_sessions(id) ON DELETE CASCADE,panel_agent_id TEXT NOT NULL REFERENCES panel_agents(id) ON DELETE CASCADE,context TEXT NOT NULL,group_id TEXT,active_team_id TEXT,state TEXT NOT NULL,created TEXT NOT NULL,ended TEXT, source_user_message_id TEXT)`,
  `CREATE TABLE panel_updates(id TEXT PRIMARY KEY,panel_agent_id TEXT NOT NULL REFERENCES panel_agents(id) ON DELETE CASCADE,group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,source_turn_id TEXT REFERENCES panel_turns(id) ON DELETE SET NULL,kind TEXT NOT NULL DEFAULT 'update' CHECK(kind IN ('update','continuation')),text TEXT NOT NULL,source_message_ids TEXT NOT NULL DEFAULT '[]',created TEXT NOT NULL,delivered_turn_id TEXT,delivered TEXT)`,
  `CREATE TABLE role_names(group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,name_key TEXT NOT NULL,member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,PRIMARY KEY(group_id,name_key))`,
  `CREATE TABLE runtime_attempts(turn_id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,endpoint_id TEXT NOT NULL,state TEXT NOT NULL,policy TEXT NOT NULL,detail TEXT,created TEXT NOT NULL,ended TEXT)`,
  `CREATE TABLE team_creation_requests(operation_id TEXT PRIMARY KEY,payload TEXT NOT NULL,group_id TEXT REFERENCES groups(id) ON DELETE SET NULL)`,
  `CREATE TABLE team_directive_requests(
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      operation_id TEXT NOT NULL,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      PRIMARY KEY(group_id,operation_id)
    )`,
  `CREATE TABLE team_lead_controllers(group_id TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,controller_kind TEXT NOT NULL CHECK(controller_kind IN ('member','panel_agent')),controller_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('active','suspended')),original_lead_id TEXT,revision INTEGER NOT NULL DEFAULT 1,updated TEXT NOT NULL)`,
  `CREATE TABLE team_model_policy(group_id TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,mode TEXT NOT NULL,rules TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL)`,
  `CREATE TABLE team_request_receipts(
        seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,
        request_id TEXT NOT NULL REFERENCES team_requests(id) ON DELETE CASCADE, source_turn_id TEXT NOT NULL,
        operation_id TEXT NOT NULL, text TEXT NOT NULL, source_message_ids TEXT NOT NULL,
        created TEXT NOT NULL,UNIQUE(request_id,operation_id))`,
  `CREATE TABLE team_requests(
        id TEXT PRIMARY KEY, panel_agent_id TEXT NOT NULL REFERENCES panel_agents(id) ON DELETE CASCADE,
        source_user_message_id TEXT NOT NULL REFERENCES panel_messages(id) ON DELETE CASCADE,
        source_turn_id TEXT NOT NULL REFERENCES panel_turns(id) ON DELETE CASCADE, call_id TEXT,
        group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE, controller_id TEXT NOT NULL,
        operation_id TEXT NOT NULL, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        original_text TEXT NOT NULL, text TEXT NOT NULL, created TEXT NOT NULL,
        UNIQUE(panel_agent_id,source_user_message_id,operation_id))`,
  `CREATE TABLE telemetry_observations(
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
        )`,
  `CREATE TABLE telemetry_session_generations(
          endpoint_id TEXT NOT NULL,
          session_key TEXT NOT NULL,
          generation INTEGER NOT NULL DEFAULT 0,
          updated TEXT NOT NULL,
          PRIMARY KEY(endpoint_id,session_key)
        )`,
  `CREATE TABLE theme_packs(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,light TEXT NOT NULL,dark TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL)`,
  `CREATE TABLE turn_context_schemas(
        turn_id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        session_key TEXT,
        created TEXT NOT NULL
      )`,
  `CREATE TABLE turn_inputs(turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,PRIMARY KEY(turn_id,message_id))`,
  `CREATE TABLE turns(id TEXT PRIMARY KEY,endpoint_id TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,session TEXT,created TEXT NOT NULL)`,
  `CREATE INDEX agent_tasks_group ON agent_tasks(group_id)`,
  `CREATE INDEX attachments_agent ON attachments(panel_agent_id)`,
  `CREATE INDEX attachments_message ON attachments(panel_message_id)`,
  `CREATE INDEX history_endpoint ON history(endpoint_id,seq)`,
  `CREATE INDEX history_turn ON history(turn_id,seq)`,
  `CREATE INDEX information_measurements_group ON information_measurements(group_id,created)`,
  `CREATE INDEX information_measurements_turn ON information_measurements(turn_id,kind)`,
  `CREATE INDEX inputs_message ON turn_inputs(message_id)`,
  `CREATE INDEX interactions_group ON interactions(group_id,created)`,
  `CREATE INDEX interactions_panel ON interactions(panel_agent_id,created)`,
  `CREATE INDEX messages_group ON messages(group_id,seq)`,
  `CREATE INDEX messages_inbox ON messages(recipient,seq)`,
  `CREATE UNIQUE INDEX panel_coordination_session ON panel_sessions(panel_agent_id,group_id) WHERE context='coordination'`,
  `CREATE INDEX panel_history_session ON panel_history(session_id,seq)`,
  `CREATE INDEX panel_history_turn ON panel_history(turn_id,seq)`,
  `CREATE INDEX panel_messages_agent ON panel_messages(panel_agent_id,seq)`,
  `CREATE UNIQUE INDEX panel_private_session ON panel_sessions(panel_agent_id) WHERE context='private'`,
  `CREATE INDEX panel_updates_pending ON panel_updates(panel_agent_id,group_id,delivered_turn_id,created)`,
  `CREATE INDEX runtime_group ON runtime_attempts(group_id,state)`,
  `CREATE INDEX team_request_receipts_request ON team_request_receipts(request_id,seq)`,
  `CREATE INDEX team_requests_agent ON team_requests(panel_agent_id,created)`,
  `CREATE INDEX team_requests_group ON team_requests(group_id,created)`,
  `CREATE INDEX telemetry_observations_group ON telemetry_observations(group_id,observed_at)`,
];

export function createLegacyV1(directory) {
  const db = new DatabaseSync(join(directory, 'groups.sqlite'));
  db.exec('PRAGMA foreign_keys=ON');
  for (const statement of LEGACY_V1_DDL) db.exec(statement);
  db.exec('PRAGMA user_version=0');
  return db;
}
