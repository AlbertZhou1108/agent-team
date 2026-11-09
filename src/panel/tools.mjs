// Panel 工具:工具调用的鉴权/事件记账入口(panelTool)与实际工具分发(executePanelTool)。
// 接收 bus;面板表访问走聚合,其余域沿用 store 方法与 bus 既有入口。
import { randomUUID } from 'node:crypto';
import { assertReplyTarget, appendRoutedMessage, assertAskCard, askCardPayload, readSharedMessages } from '../tools/ops.mjs';
import { memberModelSummary } from '../model-policy.mjs';
import { validatePanelTool } from '../tools/panel.mjs';
import * as messagesAgg from '../aggregates/messages.mjs';
import * as turnsAgg from '../aggregates/turns.mjs';
import * as conversationsAgg from '../aggregates/conversations.mjs';
import * as panelAgg from '../aggregates/panel.mjs';

/**
 * Panel 工具调用入口:校验会话/回合归属,先广播 tool_call,再执行并广播 tool_result。
 * 失败只记录事件并原样抛出,不改工具语义。
 */
export async function panelTool(bus, sessionId, key, name, args, provenance = {}) {
  const { session, panelAgent } = panelAgg.authenticateSession(bus.store, sessionId, key);
  if (session.context === 'archive-summary') throw new Error('归档摘要不提供工具');
  validatePanelTool(session.context, name, args);
  const turnId = provenance.turnId;
  if (turnId && bus.running.get(sessionId)?.turnId !== turnId) throw new Error('工具不属于当前 Panel Agent 执行回合');
  const recordedTurn = turnId ? turnsAgg.find(bus.store, turnId, sessionId) : null;
  const activeTeamId = recordedTurn
    ? recordedTurn.active_team_id ?? null
    : provenance.activeTeamId ?? null;
  const callId = randomUUID();
  bus.events.panel(sessionId, {
    type: 'framework.tool_call',
    name,
    args,
    callId,
    nativeCallId: provenance.nativeCallId ?? null,
    activeTeamId,
  }, turnId);
  try {
    const result = await bus.executePanelTool(session, panelAgent, name, args, {
      turnId,
      callId,
      nativeCallId: provenance.nativeCallId ?? null,
      activeTeamId,
    });
    bus.measureToolCall({
      groupId: session.group_id ?? args.groupId ?? null,
      endpointId: session.id,
      turnId,
      name,
      args,
      result,
      schema: bus.information.panelSchemaForTurn(turnId) ?? bus.information.panelSchemaForSession(session),
    });
    bus.events.panel(sessionId, { type: 'framework.tool_result', callId, result }, turnId);
    return result;
  } catch (error) {
    bus.events.panel(sessionId, { type: 'framework.tool_result', callId, error: error.message }, turnId);
    throw error;
  }
}

