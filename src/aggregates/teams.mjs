// teams 聚合:团队(groups)、成员(members)、历史角色名(role_names)、主控
// (team_lead_controllers)、任务面板(agent_tasks)与团队创建幂等(operation_records)
// 的不变式边界。业务模块只通过本模块读写这些表,不再各自拼 SQL;分析型查询仍可用 store.all。
// 所有函数接收 store,不持有全局状态。
//
// 不变式:
// - 团队是硬删除:成员/会话/消息按外键级联,删除前无外键引用由调用方清理(见 group-lifecycle);
// - 成员名在组内唯一:role_names 记录历史规范化名字,成员移除后名字也不释放;
// - team_lead_controllers 每团队至多一行,revision 单调递增(状态迁移处 +1);
// - agent_tasks 每 (owner_id, group_id) 至多一行,空列表等价于删除;
// - operation_records(scope='group-create') 按 client_key 幂等,ref 指向已建团队。

// --- groups -----------------------------------------------------------------

/** 全部团队,按创建时间升序(工具 groups 列表用)。 */
export function groupsAll(store) {
  return store.all('SELECT * FROM groups ORDER BY created');
}

/** 团队存在性检查(不抛错,供 404 判断)。 */
export function groupExists(store, groupId) {
  return Boolean(store.get('SELECT 1 FROM groups WHERE id=?', groupId));
}

/** 建群行:lead 先写 NULL,成员落库后再回填(避免循环外键顺序问题)。 */
export function insertGroup(store, { id, name, workspace, created, charter, policy, allowShell }) {
  return store.run(
    'INSERT INTO groups(id,name,workspace,lead,created,charter,policy,allow_shell) VALUES(?,?,?,?,?,?,?,?)',
    id, name, workspace, null, created, charter, policy, allowShell,
  );
}

export function setGroupLead(store, groupId, memberId) {
  return store.run('UPDATE groups SET lead=? WHERE id=?', memberId, groupId);
}

export function updateGroupState(store, groupId, state) {
  return store.run('UPDATE groups SET state=? WHERE id=?', state, groupId);
}

/** 团队回执的最新 seq(面板启动基线用)。 */
export function latestReceiptSeq(store) {
  return store.get('SELECT COALESCE(MAX(seq),0) AS seq FROM team_request_receipts').seq;
}

// --- members ----------------------------------------------------------------

/** 团队当前有效成员,按加入顺序(rowid)。 */
export function activeMembers(store, groupId) {
  return store.all('SELECT * FROM members WHERE group_id=? AND removed IS NULL ORDER BY rowid', groupId);
}

export function findMember(store, groupId, memberId) {
  return store.get('SELECT * FROM members WHERE group_id=? AND id=? AND removed IS NULL', groupId, memberId) ?? null;
}

/** 按历史角色名(规范化后的 key)解析成员。 */
export function findMemberByRoleName(store, groupId, nameKey) {
  return store.get(
    `SELECT m.* FROM members m JOIN role_names r ON r.member_id=m.id
     WHERE m.group_id=? AND m.removed IS NULL AND r.name_key=?`,
    groupId, nameKey,
  ) ?? null;
}

/** 跨团队按 id 取仍有效的成员(主控交还时校验原主 Agent)。 */
export function activeMemberById(store, memberId) {
  return store.get('SELECT * FROM members WHERE id=? AND removed IS NULL', memberId) ?? null;
}

/** 成员落库:模型选择允许为空(宿主默认)。 */
export function insertMember(store, { id, groupId, name, host, role, selection = null }) {
  return store.run(
    'INSERT INTO members(id,group_id,name,host,role,model_provider,model,reasoning_effort) VALUES(?,?,?,?,?,?,?,?)',
    id, groupId, name, host, role, selection?.model_provider ?? null, selection?.model ?? null, selection?.reasoning_effort ?? null,
  );
}

export function updateMemberModel(store, memberId, selection) {
  return store.run(
    'UPDATE members SET model_provider=?,model=?,reasoning_effort=? WHERE id=?',
    selection?.model_provider ?? null, selection?.model ?? null, selection?.reasoning_effort ?? null, memberId,
  );
}

