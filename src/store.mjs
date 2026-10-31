import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';

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
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
      CREATE TABLE IF NOT EXISTS groups(id TEXT PRIMARY KEY,name TEXT NOT NULL,workspace TEXT NOT NULL,lead TEXT,created TEXT NOT NULL,charter TEXT,policy TEXT NOT NULL DEFAULT 'workspace-write',allow_shell INTEGER NOT NULL DEFAULT 1);
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
      CREATE INDEX IF NOT EXISTS interactions_group ON interactions(group_id,created);
      CREATE INDEX IF NOT EXISTS agent_tasks_group ON agent_tasks(group_id);
      CREATE INDEX IF NOT EXISTS messages_inbox ON messages(recipient,seq);
      CREATE INDEX IF NOT EXISTS messages_group ON messages(group_id,seq);
      CREATE INDEX IF NOT EXISTS history_endpoint ON history(endpoint_id,seq);
      CREATE INDEX IF NOT EXISTS panel_messages_agent ON panel_messages(panel_agent_id,seq);
      CREATE INDEX IF NOT EXISTS panel_updates_pending ON panel_updates(panel_agent_id,group_id,delivered_turn_id,created);
      CREATE INDEX IF NOT EXISTS panel_history_session ON panel_history(session_id,seq);
      CREATE INDEX IF NOT EXISTS panel_history_turn ON panel_history(turn_id,seq);`);
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
  endpoint(memberId, context, peer = null) {
    const member = this.member(memberId);
    let endpoint = this.get('SELECT * FROM endpoints WHERE member_id=? AND context=?', memberId, context);
    if (!endpoint) {
      const id = randomUUID();
      this.run('INSERT INTO endpoints VALUES(?,?,?,?,?,?,?)', id, member.group_id, member.id, context, peer, null, randomBytes(32).toString('hex'));
      endpoint = this.get('SELECT * FROM endpoints WHERE id=?', id);
    }
    return endpoint;
  }
  panelAgent() {
    return this.get('SELECT * FROM panel_agents ORDER BY created LIMIT 1') ?? null;
  }
  panelSession(panelAgentId, context, groupId = null) {
    const existing = context === 'private'
      ? this.get("SELECT * FROM panel_sessions WHERE panel_agent_id=? AND context='private'", panelAgentId)
      : this.get("SELECT * FROM panel_sessions WHERE panel_agent_id=? AND context='coordination' AND group_id=?", panelAgentId, groupId);
    if (existing) return existing;
    if (context === 'coordination') this.group(groupId);
    const id = `panel-session-${randomUUID()}`;
    const now = new Date().toISOString();
    this.run(
      'INSERT INTO panel_sessions(id,panel_agent_id,context,group_id,session,policy_signature,key,created,updated) VALUES(?,?,?,?,?,?,?,?,?)',
      id,
      panelAgentId,
      context,
      groupId,
      null,
      null,
      randomBytes(32).toString('hex'),
      now,
      now,
    );
    return this.get('SELECT * FROM panel_sessions WHERE id=?', id);
  }
  authenticatePanelSession(id, key) {
    const session = this.get('SELECT * FROM panel_sessions WHERE id=? AND key=?', id, key);
    if (!session) throw new Error('Panel Agent 会话来源无效');
    const panelAgent = this.get('SELECT * FROM panel_agents WHERE id=?', session.panel_agent_id);
    if (!panelAgent) throw new Error('Panel Agent 不存在');
    return { session, panelAgent };
  }
  authenticate(id, key) {
    const endpoint = this.get('SELECT * FROM endpoints WHERE id=? AND key=?', id, key);
    if (!endpoint) throw new Error('会话来源无效');
    this.member(endpoint.member_id);
    return endpoint;
  }
  append(groupId, sender, recipient, kind, text, replyTo = null) {
    this.group(groupId);
    const id = randomUUID();
    this.run('INSERT INTO messages(id,group_id,sender,recipient,kind,text,reply_to,created) VALUES(?,?,?,?,?,?,?,?)', id, groupId, sender, recipient, kind, text, replyTo, new Date().toISOString());
    return this.get('SELECT * FROM messages WHERE id=?', id);
  }
  pending() {
    return this.all(`SELECT m.* FROM messages m JOIN groups g ON g.id=m.group_id
      WHERE (g.state IS NULL OR g.state='open') AND m.kind='send'
      AND (
        EXISTS(SELECT 1 FROM members r WHERE r.id=m.recipient AND r.removed IS NULL)
        OR EXISTS(SELECT 1 FROM team_lead_controllers c WHERE c.group_id=m.group_id AND c.controller_kind='panel_agent' AND c.controller_id=m.recipient AND c.state='active')
      )
      AND NOT EXISTS(SELECT 1 FROM attached a WHERE a.message_id=m.id)
      AND NOT EXISTS(SELECT 1 FROM panel_attached p WHERE p.message_id=m.id) ORDER BY m.seq`);
  }
  createInteraction({ id, groupId = null, memberId = null, panelAgentId = null, endpointId = null, context, turnId, callId, messageId = null, panelMessageId = null, kind, payload, detail = null }) {
    this.run('INSERT INTO interactions(id,group_id,member_id,panel_agent_id,endpoint_id,context,turn_id,call_id,message_id,panel_message_id,kind,payload,state,detail,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
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
  prepare(message, endpoint, canBatch = () => true) {
    return this.transaction(() => {
      if (this.get('SELECT 1 FROM attached WHERE message_id=?', message.id)) return null;
      this.member(endpoint.member_id);
      const notes = this.all(`SELECT m.* FROM messages m WHERE m.recipient=? AND m.kind IN ('note','system')
        AND NOT EXISTS(SELECT 1 FROM attached a WHERE a.message_id=m.id) ORDER BY m.seq`, message.recipient);
      const candidates = this.all(`SELECT m.* FROM messages m WHERE ${endpoint.context === 'coordination' ? '' : 'm.sender=? AND '}m.recipient=? AND m.kind='send' AND m.id!=?
        AND NOT EXISTS(SELECT 1 FROM attached a WHERE a.message_id=m.id) ORDER BY m.seq`, ...(endpoint.context === 'coordination' ? [] : [message.sender]), message.recipient, message.id);
      const additional = [];
      for (const candidate of candidates) {
        if (canBatch([message, ...additional, candidate])) additional.push(candidate);
      }
      const payload = { groupId: message.group_id, conversation: endpoint.context === 'coordination' ? 'coordination' : [message.sender, message.recipient].sort(), message, ...(additional.length ? { additionalMessages: additional } : {}), notes };
      const id = randomUUID();
      this.run('INSERT INTO outbox(id,endpoint_id,payload) VALUES(?,?,?)', id, endpoint.id, JSON.stringify(payload));
      for (const item of [message, ...additional, ...notes]) this.run('INSERT INTO attached VALUES(?,?)', item.id, id);
      return { id, endpoint_id: endpoint.id, payload: JSON.stringify(payload), accepted: null, error: null };
    });
  }
  preparePanel(message, session, canBatch = () => true) {
    return this.transaction(() => {
      if (this.get('SELECT 1 FROM panel_attached WHERE message_id=?', message.id)) return null;
      const notes = this.all(`SELECT m.* FROM messages m WHERE m.recipient=? AND m.kind IN ('note','system')
        AND NOT EXISTS(SELECT 1 FROM attached a WHERE a.message_id=m.id)
        AND NOT EXISTS(SELECT 1 FROM panel_attached p WHERE p.message_id=m.id) ORDER BY m.seq`, message.recipient);
      const candidates = this.all(`SELECT m.* FROM messages m WHERE m.recipient=? AND m.kind='send' AND m.id!=?
        AND NOT EXISTS(SELECT 1 FROM attached a WHERE a.message_id=m.id)
        AND NOT EXISTS(SELECT 1 FROM panel_attached p WHERE p.message_id=m.id) ORDER BY m.seq`, message.recipient, message.id);
      const additional = [];
      for (const candidate of candidates) if (canBatch([message, ...additional, candidate])) additional.push(candidate);
      const payload = {
        groupId: message.group_id,
        conversation: 'coordination',
        message,
        ...(additional.length ? { additionalMessages: additional } : {}),
        notes,
      };
      const id = randomUUID();
      this.run('INSERT INTO panel_outbox(id,session_id,payload) VALUES(?,?,?)', id, session.id, JSON.stringify(payload));
      for (const item of [message, ...additional, ...notes]) this.run('INSERT INTO panel_attached VALUES(?,?)', item.id, id);
      return { id, session_id: session.id, payload: JSON.stringify(payload), accepted: null, error: null };
    });
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
  panelHistory(sessionId, event, turnId = null) {
    return Number(this.run(
      'INSERT INTO panel_history(session_id,turn_id,event,created) VALUES(?,?,?,?)',
      sessionId,
      turnId,
      JSON.stringify(event),
      new Date().toISOString(),
    ).lastInsertRowid);
  }
  createTurn(endpoint, inputs = []) {
    return this.transaction(() => {
      const id = randomUUID();
      this.run('INSERT INTO turns VALUES(?,?,?,?)', id, endpoint.id, endpoint.session, new Date().toISOString());
      inputs.forEach((message, ordinal) => this.run('INSERT INTO turn_inputs VALUES(?,?,?)', id, message.id, ordinal));
      return id;
    });
  }
  history(endpointId, event, turnId = null) {
    const endpoint = this.get('SELECT context FROM endpoints WHERE id=?', endpointId);
    if (endpoint && endpoint.context !== 'private') return Number(this.run('INSERT INTO history(endpoint_id,event,created,turn_id) VALUES(?,?,?,?)', endpointId, JSON.stringify(event), new Date().toISOString(), turnId).lastInsertRowid);
    return null;
  }
  publicTurn(id) {
    return this.get(`SELECT t.*,e.group_id,e.member_id,e.context,e.peer FROM turns t JOIN endpoints e ON e.id=t.endpoint_id WHERE t.id=? AND e.context!='private'`, id);
  }
  messageTrace(id) {
    const message = this.get('SELECT id,kind FROM messages WHERE id=?', id);
    if (!message) return null;
    const origin = this.get(`SELECT o.*,e.context,e.id AS endpoint_id FROM message_origins o JOIN turns t ON t.id=o.turn_id JOIN endpoints e ON e.id=t.endpoint_id WHERE o.message_id=?`, id);
    const panelOrigin = this.get(`SELECT o.*,t.context,t.group_id AS turn_group_id,s.panel_agent_id
      FROM panel_message_origins o JOIN panel_turns t ON t.id=o.turn_id JOIN panel_sessions s ON s.id=t.session_id
      WHERE o.message_id=?`, id);
    const source = panelOrigin
      ? {
          kind: panelOrigin.context === 'private' ? 'private' : 'panel',
          turnId: panelOrigin.turn_id,
          endpointId: null,
          panelAgentId: panelOrigin.panel_agent_id,
          groupId: panelOrigin.turn_group_id,
          eventSeq: panelOrigin.event_seq,
          callId: panelOrigin.call_id,
          nativeCallId: panelOrigin.native_call_id,
        }
      : !origin
        ? { kind: message.kind === 'system' ? 'system' : 'unknown' }
        : origin.context === 'private'
          ? { kind: 'private' }
          : { kind: 'group', turnId: origin.turn_id, endpointId: origin.endpoint_id, eventSeq: origin.event_seq, callId: origin.call_id, nativeCallId: origin.native_call_id };
    const inputAttempts = [
      ...this.all(`SELECT t.id,t.endpoint_id,t.session,t.created FROM turn_inputs i JOIN turns t ON t.id=i.turn_id JOIN endpoints e ON e.id=t.endpoint_id WHERE i.message_id=? AND e.context!='private' ORDER BY t.rowid`, id),
      ...this.all(`SELECT t.id,t.session_id AS endpoint_id,s.session,t.created FROM panel_turn_inputs i JOIN panel_turns t ON t.id=i.turn_id JOIN panel_sessions s ON s.id=t.session_id WHERE i.message_id=? ORDER BY t.rowid`, id),
    ];
    return { messageId: id, source, inputAttempts };
  }
  endpointModels(id, after = 0) {
    const endpoint = this.get("SELECT id FROM endpoints WHERE id=? AND context!='private'", id);
    const panelSession = endpoint ? null : this.get("SELECT id FROM panel_sessions WHERE id=? AND context='coordination'", id);
    if (!endpoint && !panelSession) return null;
    const all = modelObservations(endpoint
      ? this.all('SELECT seq,turn_id,created,event FROM history WHERE endpoint_id=? ORDER BY seq', id)
      : this.all('SELECT seq,turn_id,created,event FROM panel_history WHERE session_id=? ORDER BY seq', id));
    const observations = all.filter(observation => observation.seq > after).slice(0, 200);
    return { ...deriveCurrentModel(all), observations, nextAfter: observations.at(-1)?.seq ?? after };
  }
  endpointModelSummary(id) {
    const panelSession = this.get("SELECT id FROM panel_sessions WHERE id=? AND context='coordination'", id);
    const table = panelSession ? 'panel_history' : 'history';
    const column = panelSession ? 'session_id' : 'endpoint_id';
    const revision = this.get(`SELECT MAX(seq) AS seq,COUNT(*) AS count FROM ${table} WHERE ${column}=?`, id);
    this.modelSummaryCache ??= new Map();
    const cached = this.modelSummaryCache.get(id);
    if (cached?.seq === revision.seq && cached?.count === revision.count) return cached.value;
    const value = deriveCurrentModel(modelObservations(this.all(
      `SELECT seq,turn_id,created,event FROM ${table} WHERE ${column}=? ORDER BY seq`, id,
    )));
    this.modelSummaryCache.set(id, { ...revision, value });
    return value;
  }
  turnTrace(id, after = 0) {
    const turn = this.publicTurn(id);
    if (!turn) {
      const panelTurn = this.get(`SELECT t.*,s.context AS session_context,s.panel_agent_id
        FROM panel_turns t JOIN panel_sessions s ON s.id=t.session_id
        WHERE t.id=? AND s.context='coordination'`, id);
      if (!panelTurn) return null;
      const events = this.all('SELECT * FROM panel_history WHERE turn_id=? AND seq>? ORDER BY seq LIMIT 200', id, after);
      const observations = modelObservations(this.all('SELECT seq,turn_id,created,event FROM panel_history WHERE turn_id=? ORDER BY seq', id));
      return {
        turn: {
          id: panelTurn.id,
          endpoint_id: panelTurn.session_id,
          session: null,
          created: panelTurn.created,
          group_id: panelTurn.group_id,
          member_id: panelTurn.panel_agent_id,
          context: 'panel-coordination',
          peer: null,
        },
        nativeTurnRefs: [],
        inputMessages: this.all(
          'SELECT m.id,m.kind,i.ordinal FROM panel_turn_inputs i JOIN messages m ON m.id=i.message_id WHERE i.turn_id=? ORDER BY i.ordinal',
          id,
        ),
        outgoingMessages: this.all(
          'SELECT message_id,event_seq,call_id,native_call_id FROM panel_message_origins WHERE turn_id=? ORDER BY rowid',
          id,
        ),
        ...deriveCurrentModel(observations),
        modelObservations: observations,
        events,
        nextAfter: events.at(-1)?.seq ?? after,
      };
    }
    const events = this.all('SELECT * FROM history WHERE turn_id=? AND seq>? ORDER BY seq LIMIT 200', id, after);
    const observations = modelObservations(this.all('SELECT seq,turn_id,created,event FROM history WHERE turn_id=? ORDER BY seq', id));
    return { turn, nativeTurnRefs: this.all('SELECT ref FROM native_turn_refs WHERE turn_id=? ORDER BY rowid', id).map(row => row.ref),
      inputMessages: this.all('SELECT m.id,m.kind,i.ordinal FROM turn_inputs i JOIN messages m ON m.id=i.message_id WHERE i.turn_id=? ORDER BY i.ordinal', id),
      outgoingMessages: this.all('SELECT message_id,event_seq,call_id,native_call_id FROM message_origins WHERE turn_id=? ORDER BY rowid', id),
      ...deriveCurrentModel(observations), modelObservations: observations,
      events, nextAfter: events.at(-1)?.seq ?? after };
  }
  close() { this.db.close(); }
}
