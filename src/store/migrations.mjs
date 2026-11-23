import { SCHEMA_VERSION, ensureV2Schema } from './schema.mjs';

// 旧数据目录的逐级迁移：建表只在 schema.mjs，这里只搬运数据与形状；
// Store 构造时对非新库按版本阶梯回放，新库不经过本模块。

export function upgradeFromV1(store) {
    store.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
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
      CREATE TABLE IF NOT EXISTS team_lead_controllers(group_id TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,controller_kind TEXT NOT NULL CHECK(controller_kind IN ('member','panel_agent','external_agent')),controller_id TEXT NOT NULL,controller_binding_id TEXT,state TEXT NOT NULL CHECK(state IN ('active','suspended')),original_lead_id TEXT,revision INTEGER NOT NULL DEFAULT 1,updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS external_principals(id TEXT PRIMARY KEY,name TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS external_client_bindings(id TEXT PRIMARY KEY,principal_id TEXT NOT NULL REFERENCES external_principals(id) ON DELETE CASCADE,name TEXT NOT NULL,host TEXT NOT NULL,command TEXT,wake_config TEXT,key_hash TEXT NOT NULL UNIQUE,session TEXT,declared_capabilities TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),created TEXT NOT NULL,updated TEXT NOT NULL,last_seen TEXT,UNIQUE(principal_id,name));
      CREATE INDEX IF NOT EXISTS external_bindings_principal ON external_client_bindings(principal_id,status);
      CREATE TABLE IF NOT EXISTS external_deliveries(id TEXT PRIMARY KEY,principal_id TEXT NOT NULL REFERENCES external_principals(id) ON DELETE CASCADE,group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,binding_id TEXT REFERENCES external_client_bindings(id) ON DELETE SET NULL,state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','delivered','error')),wake_state TEXT NOT NULL DEFAULT 'pending' CHECK(wake_state IN ('pending','sending','sent','unsupported','error')),wake_error TEXT,wake_updated TEXT,payload TEXT NOT NULL,created TEXT NOT NULL,delivered TEXT,error TEXT);
      CREATE INDEX IF NOT EXISTS external_deliveries_pending ON external_deliveries(principal_id,state,created);
      CREATE TABLE IF NOT EXISTS external_decisions(id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,requester_member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,controller_principal_id TEXT NOT NULL REFERENCES external_principals(id) ON DELETE CASCADE,request_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','answered','cancelled')),answer TEXT,answered_by_binding_id TEXT REFERENCES external_client_bindings(id) ON DELETE SET NULL,created TEXT NOT NULL,answered TEXT);
      CREATE INDEX IF NOT EXISTS external_decisions_pending ON external_decisions(group_id,state,created);
      CREATE TABLE IF NOT EXISTS panel_messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,panel_agent_id TEXT NOT NULL REFERENCES panel_agents(id) ON DELETE CASCADE,context TEXT NOT NULL CHECK(context IN ('private','coordination')),role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),text TEXT NOT NULL,active_team_id TEXT,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS panel_updates(id TEXT PRIMARY KEY,panel_agent_id TEXT NOT NULL REFERENCES panel_agents(id) ON DELETE CASCADE,group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,source_turn_id TEXT REFERENCES panel_turns(id) ON DELETE SET NULL,kind TEXT NOT NULL DEFAULT 'update' CHECK(kind IN ('update','continuation')),text TEXT NOT NULL,source_message_ids TEXT NOT NULL DEFAULT '[]',created TEXT NOT NULL,delivered_turn_id TEXT,delivered TEXT);
      CREATE TABLE IF NOT EXISTS panel_turns(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES panel_sessions(id) ON DELETE CASCADE,panel_agent_id TEXT NOT NULL REFERENCES panel_agents(id) ON DELETE CASCADE,context TEXT NOT NULL,group_id TEXT,active_team_id TEXT,state TEXT NOT NULL,created TEXT NOT NULL,ended TEXT);
      CREATE TABLE IF NOT EXISTS panel_history(seq INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL REFERENCES panel_sessions(id) ON DELETE CASCADE,turn_id TEXT,event TEXT NOT NULL,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS panel_outbox(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES panel_sessions(id) ON DELETE CASCADE,payload TEXT NOT NULL,accepted TEXT,error TEXT);
      CREATE TABLE IF NOT EXISTS panel_attached(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,outbox_id TEXT NOT NULL REFERENCES panel_outbox(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS panel_turn_inputs(turn_id TEXT NOT NULL REFERENCES panel_turns(id) ON DELETE CASCADE,message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,PRIMARY KEY(turn_id,message_id));
      CREATE TABLE IF NOT EXISTS panel_message_origins(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,turn_id TEXT NOT NULL REFERENCES panel_turns(id) ON DELETE CASCADE,event_seq INTEGER REFERENCES panel_history(seq) ON DELETE SET NULL,call_id TEXT NOT NULL,native_call_id TEXT);
      CREATE TABLE IF NOT EXISTS interactions(id TEXT PRIMARY KEY,group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,member_id TEXT REFERENCES members(id) ON DELETE CASCADE,panel_agent_id TEXT REFERENCES panel_agents(id) ON DELETE CASCADE,endpoint_id TEXT,context TEXT NOT NULL,turn_id TEXT NOT NULL,call_id TEXT NOT NULL,message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,panel_message_id TEXT,kind TEXT NOT NULL CHECK(kind IN ('choice','input','takeover','handback','group_create','group_add','group_delete','member_model')),payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','answered','cancelled','failed')),answer TEXT,detail TEXT,answer_message_id TEXT,created TEXT NOT NULL,answered TEXT);
      CREATE TABLE IF NOT EXISTS agent_tasks(owner_id TEXT NOT NULL,group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,tasks TEXT NOT NULL,updated TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(owner_id,group_id));
      CREATE TABLE IF NOT EXISTS plan_events(id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,plan_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('frozen','step_cancelled')),owner_id TEXT,revision INTEGER,payload TEXT NOT NULL,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS message_step_refs(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,plan_id TEXT NOT NULL,step_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS model_policy_presets(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,mode TEXT NOT NULL,rules TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS theme_packs(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,light TEXT NOT NULL,dark TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attachment_settings(singleton INTEGER PRIMARY KEY CHECK(singleton=1),max_file_bytes INTEGER NOT NULL,max_files INTEGER NOT NULL,max_image_pixels INTEGER NOT NULL,updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY,panel_agent_id TEXT NOT NULL REFERENCES panel_agents(id) ON DELETE CASCADE,original_name TEXT NOT NULL,media_type TEXT NOT NULL CHECK(media_type IN ('text/plain','image/png','image/jpeg')),size INTEGER NOT NULL,storage_name TEXT NOT NULL,created_at TEXT NOT NULL,panel_message_id TEXT REFERENCES panel_messages(id) ON DELETE CASCADE,ordinal INTEGER);
      CREATE TABLE IF NOT EXISTS panel_message_requests(panel_agent_id TEXT NOT NULL REFERENCES panel_agents(id) ON DELETE CASCADE,client_message_id TEXT NOT NULL,payload_hash TEXT NOT NULL,panel_message_id TEXT NOT NULL REFERENCES panel_messages(id) ON DELETE CASCADE,created_at TEXT NOT NULL,PRIMARY KEY(panel_agent_id,client_message_id));
      CREATE INDEX IF NOT EXISTS interactions_group ON interactions(group_id,created);
      CREATE INDEX IF NOT EXISTS agent_tasks_group ON agent_tasks(group_id);
      CREATE INDEX IF NOT EXISTS plan_events_group ON plan_events(group_id,plan_id,created);
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
    store.db.exec(`CREATE TABLE IF NOT EXISTS runtime_attempts(turn_id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,endpoint_id TEXT NOT NULL,state TEXT NOT NULL,policy TEXT NOT NULL,detail TEXT,created TEXT NOT NULL,ended TEXT);
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
      if (!store.all('PRAGMA table_info(members)').some(column => column.name === name)) {
        store.db.exec(`ALTER TABLE members ADD COLUMN ${name} ${definition}`);
      }
    }
    store.transaction(() => {
      store.db.exec(`CREATE TABLE IF NOT EXISTS turns(id TEXT PRIMARY KEY,endpoint_id TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,session TEXT,created TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS turn_inputs(turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,PRIMARY KEY(turn_id,message_id));
        CREATE TABLE IF NOT EXISTS native_turn_refs(turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,ref TEXT NOT NULL,PRIMARY KEY(turn_id,ref));
        CREATE TABLE IF NOT EXISTS message_origins(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,event_seq INTEGER REFERENCES history(seq) ON DELETE SET NULL,call_id TEXT NOT NULL,native_call_id TEXT);`);
      if (!store.all('PRAGMA table_info(history)').some(column => column.name === 'turn_id')) store.db.exec('ALTER TABLE history ADD COLUMN turn_id TEXT REFERENCES turns(id) ON DELETE CASCADE');
      store.db.exec('CREATE INDEX IF NOT EXISTS history_turn ON history(turn_id,seq); CREATE INDEX IF NOT EXISTS inputs_message ON turn_inputs(message_id);');
      store.db.exec(`
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
      if (!store.all(`PRAGMA table_info(${table})`).some(column => column.name === name)) {
        store.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
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
      store.db.prepare("UPDATE panel_sessions SET session=NULL,policy_signature=NULL,updated=? WHERE context='private'")
        .run(new Date().toISOString());
    }
    migrate(store);
  }

export function migrateSchema(store, fromVersion) {
    if (fromVersion >= SCHEMA_VERSION) return;
    if (fromVersion < 2) migrateV2(store);
    if (fromVersion < 3) migrateV3(store);
    if (fromVersion < 4) migrateV4(store);
    if (fromVersion < 5) migrateV5(store);
    if (fromVersion < 6) migrateV6(store);
    if (fromVersion < 7) migrateV7(store);
    if (fromVersion < 8) migrateV8(store);
    if (fromVersion < 9) migrateV9(store);
    if (fromVersion < 10) migrateV10(store);
    if (fromVersion < 11) migrateV11(store);
    if (fromVersion < 12) migrateV12(store);
    if (fromVersion < 13) migrateV13(store);
    if (fromVersion < 14) migrateV14(store);
    if (fromVersion < 15) migrateV15(store);
    if (fromVersion < 16) migrateV16(store);
    if (fromVersion < 17) migrateV17(store);
    if (fromVersion < 18) migrateV18(store);
    if (fromVersion < 19) migrateV19(store);
    if (fromVersion < 20) migrateV20(store);
    if (fromVersion < 21) migrateV21(store);
    if (fromVersion < 22) migrateV22(store);
    if (fromVersion < 23) migrateV23(store);
    if (fromVersion < 24) migrateV24(store);
    if (fromVersion < 25) migrateV25(store);
    if (fromVersion < 26) migrateV26(store);
}

  // v19: 能力声明即有效——删除从未真正写入探测结果的 probed_capabilities。
  // 旧库该列与 declared_capabilities 内容一致，删除不丢信息。

export function migrateV19(store) {
    const columns = store.all('PRAGMA table_info(external_client_bindings)');
    if (!columns.some(column => column.name === 'probed_capabilities')) return;
    store.db.exec('ALTER TABLE external_client_bindings DROP COLUMN probed_capabilities');
  }

  // v20:桌面域基础。三块事实各自独立:
  // - desktop_applications:每个检测到的应用安装一行,持有安装身份与验证状态;
  //   surface 区分 Codex Desktop 与 CLI-only Codex,不复制宿主模型。
  // - 主控会话即 binding:桌面会话加 surface/app_id/controller_cwd,CLI binding 默认 cli 不受影响。
  //   app_id 是裸 id 引用(同 notes.source_team_id 的取舍):注册表行由检测服务
  //   按 (kind,surface,install_path) 重建,删除应用行不应级联抹掉绑定指向,
  //   指向缺失正好表达「该 surface 不可用」。
  // - team_controller_relations:团队与每个建立过访问的 binding 的持久关系;
  //   「谁活跃」由 team_lead_controllers 席位推导,关系表只记访问事实,不存第二份活跃状态。
  // - 团队 workspace 跟随主控会话:groups.workspace 仍是唯一生效目录,
  //   workspace_pending 表达「等旧回合结算再切」,workspace_events 留下解释性历史。
  // 既有 external_agent 席位播种为 creator 关系;旧 binding 一律 surface='cli',行为不变。

export function migrateV20(store) {
    const ensureColumn = (table, name, definition) => {
      if (!store.all(`PRAGMA table_info(${table})`).some(column => column.name === name)) {
        store.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
        return true;
      }
      return false;
    };
    store.transaction(() => {
      store.db.exec(`CREATE TABLE IF NOT EXISTS desktop_applications(
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
          UNIQUE(kind,surface,install_path));
        CREATE TABLE IF NOT EXISTS team_controller_relations(
          group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
          binding_id TEXT NOT NULL REFERENCES external_client_bindings(id) ON DELETE CASCADE,
          principal_id TEXT NOT NULL REFERENCES external_principals(id) ON DELETE CASCADE,
          origin TEXT NOT NULL DEFAULT 'takeover' CHECK(origin IN ('creator','takeover')),
          revision INTEGER NOT NULL DEFAULT 1,
          created TEXT NOT NULL,
          updated TEXT NOT NULL,
          PRIMARY KEY(group_id,binding_id));
        CREATE INDEX IF NOT EXISTS team_controller_relations_binding ON team_controller_relations(binding_id);
        CREATE TABLE IF NOT EXISTS workspace_events(
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK(kind IN ('pending','applied','cancelled')),
          from_path TEXT,
          to_path TEXT,
          revision INTEGER,
          detail TEXT,
          created TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS workspace_events_group ON workspace_events(group_id,seq);`);
      ensureColumn('external_client_bindings', 'app_id', 'TEXT');
      ensureColumn('external_client_bindings', 'surface', "TEXT NOT NULL DEFAULT 'cli' CHECK(surface IN ('cli','desktop'))");
      ensureColumn('external_client_bindings', 'controller_cwd', 'TEXT');
      ensureColumn('external_client_bindings', 'controller_cwd_updated', 'TEXT');
      ensureColumn('groups', 'workspace_pending', 'TEXT');
      ensureColumn('groups', 'workspace_revision', 'INTEGER NOT NULL DEFAULT 0');
      // 播种:既有外部主控席位即该 binding 建立访问的起点;origin 取 creator
      // 是近似——旧模型没有跨会话接管,席位 binding 基本就是建群 binding。
      store.db.exec(`INSERT OR IGNORE INTO team_controller_relations(group_id,binding_id,principal_id,origin,revision,created,updated)
          SELECT group_id,controller_binding_id,controller_id,'creator',revision,updated,updated
          FROM team_lead_controllers
          WHERE controller_kind='external_agent' AND state='active' AND controller_binding_id IS NOT NULL`);
    });
  }

  // v21:桌面应用的「用户停用」与 bundle 版本。readiness 表达系统能力结论,用户
  // 主动关掉一个可用应用是另一种事实——检测与验证都不应把它翻回来,所以单独成列;
  // bundle_version 是安装指纹的可见来源(重验证提示要能说出哪个版本变了)。

export function migrateV21(store) {
    const ensureColumn = (table, name, definition) => {
      if (!store.all(`PRAGMA table_info(${table})`).some(column => column.name === name)) {
        store.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
        return true;
      }
      return false;
    };
    store.transaction(() => {
      ensureColumn('desktop_applications', 'user_disabled', 'INTEGER NOT NULL DEFAULT 0');
      ensureColumn('desktop_applications', 'disabled_reason', 'TEXT');
      ensureColumn('desktop_applications', 'bundle_version', 'TEXT');
    });
  }

  // v22:主控连接分「会话」与「激活」两种。桌面集成在宿主配置里只能放一条全局
  // MCP 条目(凭据无法按会话分发),把宿主会话坍缩成一个 binding 正是交接文档
  // 列出的头号风险。激活连接只做凭据:携带安装级 key,按宿主上报的会话身份
  // (如 CODEX_THREAD_ID)解析或创建真正的会话连接;自己永不持有团队席位。

export function migrateV22(store) {
    store.transaction(() => {
      const hasKind = store.all('PRAGMA table_info(external_client_bindings)').some(column => column.name === 'binding_kind');
      if (!hasKind) {
        store.db.exec("ALTER TABLE external_client_bindings ADD COLUMN binding_kind TEXT NOT NULL DEFAULT 'conversation' CHECK(binding_kind IN ('conversation','activation'))");
      }
    });
  }

  // v23:桌面应用注册表新增第四家 ZCode Desktop。kind 的 CHECK 是 schema 级
  // 枚举,SQLite 不能改约束,按列信息重建本表;app_id 是裸引用、无外键指向
  // 本表,重建不牵连其他表。

export function migrateV23(store) {
    store.transaction(() => {
      const tableSql = store.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='desktop_applications'")?.sql ?? '';
      if (tableSql.includes("'zcode'")) return;
      const columns = store.all('PRAGMA table_info(desktop_applications)').map(column => column.name);
      if (!columns.length) return;
      store.db.exec(`CREATE TABLE desktop_applications_v23(
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
        INSERT INTO desktop_applications_v23(${columns.join(',')}) SELECT ${columns.join(',')} FROM desktop_applications;
        DROP TABLE desktop_applications;
        ALTER TABLE desktop_applications_v23 RENAME TO desktop_applications;`);
    });
  }

  // v24:主页进展摘要独立存储，与 Panel Agent 私聊消息解耦。

export function migrateV24(store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS home_summaries(
      id TEXT PRIMARY KEY,
      panel_agent_id TEXT NOT NULL REFERENCES panel_agents(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      created TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS home_summaries_agent ON home_summaries(panel_agent_id,created DESC);`);
  }

  // v25:派工能力要求的上下文窗口门槛随消息持久化，供执行前二次复核使用。
  // 未写门槛的旧消息为 NULL，视作无约束；required_capabilities 继续复用。

export function migrateV25(store) {
    const ensureColumn = (table, name, definition) => {
      if (!store.all(`PRAGMA table_info(${table})`).some(column => column.name === name)) {
        store.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      }
    };
    store.transaction(() => {
      ensureColumn('messages', 'min_context_window', 'INTEGER DEFAULT NULL');
    });
  }

  // v26:成员级策略上限、shell/浏览器开关落库;interactions 增加 member_policy 确认卡 kind。
  // 三列缺省即继承(NULL/NULL/0),旧成员继续沿用 groups.policy 与 groups.allow_shell;
  // interactions 沿用重建探测,保证新库直建与迁移库的 DDL 完全一致。

export function migrateV26(store) {
    const ensureColumn = (table, name, definition) => {
      const columns = store.all(`PRAGMA table_info(${table})`);
      if (!columns.length) return;
      if (!columns.some(column => column.name === name)) {
        store.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      }
    };
    store.transaction(() => {
      ensureColumn('members', 'policy_ceiling', 'TEXT DEFAULT NULL');
      ensureColumn('members', 'allow_shell', 'INTEGER DEFAULT NULL');
      ensureColumn('members', 'allow_browser', 'INTEGER NOT NULL DEFAULT 0');
      migrateInteractions(store);
    });
  }

  // v3:把"待投递"从推导事实变成 messages.awaiting 存储事实，并给 outbox 建待投递部分索引。
  // 只有 kind='send' 且接收者不是 user 的消息置 1；进入 outbox/attached 后清零。

export function migrateV3(store) {
    const hasAwaiting = store.all('PRAGMA table_info(messages)').some(column => column.name === 'awaiting');
    store.transaction(() => {
      if (!hasAwaiting) store.db.exec('ALTER TABLE messages ADD COLUMN awaiting INTEGER NOT NULL DEFAULT 0');
      store.db.exec(`UPDATE messages SET awaiting = CASE WHEN kind='send' AND recipient!='user'
          AND NOT EXISTS(SELECT 1 FROM attached a WHERE a.message_id=messages.id) THEN 1 ELSE 0 END;
        CREATE INDEX IF NOT EXISTS messages_awaiting ON messages(seq) WHERE awaiting=1;
        CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(accepted) WHERE accepted IS NULL;`);
    });
  }

  // v4:Agent 间请求-答复协议与工作台清理状态。
  // expects_reply 只标记"发信人期待答复"的正式消息;答复用既有 reply_to 指回请求。

export function migrateV4(store) {
    const hasExpectsReply = store.all('PRAGMA table_info(messages)').some(column => column.name === 'expects_reply');
    store.transaction(() => {
      if (!hasExpectsReply) store.db.exec('ALTER TABLE messages ADD COLUMN expects_reply INTEGER NOT NULL DEFAULT 0');
      store.db.exec(`CREATE INDEX IF NOT EXISTS messages_expects_reply ON messages(seq) WHERE expects_reply=1;
        CREATE INDEX IF NOT EXISTS messages_reply_to ON messages(reply_to) WHERE reply_to IS NOT NULL;
        CREATE TABLE IF NOT EXISTS workbench_dismissals(category TEXT NOT NULL,item_id TEXT NOT NULL,created TEXT NOT NULL,PRIMARY KEY(category,item_id));`);
    });
  }

  // v5:每个归档团队一份独立事实快照，摘要按需生成。

export function migrateV5(store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS archive_snapshots(
      group_id TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
      id TEXT NOT NULL UNIQUE,created TEXT NOT NULL,facts TEXT NOT NULL,
      summary TEXT,summary_created TEXT,error TEXT);`);
  }

  // v6:随心记。笔记不挂团队、不记录执行状态；Panel Agent 交互只通过一段提示词。

export function migrateV6(store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS notes(
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

export function migrateV7(store) {
    const hasTable = name => Boolean(store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name));
    const now = new Date().toISOString();
    store.transaction(() => {
      // 目标表必须在迁移内自建:v6 库走到这里时 ensureV2Schema 还没执行。
      store.db.exec(`CREATE TABLE IF NOT EXISTS conversation_session_meta(conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,session_key TEXT NOT NULL,session TEXT,session_updated TEXT,policy_signature TEXT,schema_version INTEGER,format_source TEXT,format_created TEXT,format_updated TEXT,PRIMARY KEY(conversation_id,session_key));
        CREATE TABLE IF NOT EXISTS operation_records(scope TEXT NOT NULL,scope_id TEXT NOT NULL DEFAULT '',client_key TEXT NOT NULL,payload TEXT,ref TEXT,created TEXT NOT NULL,PRIMARY KEY(scope,scope_id,client_key));
        CREATE INDEX IF NOT EXISTS operation_records_ref ON operation_records(scope,ref);`);
      if (hasTable('conversation_session_bindings')) {
        store.db.exec(`INSERT INTO conversation_session_meta(conversation_id,session_key,session,session_updated)
            SELECT conversation_id,session_key,session,updated FROM conversation_session_bindings;`);
      }
      if (hasTable('conversation_session_policies')) {
        store.db.exec(`INSERT INTO conversation_session_meta(conversation_id,session_key,policy_signature)
            SELECT conversation_id,session_key,signature FROM conversation_session_policies WHERE true
            ON CONFLICT(conversation_id,session_key) DO UPDATE SET policy_signature=excluded.policy_signature;`);
      }
      if (hasTable('conversation_context_formats')) {
        store.db.exec(`INSERT INTO conversation_session_meta(conversation_id,session_key,schema_version,format_source,format_created,format_updated)
            SELECT conversation_id,session_key,schema_version,source,created,updated FROM conversation_context_formats WHERE true
            ON CONFLICT(conversation_id,session_key) DO UPDATE SET schema_version=excluded.schema_version,format_source=excluded.format_source,format_created=excluded.format_created,format_updated=excluded.format_updated;`);
      }
      store.db.exec(`DROP TABLE IF EXISTS conversation_session_bindings;
        DROP TABLE IF EXISTS conversation_session_policies;
        DROP TABLE IF EXISTS conversation_context_formats;`);
      if (hasTable('team_creation_requests')) {
        store.db.exec(`INSERT INTO operation_records(scope,scope_id,client_key,payload,ref,created)
          SELECT 'group-create','',operation_id,payload,COALESCE(group_id,''),'${now}' FROM team_creation_requests;`);
      }
      if (hasTable('team_directive_requests')) {
        store.db.exec(`INSERT INTO operation_records(scope,scope_id,client_key,payload,ref,created)
          SELECT 'team-directive',group_id,operation_id,NULL,message_id,'${now}' FROM team_directive_requests;`);
      }
      if (hasTable('panel_message_requests')) {
        store.db.exec(`INSERT INTO operation_records(scope,scope_id,client_key,payload,ref,created)
          SELECT 'panel-private-message',panel_agent_id,client_message_id,payload_hash,panel_message_id,created_at FROM panel_message_requests;`);
      }
      store.db.exec(`DROP TABLE IF EXISTS team_creation_requests;
        DROP TABLE IF EXISTS team_directive_requests;
        DROP TABLE IF EXISTS panel_message_requests;`);
    });
  }

  // v8:随心记的「来源团队」。source_team_id 是裸 id,刻意不加外键:团队是硬删除,
  // 加了 REFERENCES/级联会连用户的私人笔记一起删掉。来源只回答「这笔是在哪个团队里记的」,
  // 用于展示与筛选,不是归属,不构成权限,也不进入 Agent 上下文。

export function migrateV8(store) {
    const hasNotes = Boolean(store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='notes'"));
    if (!hasNotes) return;
    const hasSource = store.all('PRAGMA table_info(notes)').some(column => column.name === 'source_team_id');
    store.transaction(() => {
      if (!hasSource) store.db.exec('ALTER TABLE notes ADD COLUMN source_team_id TEXT');
      store.db.exec('CREATE INDEX IF NOT EXISTS notes_source_team ON notes(source_team_id, updated DESC);');
    });
  }

  // v9:互动卡支持多步提问(kind='flow')。SQLite 改不了 CHECK,按 v2 形状重建一次;
  // 只移植仍在使用的列,conversation_id 与 payload 原样保留(进度写在 payload.steps 里)。

export function migrateV9(store) {
    const info = store.all('PRAGMA table_info(interactions)');
    if (!info.length) return;
    const tableSql = store.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='interactions'")?.sql ?? '';
    if (tableSql.includes("'flow'")) return;
    const cols = new Set(info.map(column => column.name));
    const conversation = cols.has('conversation_id') ? 'conversation_id' : (cols.has('endpoint_id') ? 'endpoint_id' : 'NULL');
    store.transaction(() => {
      store.db.exec(`ALTER TABLE interactions RENAME TO interactions_v8;
        CREATE TABLE interactions(id TEXT PRIMARY KEY,group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,member_id TEXT REFERENCES members(id) ON DELETE CASCADE,panel_agent_id TEXT REFERENCES panel_agents(id) ON DELETE CASCADE,conversation_id TEXT,context TEXT NOT NULL,turn_id TEXT NOT NULL,call_id TEXT NOT NULL,message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,panel_message_id TEXT,kind TEXT NOT NULL CHECK(kind IN ('choice','input','flow','takeover','handback','group_create','group_add','group_delete','member_model')),payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','answered','cancelled','failed')),answer TEXT,detail TEXT,answer_message_id TEXT,created TEXT NOT NULL,answered TEXT);
        INSERT INTO interactions(id,group_id,member_id,panel_agent_id,conversation_id,context,turn_id,call_id,message_id,panel_message_id,kind,payload,state,answer,detail,answer_message_id,created,answered)
          SELECT id,group_id,member_id,panel_agent_id,${conversation},context,turn_id,call_id,message_id,panel_message_id,kind,payload,state,answer,detail,answer_message_id,created,answered FROM interactions_v8;
        DROP TABLE interactions_v8;
        CREATE INDEX IF NOT EXISTS interactions_group ON interactions(group_id,created);
        CREATE INDEX IF NOT EXISTS interactions_panel ON interactions(panel_agent_id,created);`);
    });
  }

  // v10:随心记的标签与置顶。tags 是 JSON 数组存标签 id(与 todos 同款,不建关联表);
  // note_tags 是全局标签注册表(name UNIQUE 防重);置顶用时间戳表达,可空=未置顶。

export function migrateV10(store) {
    store.transaction(() => {
      store.db.exec(`CREATE TABLE IF NOT EXISTS note_tags(
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, color TEXT,
        created TEXT NOT NULL);`);
      const hasNotes = Boolean(store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='notes'"));
      if (!hasNotes) return;
      const columns = new Set(store.all('PRAGMA table_info(notes)').map(column => column.name));
      if (!columns.has('tags')) store.db.exec("ALTER TABLE notes ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'");
      if (!columns.has('pinned_at')) store.db.exec('ALTER TABLE notes ADD COLUMN pinned_at TEXT');
      store.db.exec("CREATE INDEX IF NOT EXISTS notes_pinned ON notes(pinned_at DESC) WHERE pinned_at IS NOT NULL;");
    });
  }
  // v11:任务面板步骤化 — 计划事件、派工引用与 agent_tasks.revision。

export function migrateV11(store) {
    store.transaction(() => {
      store.db.exec(`CREATE TABLE IF NOT EXISTS plan_events(id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,plan_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('frozen','step_cancelled')),owner_id TEXT,revision INTEGER,payload TEXT NOT NULL,created TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS plan_events_group ON plan_events(group_id,plan_id,created);
        CREATE TABLE IF NOT EXISTS message_step_refs(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,plan_id TEXT NOT NULL,step_id TEXT NOT NULL);`);
      const columns = new Set(store.all('PRAGMA table_info(agent_tasks)').map(column => column.name));
      if (columns.size && !columns.has('revision')) store.db.exec('ALTER TABLE agent_tasks ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
    });
  }

  // v12:外部主控身份、连接能力与团队控制权。外部主控不是成员也不是 Panel Agent;
  // 一个 principal 可拥有多个宿主 client binding，但每个团队仍只有一条主控 assignment。

export function migrateV12(store) {
    const hasTable = name => Boolean(store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name));
    store.transaction(() => {
      store.db.exec(`CREATE TABLE IF NOT EXISTS external_principals(id TEXT PRIMARY KEY,name TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS external_client_bindings(id TEXT PRIMARY KEY,principal_id TEXT NOT NULL REFERENCES external_principals(id) ON DELETE CASCADE,name TEXT NOT NULL,host TEXT NOT NULL,key_hash TEXT NOT NULL UNIQUE,session TEXT,declared_capabilities TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),created TEXT NOT NULL,updated TEXT NOT NULL,last_seen TEXT,UNIQUE(principal_id,name));
        CREATE INDEX IF NOT EXISTS external_bindings_principal ON external_client_bindings(principal_id,status);
        CREATE TABLE IF NOT EXISTS external_deliveries(id TEXT PRIMARY KEY,principal_id TEXT NOT NULL REFERENCES external_principals(id) ON DELETE CASCADE,group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,binding_id TEXT REFERENCES external_client_bindings(id) ON DELETE SET NULL,state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','delivered','error')),payload TEXT NOT NULL,created TEXT NOT NULL,delivered TEXT,error TEXT);
        CREATE INDEX IF NOT EXISTS external_deliveries_pending ON external_deliveries(principal_id,state,created);`);
      if (!hasTable('team_lead_controllers')) return;
      const sql = store.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='team_lead_controllers'")?.sql ?? '';
      if (sql.includes("'external_agent'")) return;
      store.db.exec(`ALTER TABLE team_lead_controllers RENAME TO team_lead_controllers_v11;
        CREATE TABLE team_lead_controllers(group_id TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,controller_kind TEXT NOT NULL CHECK(controller_kind IN ('member','panel_agent','external_agent')),controller_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('active','suspended')),original_lead_id TEXT,revision INTEGER NOT NULL DEFAULT 1,updated TEXT NOT NULL);
        INSERT INTO team_lead_controllers(group_id,controller_kind,controller_id,state,original_lead_id,revision,updated)
          SELECT group_id,controller_kind,controller_id,state,original_lead_id,revision,updated FROM team_lead_controllers_v11;
        DROP TABLE team_lead_controllers_v11;`);
    });
  }

  // v13:无头决策请求。面板互动卡仍是客户端投影；外部主控使用独立事实表，
  // 请求归属团队和外部 principal，答复必须由当前主控显式写回。

export function migrateV13(store) {
    store.transaction(() => {
      store.db.exec(`CREATE TABLE IF NOT EXISTS external_decisions(id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,requester_member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,controller_principal_id TEXT NOT NULL REFERENCES external_principals(id) ON DELETE CASCADE,request_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','answered','cancelled')),answer TEXT,answered_by_binding_id TEXT REFERENCES external_client_bindings(id) ON DELETE SET NULL,created TEXT NOT NULL,answered TEXT);
        CREATE INDEX IF NOT EXISTS external_decisions_pending ON external_decisions(group_id,state,created);`);
    });
  }

  // v14:团队 active controller 还要落到具体 client binding，而不只是 principal。
  // 同一用户身份可以有多会话，但一个团队只允许一个 binding 获得写席位。

export function migrateV14(store) {
    if (!store.all('PRAGMA table_info(team_lead_controllers)').some(column => column.name === 'controller_binding_id')) {
      store.db.exec('ALTER TABLE team_lead_controllers ADD COLUMN controller_binding_id TEXT');
    }
  }

  // v15:外部主控主动唤醒。binding 可保存固定宿主命令；投递记录分别跟踪
  // “唤醒是否尝试”和“客户端是否领取”，不能把 wake_sent 当成 delivered。

export function migrateV15(store) {
    store.transaction(() => {
      if (!store.all('PRAGMA table_info(external_client_bindings)').some(column => column.name === 'command')) {
        store.db.exec('ALTER TABLE external_client_bindings ADD COLUMN command TEXT');
      }
      const columns = new Set(store.all('PRAGMA table_info(external_deliveries)').map(column => column.name));
      if (!columns.has('wake_state')) store.db.exec("ALTER TABLE external_deliveries ADD COLUMN wake_state TEXT NOT NULL DEFAULT 'unsupported'");
      if (!columns.has('wake_error')) store.db.exec('ALTER TABLE external_deliveries ADD COLUMN wake_error TEXT');
      if (!columns.has('wake_updated')) store.db.exec('ALTER TABLE external_deliveries ADD COLUMN wake_updated TEXT');
    });
  }

  // v16:Codex 主动唤醒使用 exec resume 时必须重新注入 MCP server 参数。
  // wake_config 只保存该 binding 自己的 shim 启动配置，不通过控制工具暴露。

export function migrateV16(store) {
    if (!store.all('PRAGMA table_info(external_client_bindings)').some(column => column.name === 'wake_config')) {
      store.db.exec('ALTER TABLE external_client_bindings ADD COLUMN wake_config TEXT');
    }
  }

  // v17:主动唤醒验证、pull-only 接受与成员有效能力。旧 binding 默认未验证；
  // 成员能力在首次快照时由宿主适配器重新计算，不把旧群策略误当成已验证能力。

export function migrateV17(store) {
    const ensureColumn = (table, name, definition) => {
      if (!store.all(`PRAGMA table_info(${table})`).some(column => column.name === name)) {
        store.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      }
    };
    store.transaction(() => {
      ensureColumn('external_client_bindings', 'wake_state', "TEXT NOT NULL DEFAULT 'unverified'");
      ensureColumn('external_client_bindings', 'wake_mode', 'TEXT');
      ensureColumn('external_client_bindings', 'wake_reason', 'TEXT');
      ensureColumn('external_client_bindings', 'wake_fingerprint', 'TEXT');
      ensureColumn('external_client_bindings', 'wake_verified_at', 'TEXT');
      ensureColumn('external_client_bindings', 'wake_attempts', 'INTEGER NOT NULL DEFAULT 0');
      ensureColumn('external_client_bindings', 'wake_next_attempt', 'TEXT');
      ensureColumn('external_client_bindings', 'pull_only_accepted', 'TEXT');
      ensureColumn('members', 'effective_policy', 'TEXT');
      ensureColumn('members', 'capabilities', "TEXT NOT NULL DEFAULT '[]'");
      ensureColumn('members', 'capability_reason', 'TEXT');
      ensureColumn('messages', 'required_capabilities', "TEXT NOT NULL DEFAULT '[]'");
    });
  }

  // v18:读水位。只存「某个会话看到第几号」这一个数字,不给每条消息打已读标记。
  // 私聊副本用 receipt_id 标明它只是主控回执的展示副本,未读只能算群里那条。
  // 既有消息一律视为已读:水位从当前最新编号起步,升级后不会立刻涌出历史未读。

export function migrateV18(store) {
    const hasTable = name => Boolean(store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name));
    const now = new Date().toISOString();
    store.transaction(() => {
      store.db.exec(`CREATE TABLE IF NOT EXISTS read_watermarks(
        scope TEXT NOT NULL CHECK(scope IN ('group','panel')),
        scope_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        updated TEXT NOT NULL,
        PRIMARY KEY(scope,scope_id));`);
      if (!hasTable('panel_messages')) return;
      if (!store.all('PRAGMA table_info(panel_messages)').some(column => column.name === 'receipt_id')) {
        store.db.exec('ALTER TABLE panel_messages ADD COLUMN receipt_id TEXT');
      }
      store.run(
        `INSERT OR IGNORE INTO read_watermarks(scope,scope_id,seq,updated)
         SELECT 'group',g.id,COALESCE((SELECT MAX(seq) FROM messages m WHERE m.group_id=g.id),0),? FROM groups g`,
        now,
      );
      store.run(
        `INSERT OR IGNORE INTO read_watermarks(scope,scope_id,seq,updated)
         SELECT 'panel',p.panel_agent_id || ':' || COALESCE(NULLIF(p.active_team_id,''),'__global__'),MAX(p.seq),?
         FROM panel_messages p WHERE p.context='private'
         GROUP BY p.panel_agent_id,COALESCE(NULLIF(p.active_team_id,''),'__global__')`,
        now,
      );
    });
  }

  // v2 目标 schema。新库/已迁移库都可重复执行；迁移过程中先改名旧表再调用它建新表。

export function migrateV2(store) {
    const hasTable = name => Boolean(store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name));
    if (hasTable('conversations') && !hasTable('endpoints') && !hasTable('panel_sessions')) return;
    if (!hasTable('endpoints') || !hasTable('panel_sessions')) throw new Error('v2 迁移缺少 v1 会话表');
    const now = new Date().toISOString();
    store.db.exec('PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON;');
    try {
      store.transaction(() => {
        store.db.exec(`ALTER TABLE turns RENAME TO turns_v1;
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
        ensureV2Schema(store);
        // v0 路径会先跑一次 migrate()(含 migrateInteractions 重建)，旧表可能已是 conversation_id；
        // 纯 v1 库则仍是 endpoint_id。两种来源都要能读。
        const legacyConversationColumn = store.all('PRAGMA table_info(interactions_v1)')
          .some(column => column.name === 'conversation_id') ? 'conversation_id' : 'endpoint_id';
        store.db.exec(`INSERT INTO conversations(id,group_id,member_id,panel_agent_id,context,peer,session,policy_signature,key,created,updated)
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
        const offset = Number(store.get('SELECT COALESCE(MAX(seq),0) AS seq FROM history').seq ?? 0);
        store.db.exec(`INSERT INTO history(seq,conversation_id,event,created,turn_id) SELECT seq+${offset},session_id,event,created,turn_id FROM panel_history;
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
            SELECT id,group_id,member_id,panel_agent_id,${legacyConversationColumn},context,turn_id,call_id,message_id,panel_message_id,kind,payload,state,answer,detail,answer_message_id,created,answered FROM interactions_v1;
          UPDATE conversations SET policy_signature=(SELECT p.signature FROM endpoint_policy p WHERE p.endpoint_id=conversations.id)
            WHERE member_id IS NOT NULL AND EXISTS(SELECT 1 FROM endpoint_policy p WHERE p.endpoint_id=conversations.id);
          DROP TABLE turns_v1; DROP TABLE turn_inputs_v1; DROP TABLE message_origins_v1; DROP TABLE history_v1;
          DROP TABLE outbox_v1; DROP TABLE attached_v1; DROP TABLE panel_updates_v1; DROP TABLE interactions_v1;
          DROP TABLE endpoints; DROP TABLE panel_sessions; DROP TABLE runtime_attempts; DROP TABLE panel_turns;
          DROP TABLE panel_turn_inputs; DROP TABLE panel_message_origins; DROP TABLE panel_history;
          DROP TABLE panel_outbox; DROP TABLE panel_attached; DROP TABLE endpoint_session_bindings;
          DROP TABLE endpoint_session_policies; DROP TABLE endpoint_policy; DROP TABLE endpoint_context_formats;
          DROP TABLE panel_session_context_formats;`);
        if (store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='team_requests'")) {
          store.db.exec(`ALTER TABLE team_requests RENAME TO team_requests_v1;
            CREATE TABLE team_requests(id TEXT PRIMARY KEY,panel_agent_id TEXT NOT NULL REFERENCES panel_agents(id) ON DELETE CASCADE,source_user_message_id TEXT NOT NULL REFERENCES panel_messages(id) ON DELETE CASCADE,source_turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,call_id TEXT,group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,controller_id TEXT NOT NULL,operation_id TEXT NOT NULL,message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,original_text TEXT NOT NULL,text TEXT NOT NULL,created TEXT NOT NULL,UNIQUE(panel_agent_id,source_user_message_id,operation_id));
            INSERT INTO team_requests SELECT id,panel_agent_id,source_user_message_id,source_turn_id,call_id,group_id,controller_id,operation_id,message_id,original_text,text,created FROM team_requests_v1;
            DROP TABLE team_requests_v1;`);
        }
        const violations = store.all('PRAGMA foreign_key_check');
        if (violations.length) throw new Error(`v2 迁移外键校验失败: ${JSON.stringify(violations.slice(0, 3))}`);
      });
    } finally {
      store.db.exec('PRAGMA legacy_alter_table=OFF; PRAGMA foreign_keys=ON;');
    }
  }

  // ADR 0004: task-flow persistence is gone. Old databases shed their process
  // tables and columns; message history, host sessions and telemetry remain.

export function migrate(store) {
    const flowTables = [
      'preparations', 'preparation_policy', 'contract_versions', 'team_state',
      'work_items', 'work_records', 'change_requests', 'collaboration_operations',
      'message_context', 'message_dispositions', 'user_outputs',
      'team_charter_versions', 'goal_drafts', 'goals', 'goal_contract_versions',
      'goal_events', 'team_goal_operations', 'panel_action_requests',
    ];
    for (const table of flowTables) store.db.exec(`DROP TABLE IF EXISTS ${table}`);
    migrateInteractions(store);
    migrateAgentTasks(store);
    migrateAttachments(store);
    for (const [table, column] of [
      ['members', 'joined_goal_version'], ['members', 'removed_goal_version'],
      ['runtime_attempts', 'contract_version'], ['runtime_attempts', 'goal_id'],
      ['groups', 'revision'],
    ]) {
      if (store.all(`PRAGMA table_info(${table})`).some(column_ => column_.name === column)) {
        // SQLite refuses DROP COLUMN while an index references the column; retired
        // task-flow indexes (e.g. runtime_attempts_goal) must go first.
        const referenced = new RegExp(`\\b${column}\\b`);
        for (const index of store.all("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL", table)) {
          if (referenced.test(index.sql)) store.db.exec(`DROP INDEX IF EXISTS ${index.name}`);
        }
        store.db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
      }
    }
  }
  // attachments 的 media_type CHECK 扩展(image/jpeg)走重建:SQLite 不能改 CHECK。

export function migrateAttachments(store) {
    const info = store.all('PRAGMA table_info(attachments)');
    if (!info.length) return;
    const tableSql = store.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='attachments'")?.sql ?? '';
    if (tableSql.includes("'image/jpeg'")) return;
    store.transaction(() => {
      store.db.exec(`ALTER TABLE attachments RENAME TO attachments_legacy;
        CREATE TABLE attachments(id TEXT PRIMARY KEY,panel_agent_id TEXT NOT NULL REFERENCES panel_agents(id) ON DELETE CASCADE,original_name TEXT NOT NULL,media_type TEXT NOT NULL CHECK(media_type IN ('text/plain','image/png','image/jpeg')),size INTEGER NOT NULL,storage_name TEXT NOT NULL,created_at TEXT NOT NULL,panel_message_id TEXT REFERENCES panel_messages(id) ON DELETE CASCADE,ordinal INTEGER);
        INSERT INTO attachments(id,panel_agent_id,original_name,media_type,size,storage_name,created_at,panel_message_id,ordinal) SELECT id,panel_agent_id,original_name,media_type,size,storage_name,created_at,panel_message_id,ordinal FROM attachments_legacy;
        DROP TABLE attachments_legacy;
        CREATE INDEX IF NOT EXISTS attachments_message ON attachments(panel_message_id);
        CREATE INDEX IF NOT EXISTS attachments_agent ON attachments(panel_agent_id);`);
    });
  }
  // agent_tasks 主键从 owner_id 演进为 (owner_id,group_id):
  // Panel Agent 在多个团队各有一份任务列表,单列主键会让跨团队写入互相覆盖。
  // revision 记录写入时的控制者版本,用于区分当前任期的计划与普通任务。

export function migrateAgentTasks(store) {
    const info = store.all('PRAGMA table_info(agent_tasks)');
    if (!info.length) return;
    const pkColumns = info.filter(column => column.pk > 0).sort((a, b) => a.pk - b.pk).map(column => column.name);
    if (pkColumns.length !== 2) {
      store.transaction(() => {
        store.db.exec(`ALTER TABLE agent_tasks RENAME TO agent_tasks_legacy;
          CREATE TABLE agent_tasks(owner_id TEXT NOT NULL,group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,tasks TEXT NOT NULL,updated TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(owner_id,group_id));
          INSERT INTO agent_tasks(owner_id,group_id,tasks,updated) SELECT owner_id,group_id,tasks,updated FROM agent_tasks_legacy;
          DROP TABLE agent_tasks_legacy;
          CREATE INDEX IF NOT EXISTS agent_tasks_group ON agent_tasks(group_id);`);
      });
    }
    if (!store.all('PRAGMA table_info(agent_tasks)').some(column => column.name === 'revision')) {
      store.db.exec('ALTER TABLE agent_tasks ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
    }
  }
  // interactions 结构演进统一走重建:请求方泛化(v2)、动作类 kind 扩展(v3)。
  // 用 sqlite_master 里的 CHECK 文本探测当前表是否包含全部所需 kind。

export function migrateInteractions(store) {    const info = store.all('PRAGMA table_info(interactions)');
    if (!info.length) return;
    const tableSql = store.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='interactions'")?.sql ?? '';
    const neededKinds = ['choice', 'input', 'flow', 'takeover', 'handback', 'group_create', 'group_add', 'group_delete', 'member_model', 'member_policy'];
    const missingKinds = neededKinds.filter(kind => !tableSql.includes(`'${kind}'`));
    const needsRebuild = missingKinds.length > 0
      || !info.some(column => column.name === 'panel_agent_id')
      || !info.some(column => column.name === 'conversation_id');
    if (needsRebuild) {
      const cols = new Set(info.map(column => column.name));
      const pick = (name, fallback = 'NULL') => (cols.has(name) ? name : fallback);
      store.transaction(() => {
        store.db.exec(`ALTER TABLE interactions RENAME TO interactions_legacy;
          CREATE TABLE interactions(id TEXT PRIMARY KEY,group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,member_id TEXT REFERENCES members(id) ON DELETE CASCADE,panel_agent_id TEXT REFERENCES panel_agents(id) ON DELETE CASCADE,conversation_id TEXT,context TEXT NOT NULL,turn_id TEXT NOT NULL,call_id TEXT NOT NULL,message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,panel_message_id TEXT,kind TEXT NOT NULL CHECK(kind IN ('choice','input','flow','takeover','handback','group_create','group_add','group_delete','member_model','member_policy')),payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','answered','cancelled','failed')),answer TEXT,detail TEXT,answer_message_id TEXT,created TEXT NOT NULL,answered TEXT);
          INSERT INTO interactions(id,group_id,member_id,panel_agent_id,conversation_id,context,turn_id,call_id,message_id,panel_message_id,kind,payload,state,answer,detail,answer_message_id,created,answered)
            SELECT id,group_id,member_id,${pick('panel_agent_id')},${pick('conversation_id', pick('endpoint_id'))},context,turn_id,call_id,message_id,${pick('panel_message_id')},kind,payload,state,answer,${pick('detail')},answer_message_id,created,answered FROM interactions_legacy;
          DROP TABLE interactions_legacy;
          CREATE INDEX IF NOT EXISTS interactions_group ON interactions(group_id,created);`);
      });
    }
    // v1/v2 库重建后与新建库统一补齐 panel 索引;不能放进 schema 块,
    // 否则对未迁移的旧表建索引会在 migrate 之前失败。
    store.db.exec('CREATE INDEX IF NOT EXISTS interactions_panel ON interactions(panel_agent_id,created)');
  }
