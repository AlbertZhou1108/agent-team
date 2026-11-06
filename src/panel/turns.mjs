// Panel 回合域:私聊/协作回合执行、私聊请求幂等、停止与待核实运行恢复、
// 私聊互动答复的持久投递。接收 bus;面板表访问走 aggregates/panel.mjs。
import { randomUUID, createHash } from 'node:crypto';
import { panelToolsFor } from '../panel-tools.mjs';
import { attachmentError } from '../attachments.mjs';
import * as messagesAgg from '../aggregates/messages.mjs';
import * as turnsAgg from '../aggregates/turns.mjs';
import * as conversationsAgg from '../aggregates/conversations.mjs';
import * as panelAgg from '../aggregates/panel.mjs';

/**
 * 执行一次 Panel 回合:运行态校验 -> 宿主/policy/schema/instructions 组装 ->
 * 交给 turnExecutor;收尾时落助手消息、发布协作回复并调度 pump。
 */
export async function runPanelTurn(bus, {
  sourceUserMessageId = null,
  session,
  panelAgent,
  prompt,
  activeTeamId = null,
  inputs = [],
  attachments = [],
  onAccepted = () => {},
}) {
  if (bus.running.has(session.id)) throw new Error('Panel Agent 会话正在运行');
  if (turnsAgg.hasUnknown(bus.store, session.id)) {
    throw new Error('Panel Agent 会话存在待核实运行，请先核实宿主已经停止');
  }
  if (session.context === 'coordination') {
    bus.requirePanelMain(panelAgent.id, session.group_id);
    bus.collaboration.requireCommunication(session.group_id);
    if (bus.panelUnknown(session.group_id).length) throw new Error('Panel Agent 团队存在待核实运行');
  }
  const host = bus.hosts.get(panelAgent.host);
  if (!host) throw new Error(`宿主未配置: ${panelAgent.host}`);
  const group = session.group_id ? bus.store.group(session.group_id) : null;
  const privateContext = session.context === 'private';
  const access = privateContext ? bus.panelAccessValue(panelAgent) : 'communication';
  if (privateContext) bus.requirePanelAccess(panelAgent.host, access);
  const privateWorkspace = privateContext ? (panelAgent.workspace ?? bus.store.directory) : null;
  const policy = privateContext
    ? { mode: access, allowShell: true, access, domain: 'project' }
    : { mode: 'communication', allowShell: false, domain: 'communication' };
  const schema = bus.information.rememberPanelSchema(session, bus.information.panelSchemaForStart(session));
  const instructions = bus.panelInstructions(session, panelAgent, activeTeamId);
  bus.information.assertRuleBudget(instructions, schema);
  const sourceMessage = sourceUserMessageId ? panelAgg.messageText(bus.store, sourceUserMessageId) : null;
  // 运行态端点保持存储层的原始 context;owner 身份由 owner_kind 表达,不再合成 panel-* 词汇。
  const liveEndpoint = { ...session, group_id: session.group_id ?? null };
  const hostEndpoint = { ...session, group_id: session.group_id ?? null };
  return bus.turnExecutor.run({
    conversation: session,
    actor: panelAgent,
    host,
    executorKind: 'panel_agent',
    executorId: panelAgent.id,
    inputs,
    prompt,
    instructions,
    schema,
    policy,
    previousPolicy: session.policy_signature ? { signature: session.policy_signature } : null,
    workspace: privateContext ? privateWorkspace : (group?.workspace ?? bus.store.directory),
    tools: panelToolsFor(session.context),
    attachments,
    hostEndpoint,
    liveEndpoint,
    activeTeamId,
    sourceUserMessageId,
    phaseGroupId: activeTeamId,
    emit: (turnId, event) => bus.events.panel(session.id, event, turnId),
    executeTool: (turnId, name, args, metadata) => bus.panelTool(session.id, session.key, name, args, {
      ...metadata,
      turnId,
      activeTeamId,
    }),
    accepted: turnId => onAccepted(turnId),
    onSession: (turnId, value) => {
      conversationsAgg.setSession(bus.store, session.id, value);
      session.session = value;
    },
    onPolicy: (turnId, signature) => {
      conversationsAgg.setPolicySignature(bus.store, session.id, signature);
      session.policy_signature = signature;
    },
    onStart: turnId => bus.events.panel(session.id, {
      type: 'framework.context',
      activeTeamId,
      relation: activeTeamId ? bus.panelTeamRelation(activeTeamId) : null,
      contextSchemaVersion: schema,
      ...(privateContext ? { workspace: privateWorkspace, access } : {}),
    }, turnId),
    rememberSchema: turnId => bus.information.rememberTurnSchema(turnId, 'panel', schema),
    createToolStream: turnId => {
      if (session.context !== 'coordination') return null;
      const scope = {
        groupId: session.group_id,
        endpointId: session.id,
        memberId: panelAgent.id,
        memberName: panelAgent.name,
        host: panelAgent.host,
        context: session.context,
        turnId,
      };
      const run = bus.createToolStreamRun(scope);
      return payload => bus.observeToolStreamDelta(scope, run.streams, payload);
    },
    streamFactories: turnId => ({
      panel: {
        homeSummary: privateContext && Boolean(sourceMessage?.text.startsWith('[主页进展摘要]')),
        sourceUserMessageId,
        agentId: panelAgent.id,
        sessionId: session.id,
        turnId,
        context: session.context,
        activeTeamId,
        text: '',
        reasoning: '',
        runPhase: 'accepted',
        tool: null,
        created: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      team: session.context === 'coordination' && inputs.some(message => message.sender === 'user')
        ? {
            id: turnId,
            groupId: session.group_id,
            endpointId: session.id,
            memberId: panelAgent.id,
            memberName: panelAgent.name,
            recipientName: '用户',
            pairKey: '',
            kind: 'reply',
            host: panelAgent.host,
            context: session.context,
            turnId,
            text: '',
            reasoning: '',
            runPhase: 'accepted',
            tool: null,
            created: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }
        : null,
    }),
    measure: { groupId: session.group_id ?? null, fixed: false },
    telemetry: { groupId: session.group_id, sessionKey: 'default', host: panelAgent.host, context: session.context, turnKind: 'panel' },
    getHostSessionId: () => session.session ?? null,
    onComplete: (turnId, result, abort) => {
      if (result) {
        const finalActiveTeamId = turnsAgg.find(bus.store, turnId)?.active_team_id ?? activeTeamId;
        panelAgg.appendMessage(bus.store, panelAgent.id, session.context, 'assistant', String(result), finalActiveTeamId);
      }
      const publishedReplies = !abort.signal.aborted && session.context === 'coordination'
        ? bus.teamDirectives.publishOutput(turnId, result)
        : [];
      return publishedReplies?.[0] ?? messagesAgg.finalReplyForTurn(bus.store, turnId);
    },
    nativeTurnEvent: true,
    failureDetail: false,
    onFinally: () => setImmediate(() => bus.pump()),
  });
}

// 稳定的请求指纹:正文与附件顺序共同构成;同 ID 不同内容必须被拒绝。
export function panelRequestHash(text, attachmentIds) {
  return createHash('sha256').update(JSON.stringify({ text, attachmentIds })).digest('hex');
}

export function isUniqueViolation(error) {
  return error?.errstr?.includes('SQLITE_CONSTRAINT') || String(error?.message ?? '').includes('UNIQUE constraint failed');
}

// 幂等重试:返回原请求的用户消息及其后的回复状态,不再创建消息或触发回合。
export function replayPanelRequest(bus, panelAgentId, request) {
  const message = panelAgg.messageById(bus.store, request.ref);
  const reply = message
    ? panelAgg.latestPrivateAssistantAfter(bus.store, panelAgentId, message.seq)
    : null;
  return {
    message: message ?? null,
    reply: reply ?? null,
    result: { replayed: true },
    activeTeamId: message?.active_team_id ?? null,
  };
}

/** 私聊回合:参数校验 -> 幂等层 -> 事务内落用户消息/附件/请求记录 -> 调宿主。 */
export async function panelPrivateTurn(bus, { text, activeTeamId = null, clientMessageId = null, attachmentIds = [] }) {
  const panelAgent = bus.panelAgent();
  if (!panelAgent) throw new Error('Panel Agent 尚未创建');
  if (typeof text !== 'string' || text.length > 48000) throw new Error('Panel Agent 输入无效');
  if (activeTeamId) throw new Error('团队对话已迁移到团队协作会话，请从团队页面发送');
  if (!Array.isArray(attachmentIds) || attachmentIds.some(id => typeof id !== 'string' || !id)) throw new Error('附件列表无效');

  const prompt = text.trim();
  // 正文和附件都为空才拒绝;附件-only 是合法消息。
  if (!prompt && !attachmentIds.length) throw new Error('消息内容不能为空');

  // 幂等层:clientMessageId 缺省时保持旧客户端兼容,不写 operation 记录。
  let payloadHash = null;
  if (clientMessageId != null) {
    if (typeof clientMessageId !== 'string' || !clientMessageId.trim() || clientMessageId.length > 200) throw new Error('clientMessageId 无效');
    payloadHash = panelRequestHash(prompt, attachmentIds);
    const existing = panelAgg.panelPrivateOperation(bus.store, panelAgent.id, clientMessageId);
    if (existing) {
      if (existing.payload !== payloadHash) {
        throw attachmentError('conflict', '同一消息 ID 已用于不同的正文或附件,请刷新会话后重新发送');
      }
      return replayPanelRequest(bus, panelAgent.id, existing);
    }
  }

  const settings = bus.store.attachmentSettings();
  if (attachmentIds.length > settings.maxFilesPerMessage) {
    throw new Error(`附件数量超过单条消息上限 ${settings.maxFilesPerMessage}`);
  }

  // 提交顺序固定:一个事务内验证附件、创建用户消息、写入有序关联和 request 记录;提交成功后才调宿主。
  let user;
  try {
    bus.store.transaction(() => {
      user = panelAgg.appendMessage(bus.store, panelAgent.id, 'private', 'user', prompt, null);
      if (attachmentIds.length) bus.attachments.bindTx(panelAgent.id, user.id, attachmentIds);
      if (clientMessageId != null) {
        panelAgg.insertPanelPrivateOperation(bus.store, {
          panelAgentId: panelAgent.id,
          clientKey: clientMessageId,
          payload: payloadHash,
          ref: user.id,
          created: new Date().toISOString(),
        });
      }
    });
  } catch (error) {
    // 并发同 ID 提交:唯一键冲突时按幂等语义回放或拒绝。
    if (clientMessageId != null && isUniqueViolation(error)) {
      const existing = panelAgg.panelPrivateOperation(bus.store, panelAgent.id, clientMessageId);
      if (existing) {
        if (existing.payload !== payloadHash) {
          throw attachmentError('conflict', '同一消息 ID 已用于不同的正文或附件,请刷新会话后重新发送');
        }
        return replayPanelRequest(bus, panelAgent.id, existing);
      }
    }
    throw error;
  }

  // 宿主调用前准备附件输入;文件缺失在此明确报错,不悄悄只发文字。
  const preparedAttachments = attachmentIds.length ? bus.attachmentPrepare(panelAgent.id, attachmentIds) : [];
  const session = conversationsAgg.forPanelAgent(bus.store, panelAgent.id, 'private');
  let accepted = false;
  let acceptedTurnId = null;
  try {
    const result = await runPanelTurn(bus, {
      session,
      panelAgent,
      sourceUserMessageId: user.id,
      prompt,
      activeTeamId: null,
      attachments: preparedAttachments,
      onAccepted: turnId => {
        accepted = true;
        acceptedTurnId = turnId;
      },
    });
    let finalActiveTeamId = activeTeamId ?? null;
    if (acceptedTurnId) {
      finalActiveTeamId = turnsAgg.find(bus.store, acceptedTurnId)?.active_team_id ?? finalActiveTeamId;
    }
    if (finalActiveTeamId && finalActiveTeamId !== (activeTeamId ?? null)) {
      panelAgg.setMessageActiveTeamId(bus.store, user.id, finalActiveTeamId);
      user.active_team_id = finalActiveTeamId;
    }
    return {
      message: user,
      reply: panelAgg.latestPrivateMessage(bus.store, panelAgent.id),
      result,
      activeTeamId: finalActiveTeamId,
    };
  } catch (error) {
    throw Object.assign(error, { panelMessageId: user.id, accepted });
  }
}

/** 停止 Panel Agent 私聊运行:abort 并等待全部收尾。 */
export async function stopPanel(bus) {
  const agent = bus.panelAgent();
  if (!agent) return { stopped: [] };
  const active = [...bus.running.values()].filter(item => item.endpoint.owner_kind === 'panel_agent' && item.endpoint.context === 'private');
  for (const item of active) item.abort.abort();
  await Promise.allSettled(active.map(item => item.done));
  return { stopped: active.map(item => item.turnId) };
}

/** 用户核实「宿主已停止」:unknown -> stopped,并广播核实事件。 */
export function resolvePanelRuntime(bus, turnId, reason) {
  if (typeof reason !== 'string' || !reason.trim()) throw new Error('需要说明停止核实依据');
  const turn = turnsAgg.unknownPanelTurn(bus.store, turnId);
  if (!turn) throw new Error('待核实 Panel Agent 运行不存在');
  turnsAgg.setState(bus.store, turnId, 'stopped');
  bus.events.panel(turn.conversation_id, {
    type: 'framework.runtime_verified_by_user',
    turnId,
    reason: reason.trim(),
  }, turnId);
  bus.pump();
  return { turnId, state: 'stopped' };
}

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

// 私聊互动答复的持久投递入口:答复文本先落 panel_messages(用户立即可见),
// outbox 行只持投递任务;忙碌/待核实时由 pump 挂起,重启后仍可补投。
// 与团队消息共用同一张 outbox 表,payload 形状为 {kind:'panel-private', panelMessageId}。
export function enqueuePanelPrivateAnswer(bus, agentId, text) {
  const agent = bus.panelAgent();
  if (!agent || agent.id !== agentId) return;
  const session = conversationsAgg.forPanelAgent(bus.store, agent.id, 'private');
  bus.store.transaction(() => {
    const row = panelAgg.appendMessage(bus.store, agent.id, 'private', 'user', text, null);
    messagesAgg.enqueueDelivery(bus.store, randomUUID(), session.id, { kind: 'panel-private', panelMessageId: row.id });
  });
  queueMicrotask(() => bus.pump());
}
