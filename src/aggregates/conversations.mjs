// conversations 聚合:会话身份(owner)、context 约束与会话级绑定(conversation_session_meta)的
// 不变式边界。业务模块只通过本模块读这些表,不再各自拼 SQL;分析型查询仍可直接用 store.all。
// 所有函数接收 store,不持有全局状态。
//
// 不变式:
// - owner 二选一:member_id 或 panel_agent_id 恰好一列非空(conversations 的 CHECK 约束);
// - context 仍是 coordination / pair:<peer> / private / profile;
// - 同一 owner + context 复用同一会话行,不重复建;
// - 会话绑定(binding)按 (conversation_id, session_key) 唯一,session_key 默认 'default';
// - policy_signature 同时写在 conversations 与对应 binding 行上,重建会话时一起清空。

/** 按 id 读取会话并统一 owner 投影(owner_kind/owner_id)。 */
export function byId(store, id) {
  return store.conversationById(id);
}

/** 写回宿主会话快照(conversations.session)。 */
export function setSession(store, id, session) {
  return store.setConversationSession(id, session);
}

/** 写策略签名:同时落 conversations 与该 session_key 的 binding 行。 */
export function setPolicySignature(store, id, signature, sessionKey = 'default') {
  return store.setConversationPolicySignature(id, signature, sessionKey);
}

/** 成员侧会话入口:同一 (member, context) 复用同一行。 */
export function forMember(store, memberId, context, options = {}) {
  return store.conversation('member', memberId, context, options);
}

/** Panel Agent 侧会话入口:private 单例,coordination 按团队唯一。 */
export function forPanelAgent(store, panelAgentId, context, options = {}) {
  return store.conversation('panel_agent', panelAgentId, context, options);
}

/**
 * 一次读取宿主会话绑定与上一份策略签名,避免调用方分三条 SQL 各查一遍。
 * binding 只在 session 非空时成立;previousPolicy 先看 binding 行的 policy_signature,
 * 兼容旧库(没有 binding 行时回落 conversations.policy_signature)。
 */
export function sessionState(store, conversationId, sessionKey, { fallbackSession = null } = {}) {
  // 一次查询同时取会话与对应 binding 行;binding 列在无绑定行时为 NULL。
  const row = store.get(
    `SELECT c.policy_signature AS conversation_policy,m.conversation_id,m.session_key,m.session,
            m.session_updated,m.policy_signature,m.schema_version,m.format_source,m.format_created,m.format_updated
     FROM conversations c LEFT JOIN conversation_session_meta m
       ON m.conversation_id=c.id AND m.session_key=?
     WHERE c.id=?`,
    sessionKey, conversationId,
  );
  if (!row) return { binding: null, previousPolicy: null };
  const { conversation_policy: conversationPolicy, ...meta } = row;
  const binding = meta.session != null ? meta : null;
  const previousPolicy = meta.policy_signature
    ?? (!binding && fallbackSession ? conversationPolicy ?? null : null);
  return { binding, previousPolicy };
}

/** 保存宿主会话绑定:同一 (conversation, session_key) 覆盖 session,不动策略签名。 */
export function saveBinding(store, conversationId, sessionKey, session) {
  return store.run(
    'INSERT INTO conversation_session_meta(conversation_id,session_key,session,session_updated) VALUES(?,?,?,?) ON CONFLICT(conversation_id,session_key) DO UPDATE SET session=excluded.session,session_updated=excluded.session_updated',
    conversationId, sessionKey, session, new Date().toISOString(),
  );
}

/** 重建会话时需要轮换的 session_key 列表(所有带 session 的绑定)。 */
export function sessionKeysForRotation(store, conversationId) {
  return store.all(
    'SELECT session_key FROM conversation_session_meta WHERE conversation_id=? AND session IS NOT NULL',
    conversationId,
  ).map(row => row.session_key);
}

/**
 * 清空会话绑定,返回剩余的 session(全清时为 null),不重放历史。
 * 指定 sessionKey 时只清该绑定;否则清全部 binding 并同时清 conversations.policy_signature。
 */
