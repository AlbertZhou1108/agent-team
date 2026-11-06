// panel 域聚合:panel_agents / panel_messages / panel_updates / panel_team_bindings /
// operation_records(scope='panel-private-message') 等面板表的读写与不变式边界。
// 门面 panel-sessions.mjs 与 src/panel/* 只通过本模块访问这些表,不再各自拼 SQL;
// 分析型查询仍可直接用 store.all。所有函数接收 store,不持有全局状态。
//
// 不变式:
// - Panel Agent 全局单例(singleton=1),按 created 取最早一行即当前 Agent;
// - 每个团队与 Panel Agent 恰有一条面板绑定,缺省 relation='observer',主 Agent 为 'main';
// - 私聊消息按 seq 单调,分页/增量读取一律以 seq 为游标;
// - 面板更新只追加不修改;通知是投递台账的投影,workbench_dismissals 只影响展示;
// - 私聊请求幂等记录以 (scope='panel-private-message', panel_agent_id, client_key) 定位,
//   同 key 不同 payload 即内容冲突。

/** 当前 Panel Agent(单例);未创建时为 null。 */
export function panelAgent(store) {
  return store.panelAgent();
}

/** 面板消息的启动基准 seq:Bus 构造时记录一次,用于增量同步。 */
export function bootSeq(store) {
  return store.get('SELECT COALESCE(MAX(seq),0) AS seq FROM panel_messages').seq;
}

/** 按 id 读取 Panel Agent;主控解析用,不存在返回 undefined。 */
export function controllerAgent(store, id) {
  return store.get('SELECT * FROM panel_agents WHERE id=?', id);
}

/** 认证 Panel 会话来源(session key 与 panel_agents 同一次校验)。 */
export function authenticateSession(store, sessionId, key) {
  return store.authenticatePanelSession(sessionId, key);
}

/** 追加一条面板消息(context 由调用方保证为 private / coordination)。 */
export function appendMessage(store, panelAgentId, context, role, text, activeTeamId = null) {
  return store.panelAppend(panelAgentId, context, role, text, activeTeamId);
}

/** 新建 Panel Agent;singleton 唯一约束保证全局只有一个。 */
export function insertAgent(store, {
  id,
  name,
  host,
  modelProvider = null,
  model = null,
  reasoningEffort = null,
  workspace = null,
  access = 'read-only',
  created,
  updated,
}) {
  store.run(
    'INSERT INTO panel_agents(id, singleton, name, host, model_provider, model, reasoning_effort, workspace, access, created, updated) VALUES(?,1,?,?,?,?,?,?,?,?,?)',
    id,
    name,
    host,
    modelProvider,
    model,
    reasoningEffort,
    workspace,
    access,
    created,
    updated,
  );
}

/** 按 id 覆盖 Panel Agent 配置。 */
export function updateAgent(store, {
  id,
  name,
  host,
  modelProvider = null,
  model = null,
  reasoningEffort = null,
  workspace = null,
  access,
  updated,
}) {
  store.run(
    'UPDATE panel_agents SET name=?,host=?,model_provider=?,model=?,reasoning_effort=?,workspace=?,access=?,updated=? WHERE id=?',
    name,
    host,
    modelProvider,
    model,
    reasoningEffort,
    workspace,
    access,
    updated,
    id,
  );
}

/** 面板消息按 id 读取。 */
export function messageById(store, id) {
  return store.get('SELECT * FROM panel_messages WHERE id=?', id) ?? null;
}

/** 只取面板消息正文(运行输入回填的最小读)。 */
export function messageText(store, id) {
  return store.get('SELECT text FROM panel_messages WHERE id=?', id) ?? null;
}

/** 面板消息 seq 游标;消息不存在时为 null。 */
export function messageSeq(store, id) {
  return store.get('SELECT seq FROM panel_messages WHERE id=?', id)?.seq ?? null;
}

/** 状态投影用:最近 200 条私聊消息(按 seq 升序);summary 只取轻量列。 */
export function privateMessagesForState(store, panelAgentId, summary = false) {
  return store.all(
    `SELECT * FROM (
      SELECT ${summary ? 'seq,id,role,created,active_team_id' : '*'} FROM panel_messages WHERE panel_agent_id=? AND context='private' ORDER BY seq DESC LIMIT 200
    ) ORDER BY seq`,
    panelAgentId,
  );
}

/**
 * 私聊历史分页:history=true 取 seq<=bootSeq,否则取 seq>bootSeq;
 * before>0 时继续向前翻,返回最多 201 行(多取一行用于判断 hasMore)。
 */
export function privateMessagePage(store, panelAgentId, { history = false, before = 0, bootSeq = 0 } = {}) {
  const params = [panelAgentId, bootSeq];
  let where = history ? 'seq<=?' : 'seq>?';
  if (before > 0) { where += ' AND seq<?'; params.push(before); }
  return store.all(
    "SELECT * FROM panel_messages WHERE panel_agent_id=? AND context='private' AND " + where + ' ORDER BY seq DESC LIMIT 201',
    ...params,
  );
}

/** 私聊增量读取:seq 游标之后的 200 行。 */
export function privateMessagesAfter(store, panelAgentId, after = 0) {
  return store.all(
    "SELECT * FROM panel_messages WHERE panel_agent_id=? AND context='private' AND seq>? ORDER BY seq LIMIT 200",
    panelAgentId,
    after,
  );
}

/** 最近一条私聊消息。 */
export function latestPrivateMessage(store, panelAgentId) {
  return store.get(
    "SELECT * FROM panel_messages WHERE panel_agent_id=? AND context='private' ORDER BY seq DESC LIMIT 1",
    panelAgentId,
  ) ?? null;
}