/** Panel Agent 工具分发;所有写操作都先经过团队/主控/activeTeamId 校验。 */
export async function executePanelTool(bus, session, panelAgent, name, args, origin) {
  if (name === 'team_request_submit') return bus.teamRequests.submit(session, panelAgent, origin, args);
  if (name === 'team_receipt_publish') return bus.teamRequests.publish(session, panelAgent, origin, args);
  if (name === 'team_requests') {
    const requests = bus.teamRequests.list(panelAgent.id, session.context === 'coordination' ? session.group_id : args.groupId);
    return session.context === 'coordination' ? requests.map(({ original_text: _originalText, source_user_message_id: _sourceUserMessageId, ...request }) => request) : requests;
  }
  if (name === 'model_catalog') return bus.modelCatalog({ refresh: true });
  if (name === 'teams_list') return bus.panelTeamViews();
  if (name === 'team_create') {
    if (session.context !== 'private') throw new Error('团队创建只能在 Panel Agent 私人会话中执行');
    const group = bus.createPanelTeam(panelAgent, args);
    return group;
  }
  if (name === 'ask') {
    assertAskCard(args);
    const payload = askCardPayload(args);
    const anchor = bus.panelInteractionAnchor(session, panelAgent, origin, payload.text);
    const interaction = bus.store.createInteraction({
      id: randomUUID(),
      groupId: anchor.groupId,
      panelAgentId: panelAgent.id,
      endpointId: session.id,
      context: session.context,
      turnId: origin.turnId ?? '',
      callId: origin.callId,
      messageId: anchor.messageId,
      panelMessageId: anchor.panelMessageId,
      kind: payload.kind,
      payload,
    });
    return { interaction: interaction.id, state: interaction.state };
  }
  if (name === 'request_team_takeover' || name === 'request_team_handback') {
    if (session.context !== 'private' && origin.activeTeamId !== args.groupId) {
      throw new Error('控制动作请求必须与当前 activeTeamId 一致，请先切换团队上下文');
    }
    return bus.requestPanelControllerAction(
      panelAgent,
      session,
      origin,
      name === 'request_team_takeover' ? 'takeover' : 'handback',
      args.groupId,
    );
  }

  if (name === 'panel_update_publish') {
    const group = bus.store.group(session.group_id);
    bus.requirePanelMain(panelAgent.id, group.id);
    if (origin.activeTeamId !== group.id) {
      throw new Error('团队更新必须与当前 activeTeamId 一致，请先切换团队上下文');
    }
    const sourceMessageIds = origin.turnId
      ? turnsAgg.inputMessageIds(bus.store, origin.turnId)
      : [];
    const update = bus.publishPanelUpdate({
      panelAgentId: panelAgent.id,
      groupId: group.id,
      sourceTurnId: origin.turnId ?? null,
      text: args.text.trim(),
      sourceMessageIds,
    });
    return update;
  }

  const group = bus.store.group(args.groupId);
  if (group.state === 'archived') throw new Error('团队已归档，请在设置中恢复后访问');
  if (name === 'team_snapshot') return bus.panelTeamSnapshot(group.id);
  if (name === 'team_members') return bus.members(group.id);
  if (name === 'team_read') {
    const schema = bus.information.panelSchemaForTurn(origin.turnId) ?? bus.information.panelSchemaForSession(session);
    return readSharedMessages(bus, {
      groupId: group.id,
      args,
      schema,
      resolveSenderId: sender => (sender === panelAgent.id || sender === panelAgent.name
        ? panelAgent.id
        : sender
          ? bus.resolveMember(group.id, sender).id
          : null),
    });
  }
  if (name === 'team_message_trace') {
    if (!messagesAgg.existsInGroup(bus.store, args.messageId, group.id)) throw new Error('消息不属于当前团队');
    return bus.store.messageTrace(args.messageId);
  }
  if (name === 'team_turn_trace') {
    const trace = bus.store.turnTrace(args.turnId, args.after ?? 0);
    if (!trace || trace.turn.group_id !== group.id) throw new Error('回合不属于当前团队');
    return trace;
  }

  bus.requirePanelMain(panelAgent.id, group.id);
  if (origin.activeTeamId !== group.id) {
    throw new Error('团队写操作必须与当前 activeTeamId 一致，请先切换团队上下文');
  }
  const coordination = conversationsAgg.forPanelAgent(bus.store, panelAgent.id, 'coordination', { groupId: group.id });
  if (coordination.id !== session.id && bus.running.has(coordination.id)) {
    throw new Error('该团队的 Panel Agent coordination 正在运行，请等待后再写入');
  }
  if (name === 'team_send' || name === 'team_note') {
    bus.collaboration.requireCommunication(group.id);
    const target = bus.resolveMember(group.id, args.to);
    const expectsReply = name === 'team_send' && args.expects_reply === true;
    if (name === 'team_send' && args.reply_to !== undefined) {
      assertReplyTarget(bus.store, group.id, args.reply_to, panelAgent.id, target.id);
    }
    const stepRef = name === 'team_send' && args.step_ref
      ? bus.assertStepRef(group.id, panelAgent.id, args.step_ref)
      : null;
    const message = appendRoutedMessage(bus.store, {
      groupId: group.id,
      senderId: panelAgent.id,
      targetId: target.id,
      kind: name === 'team_send' ? 'send' : 'note',
      text: args.text,
      replyTo: args.reply_to ?? null,
      expectsReply,
      stepRef,
      origin,
    });
    bus.emit('message', message);
    bus.completeToolMessageStream(
      origin.turnId,
      name,
      args,
      { messageId: message.id },
      origin.nativeCallId,
    );
    queueMicrotask(() => bus.pump());
    return { messageId: message.id };
  }
  if (name === 'group_add') {
    bus.requireHost(args.host);
    return bus.addMember(group.id, args);
  }
  if (name === 'group_remove') return bus.removeMember(group.id, args.member);
  if (name === 'team_member_stop') {
    const target = bus.resolveMember(group.id, args.member);
    await bus.stopWhere(endpoint => endpoint.member_id === target.id);
    return { stopped: target.id, note: '当前回合已中断，未完成的工作可能丢失' };
  }
  if (name === 'group_member_model') {
    const target = bus.resolveMember(group.id, args.member);
    if (target.role !== 'member') throw new Error('group_member_model 只能调整普通成员');
    const selection = await bus.validateMemberModelSelection(target, args);
    return bus.requestPanelMemberModel(panelAgent, session, origin, group,
      `请求将成员 ${target.name} 的模型调整为 ${memberModelSummary(selection)}`,
      { member: args.member, ...(selection ?? {}) });
  }
  if (name === 'group_tasks_set') {
    return bus.setAgentTasks({ groupId: group.id, ownerId: panelAgent.id, tasks: args.tasks });
  }
  throw new Error('Panel Agent 工具不存在');
}