export function resetBindings(store, conversationId, sessionKey = null) {
  if (sessionKey) {
    store.run('DELETE FROM conversation_session_meta WHERE conversation_id=? AND session_key=?', conversationId, sessionKey);
    return store.get(
      'SELECT session FROM conversation_session_meta WHERE conversation_id=? AND session IS NOT NULL ORDER BY session_updated DESC LIMIT 1',
      conversationId,
    )?.session ?? null;
  }
  store.run('DELETE FROM conversation_session_meta WHERE conversation_id=?', conversationId);
  store.run('UPDATE conversations SET policy_signature=NULL,updated=? WHERE id=?', new Date().toISOString(), conversationId);
  // 全清后该会话已无 binding 行,剩余 session 必然为空,不必再查。
  return null;
}

/** 团队删除时级联清理所需的会话 id 列表。 */
export function idsForGroup(store, groupId) {
  return store.all('SELECT id FROM conversations WHERE group_id=?', groupId);
}

/** Panel Agent 的状态投影用会话列表(不含 owner 装饰,保持既有返回形状)。 */
export function sessionsForPanelAgent(store, panelAgentId) {
  return store.all('SELECT id,context,group_id,session,updated FROM conversations WHERE panel_agent_id=? ORDER BY created', panelAgentId);
}

/** 宿主/模型变更后清空 Panel Agent 会话的 session 与策略签名(privateOnly 只清私聊)。 */
export function clearSessionsForPanelAgent(store, panelAgentId, { privateOnly = false } = {}) {
  const now = new Date().toISOString();
  return privateOnly
    ? store.run("UPDATE conversations SET session=NULL,policy_signature=NULL,updated=? WHERE panel_agent_id=? AND context='private'", now, panelAgentId)
    : store.run('UPDATE conversations SET session=NULL,policy_signature=NULL,updated=? WHERE panel_agent_id=?', now, panelAgentId);
}

// --- 上下文格式(schema_version / format_*;information 的存储边界) ----------
// 「上下文格式」的版本选择与兼容策略仍由 information 决定,但事实行在
// conversation_session_meta;这里只提供纯存取,避免 information 直写绑定表。

/** 读取某会话在指定 session_key 上的格式行;无行时 null。 */
export function contextFormat(store, conversationId, sessionKey = 'default') {
  return store.get(
    'SELECT schema_version,format_source,format_created,format_updated FROM conversation_session_meta WHERE conversation_id=? AND session_key=?',
    conversationId, sessionKey,
  ) ?? null;
}

/** 该会话最近一次已记录的 schema_version(无记录时 null)。 */
export function latestSchemaForConversation(store, conversationId) {
  return store.get(
    'SELECT schema_version FROM conversation_session_meta WHERE conversation_id=? AND schema_version IS NOT NULL ORDER BY format_updated DESC LIMIT 1',
    conversationId,
  )?.schema_version ?? null;
}

/** 记录上下文格式:只写 schema_version/format_*,不触碰 session/policy 列。 */
export function saveContextFormat(store, conversationId, sessionKey, { schemaVersion, source }) {
  const timestamp = new Date().toISOString();
  return store.run(
    `INSERT INTO conversation_session_meta(conversation_id,session_key,schema_version,format_source,format_created,format_updated) VALUES(?,?,?,?,?,?)
     ON CONFLICT(conversation_id,session_key) DO UPDATE SET schema_version=excluded.schema_version,format_source=excluded.format_source,format_created=excluded.format_created,format_updated=excluded.format_updated`,
    conversationId, sessionKey, schemaVersion, source, timestamp, timestamp,
  );
}

/** 清空上下文格式记录(与会话绑定共用一行,删除整行;不重放历史)。 */
export function forgetContextFormats(store, conversationId, sessionKey = null) {
  if (sessionKey) return store.run('DELETE FROM conversation_session_meta WHERE conversation_id=? AND session_key=?', conversationId, sessionKey);
  return store.run('DELETE FROM conversation_session_meta WHERE conversation_id=?', conversationId);
}
