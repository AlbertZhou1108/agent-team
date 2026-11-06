// Panel 互动卡:控制动作(takeover/handback)与成员模型调整请求。
// 接收 bus;互动卡表沿用 interactions 域 store 方法,面板消息锚点走聚合。
import { randomUUID } from 'node:crypto';
import { interactionView } from '../interactions.mjs';
import * as messagesAgg from '../aggregates/messages.mjs';
import * as panelAgg from '../aggregates/panel.mjs';

/** 互动卡的锚点消息:协作会话写团队消息并广播,私聊写 assistant 面板消息。 */
export function panelInteractionAnchor(bus, session, panelAgent, origin, text) {
  if (session.context === 'coordination') {
    const groupId = session.group_id;
    const message = messagesAgg.append(bus.store, groupId, panelAgent.id, 'user', 'send', text);
    bus.emit('message', message);
    return { groupId, messageId: message.id, panelMessageId: null };
  }
  const row = panelAgg.appendMessage(bus.store, panelAgent.id, 'private', 'assistant', text, null);
  return { groupId: null, messageId: null, panelMessageId: row.id };
}

/**
 * 请求接管/交还团队:同一主控版本只保留一张待处理卡;
 * 主控版本变化时旧卡作废并重新发起,卡片只承载征询,不构成授权门禁。
 */
export function requestPanelControllerAction(bus, panelAgent, session, origin, action, groupId) {
  if (!['takeover', 'handback'].includes(action)) throw new Error('控制动作无效');
  const relation = bus.panelTeamRelation(groupId);
  if (action === 'takeover' && relation !== 'observer') throw new Error('团队当前不是观察状态');
  if (action === 'handback' && relation !== 'main') throw new Error('Panel Agent 当前不是该团队主 Agent');
  const revision = panelAgg.controller(bus.store, groupId)?.revision ?? 0;
  const existing = panelAgg.pendingPanelInteraction(bus.store, { panelAgentId: panelAgent.id, groupId, kind: action });
  if (existing) {
    if (JSON.parse(existing.payload).baseRevision === revision) return interactionView(existing);
    bus.store.setInteractionState(existing.id, 'cancelled', null, null, '控制者版本已变化');
  }
  const groupName = bus.store.group(groupId).name;
  const text = action === 'takeover'
    ? `请求接管团队「${groupName}」`
    : `请求将团队「${groupName}」交还原主 Agent`;
  const anchor = bus.panelInteractionAnchor(session, panelAgent, origin, text);
  const row = bus.store.createInteraction({
    id: randomUUID(),
    groupId,
    panelAgentId: panelAgent.id,
    endpointId: session.id,
    context: session.context,
    turnId: origin.turnId ?? '',
    callId: origin.callId,
    messageId: anchor.messageId,
    panelMessageId: anchor.panelMessageId,
    kind: action,
    payload: { kind: action, text, groupId, baseRevision: revision, cardOnly: true },
  });
  return interactionView(row);
}

/** 请求调整成员模型:复用 interactions 域的动作卡实现,锚点由面板锚点补。 */
export function requestPanelMemberModel(bus, panelAgent, session, origin, group, text, args) {
  return bus.interactions.requestActionCard({
    requesterKind: 'panel_agent',
    requesterId: panelAgent.id,
    groupId: group.id,
    endpoint: session,
    origin,
    kind: 'member_model',
    text,
    args,
    anchor: anchorText => {
      const anchor = bus.panelInteractionAnchor(session, panelAgent, origin, anchorText);
      return { groupId: group.id, messageId: anchor.messageId, panelMessageId: anchor.panelMessageId };
    },
  });
}