/** 某私聊消息之后最近一条助手消息(幂等回放用)。 */
export function latestPrivateAssistantAfter(store, panelAgentId, seq) {
  return store.get(
    "SELECT * FROM panel_messages WHERE panel_agent_id=? AND context='private' AND seq>? AND role='assistant' ORDER BY seq DESC LIMIT 1",
    panelAgentId,
    seq,
  ) ?? null;
}

/** 回填用户消息的所属团队(回合过程中模型可能切换了 activeTeamId)。 */
export function setMessageActiveTeamId(store, id, activeTeamId) {
  return store.run('UPDATE panel_messages SET active_team_id=? WHERE id=?', activeTeamId, id);
}

/** 有附件的私聊消息 id 集合:只对确有附件的消息逐条补齐 DTO。 */
export function panelMessageIdsWithAttachments(store, panelAgentId) {
  return store.all(
    'SELECT DISTINCT panel_message_id FROM attachments WHERE panel_agent_id=? AND panel_message_id IS NOT NULL',
    panelAgentId,
  ).map(row => row.panel_message_id);
}

/**
 * 补齐面板团队绑定:每个团队与当前 Panel Agent 一条,缺省 observer;幂等。
 * 绑定只在团队存在时成立;已存在的 main 关系不被覆盖。
 */
export function ensureBindings(store, panelAgentId, now = new Date().toISOString()) {
  if (!panelAgentId) return;
  for (const group of store.all('SELECT id FROM groups')) {
    store.run(
      "INSERT OR IGNORE INTO panel_team_bindings(panel_agent_id,group_id,relation,created,updated) VALUES(?,?,'observer',?,?)",
      panelAgentId,
      group.id,
      now,
      now,
    );
  }
}

/** 当前 Panel Agent 在某团队的关系;无绑定行时按 observer 处理。 */
export function bindingRelation(store, panelAgentId, groupId) {
  return store.get(
    'SELECT relation FROM panel_team_bindings WHERE panel_agent_id=? AND group_id=?',
    panelAgentId,
    groupId,
  )?.relation ?? 'observer';
}

/** 未归档团队(含 state 为空的历史行),按创建顺序。 */
export function activeGroups(store) {
  return store.all("SELECT * FROM groups WHERE state IS NULL OR state!='archived' ORDER BY created");
}

/** 未归档团队 id 列表(浏览器状态过滤用)。 */
export function activeGroupIds(store) {
  return store.all("SELECT id FROM groups WHERE state IS NULL OR state!='archived'").map(row => row.id);
}

/** 团队主控行;没有主控时为 null。 */
export function controller(store, groupId) {
  return store.get('SELECT * FROM team_lead_controllers WHERE group_id=?', groupId) ?? null;
}

/** 各团队待处理互动卡数量(group_id 为 NULL 的卡片不计)。 */
export function pendingInteractionCounts(store) {
  return Object.fromEntries(
    store.all("SELECT group_id,COUNT(*) AS count FROM interactions WHERE state='pending' AND group_id IS NOT NULL GROUP BY group_id")
      .map(row => [row.group_id, row.count]),
  );
}

/** 面板更新通知:投递台账投影,隐藏标记(workbench_dismissals)只过滤展示。 */
export function notifications(store, panelAgentId) {
  return store.all(
    `SELECT * FROM panel_updates u WHERE u.panel_agent_id=?
       AND NOT EXISTS(SELECT 1 FROM workbench_dismissals d WHERE d.category='panel:update' AND d.item_id=u.id)
     ORDER BY u.created DESC LIMIT 100`,
    panelAgentId,
  );
}

/** 追加一条面板更新;source_message_ids 以 JSON 数组落库。 */
export function insertUpdate(store, {
  id,
  panelAgentId,
  groupId,
  sourceTurnId = null,
  kind = 'update',
  text,
  sourceMessageIds = [],
  created = new Date().toISOString(),
}) {
  store.run(
    `INSERT INTO panel_updates(id,panel_agent_id,group_id,source_turn_id,kind,text,source_message_ids,created)
     VALUES(?,?,?,?,?,?,?,?)`,
    id,
    panelAgentId,
    groupId,
    sourceTurnId,
    kind,
    text,
    JSON.stringify(sourceMessageIds),
    created,
  );
}

/** 面板更新按 id 读取。 */
export function updateById(store, id) {
  return store.get('SELECT * FROM panel_updates WHERE id=?', id) ?? null;
}

/** 私聊请求幂等记录回读(scope 固定 panel-private-message)。 */
export function panelPrivateOperation(store, panelAgentId, clientKey) {
  return store.get(
    "SELECT * FROM operation_records WHERE scope='panel-private-message' AND scope_id=? AND client_key=?",
    panelAgentId,
    clientKey,
  ) ?? null;
}

/** 私聊请求幂等记录写入;由调用方保证在创建消息的同一事务内。 */
export function insertPanelPrivateOperation(store, { panelAgentId, clientKey, payload, ref, created }) {
  return store.run(
    "INSERT INTO operation_records(scope,scope_id,client_key,payload,ref,created) VALUES('panel-private-message',?,?,?,?,?)",
    panelAgentId,
    clientKey,
    payload,
    ref,
    created,
  );
}

/** 某 Panel Agent 在某团队某动作下最近的待处理互动卡(控制动作复用/取消依据)。 */
export function pendingPanelInteraction(store, { panelAgentId, groupId, kind }) {
  return store.get(
    "SELECT * FROM interactions WHERE panel_agent_id=? AND group_id=? AND kind=? AND state='pending' ORDER BY created DESC LIMIT 1",
    panelAgentId,
    groupId,
    kind,
  ) ?? null;
}
