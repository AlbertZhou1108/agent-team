// turns 聚合:回合生命周期与状态机的边界。业务模块只通过本模块读 turns/turn_inputs,
// 不再各自拼 SQL;写入口仍是 store.createTurn/setTurnState(事务与状态收敛点不搬),
// 这里提供带领域语义的读写面。所有函数接收 store,不持有全局状态。
//
// 不变式:
// - 回合状态机为 running / unknown / completed / failed / cancelled / stopped;
// - 一个会话同时最多一个 running 回合(由 bus.running 内存 Map 与调用方守卫共同保证);
// - unknown 只能由用户核实(unverified runtime)转出,不自动重放;
// - turn_inputs 的 ordinal 是该回合输入消息的稳定顺序。

/** 建回合:执行者归属写 (executor_kind, executor_id) 两列,输入按序落 turn_inputs。 */
export function create(store, conversation, options = {}) {
  return store.createTurn(conversation, options);
}

/** 状态写点收敛:所有执行者写同一列 turns.state。 */
export function setState(store, turnId, state, options = {}) {
  return store.setTurnState(turnId, state, options);
}

/** 回合的宿主会话快照(重启后恢复用)。 */
export function setSession(store, turnId, session) {
  return store.setTurnSession(turnId, session);
}

/** 按回合 id 读取;给出 conversationId 时同时校验归属(跨会话视为不存在)。 */
export function find(store, turnId, conversationId = null, { state = null } = {}) {
  const where = ['id=?'];
  const params = [turnId];
  if (conversationId != null) { where.push('conversation_id=?'); params.push(conversationId); }
  if (state != null) { where.push('state=?'); params.push(state); }
  const columns = conversationId != null ? 't.*,t.conversation_id AS session_id' : '*';
  return store.get(`SELECT ${columns} FROM turns t WHERE ${where.join(' AND ')}`, ...params) ?? null;
}

/** 会话是否还有待用户核实的运行(阻断该会话继续投递)。 */
export function hasUnknown(store, conversationId) {
  return Boolean(store.get("SELECT 1 FROM turns WHERE conversation_id=? AND state='unknown'", conversationId));
}

/** 单条 Panel 待核实回合(用户核实入口用)。 */
export function unknownPanelTurn(store, turnId) {
  return store.get(
    "SELECT * FROM turns WHERE id=? AND executor_kind='panel_agent' AND state='unknown'",
    turnId,
  ) ?? null;
}

/** 全部 Panel 待核实回合;给出 groupId 时只取该团队。 */
export function unknownPanelTurns(store, groupId = null) {
  return store.all(
    `SELECT t.*,c.context AS session_context FROM turns t JOIN conversations c ON c.id=t.conversation_id
     WHERE t.executor_kind='panel_agent' AND t.state='unknown' ${groupId ? 'AND t.group_id=?' : ''} ORDER BY t.created`,
    ...(groupId ? [groupId] : []),
  );
}

/** 回合输入消息 id,按 ordinal 排序。 */
export function inputMessageIds(store, turnId) {
  return store.all('SELECT message_id FROM turn_inputs WHERE turn_id=? ORDER BY ordinal', turnId)
    .map(row => row.message_id);
}

/** 某条消息所属回合是否为待核实 unknown(回执状态用)。 */
export function unknownTurnForMessage(store, messageId) {
  return store.get(
    `SELECT t.id AS turn_id FROM turn_inputs i JOIN turns t ON t.id=i.turn_id
     WHERE i.message_id=? AND t.state='unknown'`,
    messageId,
  ) ?? null;
}

/** 指令回合的输出恢复事件(completed 且已落 framework.output 历史)。 */
export function completedDirectiveOutputs(store) {
  return store.all(
    `SELECT DISTINCT h.turn_id,h.event FROM operation_records d
     JOIN turn_inputs i ON i.message_id=d.ref JOIN history h ON h.turn_id=i.turn_id
     JOIN turns t ON t.id=i.turn_id
     WHERE d.scope='team-directive' AND t.state='completed' AND json_extract(h.event,'$.type')='framework.output' ORDER BY h.seq`,
  );
}
