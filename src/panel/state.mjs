// Panel 状态投影:面板工作台状态、浏览器增量状态、私聊分页/增量读取、待核实运行。
// 只读投影,接收 bus;面板表访问统一走 aggregates/panel.mjs。
import * as conversationsAgg from '../aggregates/conversations.mjs';
import * as panelAgg from '../aggregates/panel.mjs';
import * as turnsAgg from '../aggregates/turns.mjs';

// 历史行附加结构化附件 DTO:只对确有附件的消息逐条补齐,避免每条消息都查库。
export function withPanelAttachments(bus, agentId, rows) {
  const bound = new Set(panelAgg.panelMessageIdsWithAttachments(bus.store, agentId));
  if (!bound.size) return rows;
  return rows.map(row => (bound.has(row.id) ? { ...row, attachments: bus.attachmentDescribeMessage(agentId, row.id) } : row));
}

/** 面板工作台完整状态投影;未创建 Panel Agent 时返回空骨架。 */
export function panelAgentState(bus, summary = false) {
  const agent = bus.panelAgent();
  if (!agent) return { agent: null, sessions: [], teams: [], conversation: [] };
  bus.ensurePanelBindings();
  return {
    agent,
    requests: bus.teamRequests.list(agent.id),
    teamPendingInteractions: panelAgg.pendingInteractionCounts(bus.store),
    // 通知是投递台账的投影:用户「清理」只记录一条隐藏状态(workbench_dismissals),
    // 台账行本身保留,投递判定与回溯都不受影响。
    notifications: panelAgg.notifications(bus.store, agent.id).map(row => bus.panelUpdate(row)),
    sessions: conversationsAgg.sessionsForPanelAgent(bus.store, agent.id),
    teams: bus.panelTeamViews(),
    conversation: withPanelAttachments(bus, agent.id, panelAgg.privateMessagesForState(bus.store, agent.id, summary)),
    running: [...bus.running.values()]
      .filter(item => item.endpoint.owner_kind === 'panel_agent')
      .map(item => ({ endpoint: item.endpoint.id, groupId: item.activeTeamId ?? item.endpoint.group_id ?? null, turnId: item.turnId, created: item.created ?? null })),
    unknown: bus.panelUnknown(),
    streaming: bus.panelStreaming(agent.id),
  };
}

/** 浏览器增量状态:在完整状态上按 bootId/bootSeq 过滤已读部分。 */
export function panelBrowserState(bus, summary = false) {
  const state = bus.panelAgentState(summary);
  const active = new Set(panelAgg.activeGroupIds(bus.store));
  return { ...state, bootId: bus.panelBootId, bootSeq: bus.panelBootSeq,
    conversation: state.conversation.filter(row => row.seq > bus.panelBootSeq),
    teams: state.teams.filter(row => active.has(row.id)),
    requests: (state.requests ?? []).filter(row => active.has(row.group_id) && ((panelAgg.messageSeq(bus.store, row.source_user_message_id) ?? 0) > bus.panelBootSeq || row.receipts.some(receipt => receipt.seq > bus.panelBootReceiptSeq))),
    notifications: (state.notifications ?? []).filter(row => active.has(row.group_id)),
    sessions: state.sessions.filter(row => !row.group_id || active.has(row.group_id)),
    unknown: (state.unknown ?? []).filter(row => row.session_context === 'archive-summary' || !row.group_id || active.has(row.group_id)),
    teamPendingInteractions: Object.fromEntries(Object.entries(state.teamPendingInteractions ?? {}).filter(([id]) => active.has(id))),
  };
}

/** 私聊历史分页:默认取 bootSeq 之后;history=true 取历史,可继续用 before 向前翻。 */
export function panelMessagePage(bus, { history = false, before = 0 } = {}) {
  const agent = bus.panelAgent();
  if (!agent) return { messages: [], nextBefore: null, bootId: bus.panelBootId };
  const rows = panelAgg.privateMessagePage(bus.store, agent.id, { history, before, bootSeq: bus.panelBootSeq });
  const hasMore = rows.length > 200;
  const messages = withPanelAttachments(bus, agent.id, rows.slice(0, 200).reverse());
  return { messages, nextBefore: hasMore ? messages[0].seq : null, bootId: bus.panelBootId };
}

/** 私聊增量读取:after 游标之后的 200 条。 */
export function panelConversation(bus, after = 0) {
  const agent = bus.panelAgent();
  if (!agent) return { messages: [], nextAfter: after };
  const messages = withPanelAttachments(
    bus,
    agent.id,
    panelAgg.privateMessagesAfter(bus.store, agent.id, after),
  );
  return { messages, nextAfter: messages.at(-1)?.seq ?? after };
}

/** 待核实的 Panel Agent 运行;groupId 缺省时返回全部。 */
export function panelUnknown(bus, groupId = null) {
  return turnsAgg.unknownPanelTurns(bus.store, groupId);
}
