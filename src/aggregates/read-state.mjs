// 读水位的读写边界：只记录「某个会话看到第几号」，不给每条消息打已读标记。
//
// 两类会话各自一套编号：群消息用 messages.seq，面板私聊用 panel_messages.seq，
// 所以 scope 必须区分，且水位只能与同类编号比较。
//   scope='group'  scope_id=<group_id>
//   scope='panel'  scope_id=`<panel_agent_id>:<teamId|__global__>`
// 私聊按团队分桶，看团队 A 的会话不会推进团队 B 的水位。

export const READ_SCOPES = new Set(['group', 'panel']);
/** 不属于任何团队的私聊消息归到这个桶。 */
export const GLOBAL_TEAM = '__global__';

/** @param {string} panelAgentId @param {string | null | undefined} teamId */
export function panelScopeId(panelAgentId, teamId) {
  return `${panelAgentId}:${teamId || GLOBAL_TEAM}`;
}

/** 当前水位；没有记录视为 0（全部未读）。只在本模块内使用。 @param {any} store */
function watermark(store, scope, scopeId) {
  return store.get('SELECT seq FROM read_watermarks WHERE scope=? AND scope_id=?', scope, scopeId)?.seq ?? 0;
}

/**
 * 推进水位：只允许单调前进，落后的请求不会让已读退回未读。
 * @param {any} store @param {{scope: string, scopeId: string, seq: number}} input
 */
export function advance(store, { scope, scopeId, seq }) {
  if (!Number.isInteger(seq) || seq < 0) throw new Error('读水位序号无效');
  store.run(
    `INSERT INTO read_watermarks(scope,scope_id,seq,updated) VALUES(?,?,?,?)
     ON CONFLICT(scope,scope_id) DO UPDATE SET seq=excluded.seq,updated=excluded.updated
     WHERE excluded.seq > read_watermarks.seq`,
    scope,
    scopeId,
    seq,
    new Date().toISOString(),
  );
  return watermark(store, scope, scopeId);
}

/**
 * 群会话的未读：只统计「发给用户」的消息。
 * 互动卡锚点虽然也是发给用户的行，但卡片本身已经计入待办，不能再算未读。
 * @param {any} store
 */
export function unreadGroups(store) {
  return store.all(`SELECT m.group_id AS scopeId,COUNT(*) AS count,MAX(m.seq) AS latestSeq,MAX(m.created) AS latest
    FROM messages m JOIN groups g ON g.id=m.group_id
    LEFT JOIN read_watermarks w ON w.scope='group' AND w.scope_id=m.group_id
    WHERE (g.state IS NULL OR g.state!='archived')
      AND m.recipient='user' AND m.seq>COALESCE(w.seq,0)
      AND NOT EXISTS(SELECT 1 FROM interactions i WHERE i.message_id=m.id)
    GROUP BY m.group_id`);
}

/**
 * 面板私聊的未读，按团队分桶。
 * 回执的私聊副本只是展示（receipt_id 非空），事实归属群里那一条；
 * active_team_id 指向已删除团队的消息不计数，否则会留下清不掉的红点。
 * @param {any} store @param {string} panelAgentId
 */
export function unreadPanel(store, panelAgentId) {
  return store.all(`SELECT COALESCE(NULLIF(p.active_team_id,''),'${GLOBAL_TEAM}') AS teamId,COUNT(*) AS count,MAX(p.seq) AS latestSeq,MAX(p.created) AS latest
    FROM panel_messages p
    LEFT JOIN read_watermarks w ON w.scope='panel' AND w.scope_id=? || ':' || COALESCE(NULLIF(p.active_team_id,''),'${GLOBAL_TEAM}')
    WHERE p.panel_agent_id=? AND p.context='private' AND p.role IN ('assistant','system')
      AND p.receipt_id IS NULL AND p.seq>COALESCE(w.seq,0)
      AND (p.active_team_id IS NULL OR p.active_team_id='' OR EXISTS(SELECT 1 FROM groups g WHERE g.id=p.active_team_id))
      AND NOT EXISTS(SELECT 1 FROM interactions i WHERE i.panel_message_id=p.id)
    GROUP BY teamId`, panelAgentId, panelAgentId);
}

/** 团队恢复时把群水位推到最后一条，避免归档期间的消息一次涌入。 */
export function resetGroupToCurrent(store, groupId) {
  const seq = store.get('SELECT COALESCE(MAX(seq),0) AS seq FROM messages WHERE group_id=?', groupId).seq;
  return advance(store, { scope: 'group', scopeId: groupId, seq });
}

/** 同上，针对面板私聊中属于该团队的桶。 @param {any} store */
export function resetPanelTeamToCurrent(store, panelAgentId, teamId) {
  const seq = store.get(
    `SELECT COALESCE(MAX(seq),0) AS seq FROM panel_messages
     WHERE panel_agent_id=? AND context='private' AND COALESCE(NULLIF(active_team_id,''),'${GLOBAL_TEAM}')=?`,
    panelAgentId,
    teamId || GLOBAL_TEAM,
  ).seq;
  return advance(store, { scope: 'panel', scopeId: panelScopeId(panelAgentId, teamId), seq });
}