export function updateMemberProfile(store, memberId, profile) {
  return store.run('UPDATE members SET profile=? WHERE id=?', profile, memberId);
}

/** 成员移除是软删除:历史消息、角色名与回合仍保留。 */
export function markMemberRemoved(store, memberId, removed = new Date().toISOString()) {
  return store.run('UPDATE members SET removed=? WHERE id=?', removed, memberId);
}

/** 名称是否已被本团队历史占用(成员移除后也不释放)。 */
export function roleNameTaken(store, groupId, nameKey) {
  return Boolean(store.get('SELECT 1 FROM role_names WHERE group_id=? AND name_key=?', groupId, nameKey));
}

// --- 主控(team_lead_controllers) -------------------------------------------

/** 团队主控行;没有行表示默认由 groups.lead 担任。 */
export function controllerAssignment(store, groupId) {
  return store.get('SELECT * FROM team_lead_controllers WHERE group_id=?', groupId) ?? null;
}

/** 接管:Panel Agent 成为 active 主控,记录原主 Agent 以便交还。 */
export function promoteToPanelController(store, { groupId, panelAgentId, originalLeadId, now }) {
  return store.run(
    `INSERT INTO team_lead_controllers(group_id,controller_kind,controller_id,state,original_lead_id,revision,updated)
     VALUES(?,'panel_agent',?,'active',?,1,?)
     ON CONFLICT(group_id) DO UPDATE SET controller_kind='panel_agent',controller_id=excluded.controller_id,state='active',original_lead_id=excluded.original_lead_id,revision=revision+1,updated=excluded.updated`,
    groupId, panelAgentId, originalLeadId, now,
  );
}

/** 交还:主控回到成员,清空 original_lead_id,revision +1。 */
export function handbackToMember(store, { groupId, memberId, now }) {
  return store.run(
    "UPDATE team_lead_controllers SET controller_kind='member',controller_id=?,state='active',original_lead_id=NULL,revision=revision+1,updated=? WHERE group_id=?",
    memberId, now, groupId,
  );
}

/** 建群时由 Panel Agent 直接担任主控(无原主 Agent)。 */
export function insertPanelController(store, { groupId, panelAgentId, now }) {
  return store.run(
    "INSERT INTO team_lead_controllers(group_id,controller_kind,controller_id,state,original_lead_id,revision,updated) VALUES(?,'panel_agent',?,'active',NULL,1,?)",
    groupId, panelAgentId, now,
  );
}

// --- 任务面板(agent_tasks) -------------------------------------------------

/** 写任务列表:非空 upsert,空列表删除该 owner 的行。 */
export function setAgentTasks(store, { ownerId, groupId, tasks, updated }) {
  if (tasks.length) {
    return store.run(
      'INSERT INTO agent_tasks(owner_id,group_id,tasks,updated) VALUES(?,?,?,?) ON CONFLICT(owner_id,group_id) DO UPDATE SET tasks=excluded.tasks,updated=excluded.updated',
      ownerId, groupId, JSON.stringify(tasks), updated,
    );
  }
  return store.run('DELETE FROM agent_tasks WHERE owner_id=? AND group_id=?', ownerId, groupId);
}

/** 团队任务面板投影(原始行,owner_kind 由调用方补)。 */
export function agentTasksForGroup(store, groupId) {
  return store.all('SELECT owner_id,group_id,tasks,updated FROM agent_tasks WHERE group_id=? ORDER BY updated DESC', groupId);
}

// --- 团队创建幂等(operation_records) ---------------------------------------

/** 建群请求编号回读;有行说明同编号已处理(可能已删除)。 */
export function groupCreateOperation(store, operationId) {
  return store.get("SELECT * FROM operation_records WHERE scope='group-create' AND client_key=?", operationId) ?? null;
}

export function recordGroupCreate(store, { operationId, payload, groupId, created }) {
  return store.run(
    "INSERT INTO operation_records(scope,scope_id,client_key,payload,ref,created) VALUES('group-create','',?,?,?,?)",
    operationId, payload, groupId, created,
  );
}
