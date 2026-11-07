import { randomUUID } from 'node:crypto';
import { toolsFor } from './tools.mjs';
import { CONTEXT_SCHEMA_VERSION } from './information.mjs';
import { legacyGroupDeliveryPrompt, legacyPanelDeliveryPrompt } from './prompts.mjs';
import * as messagesAgg from './aggregates/messages.mjs';
import * as turnsAgg from './aggregates/turns.mjs';
import * as conversationsAgg from './aggregates/conversations.mjs';

// 消息调度:outbox 与待处理消息的投递循环、成员回合执行与会话重建。
// 本模块不反向依赖 Bus;跨职责调用经 bus 引用。

export class MessageDispatch {
  constructor(bus) {
    this.bus = bus;
  }
  notify(groupId, recipient, text) {
    if (this.bus.closing || !recipient || !this.bus.store.get('SELECT 1 FROM groups WHERE id=?', groupId)) return;
    const notice = messagesAgg.append(this.bus.store, groupId, 'system', recipient, 'system', text);
    this.bus.emit('notice', notice);
  }
  /** 回合输入中的计划与预算:主控读自己的当前计划,普通成员只读自己的任务上限。 */
  roundTaskContext(groupId, ownerId) {
    const controller = this.bus.teamController(groupId);
    const revision = controller.assignment?.revision ?? 0;
    if (controller.id === ownerId) {
      const plan = this.bus.currentPlan(groupId);
      const pendingCancellations = this.bus.pendingCancellations(groupId);
      return {
        plan: {
          planId: plan?.planId ?? `plan-${revision}`,
          revision,
          limit: 20,
          steps: plan?.tasks ?? [],
        },
        ...(pendingCancellations.length ? { pendingCancellations } : {}),
      };
    }
    const row = this.bus.store.get('SELECT tasks FROM agent_tasks WHERE owner_id=? AND group_id=?', ownerId, groupId);
    return { taskBudget: { used: row ? JSON.parse(row.tasks).length : 0, limit: 20 } };
  }
  pump() {
    if (this.bus.closing) return;
    for (const entry of this.bus.store.pendingDeliveries()) {
      const conversation = conversationsAgg.byId(this.bus.store, entry.conversation_id);
      // 群级守卫(归档/群待核实)只作用于有群归属的会话;私聊会话的忙碌与
      // unknown 守卫在 deliverPanelPrivate 内做会话级判断。
      if (!conversation || (conversation.group_id && !this.bus.canRun(conversation.group_id)) || this.bus.running.has(conversation.id)) continue;
      if (entry.owner_kind === 'panel_agent') {
        if (conversation.context === 'private') this.bus.deliverPanelPrivate(entry);
        else this.bus.deliverPanel(entry);
      }
      else this.bus.deliver(entry);
    }
    for (const message of messagesAgg.pending(this.bus.store)) {
      if (messagesAgg.isAttached(this.bus.store, message.id)) continue;
      if (!this.bus.canRun(message.group_id)) continue;
      const controller = this.bus.teamController(message.group_id);
      if (message.recipient === controller.id && controller.kind === 'panel_agent') {
        const session = conversationsAgg.forPanelAgent(this.bus.store, controller.id, 'coordination', { groupId: message.group_id });
        if (this.bus.running.has(session.id) || messagesAgg.hasPendingDelivery(this.bus.store, session.id)) continue;
        const entry = messagesAgg.prepareDelivery(this.bus.store, session, message);
        if (entry) this.bus.deliverPanel(entry);
        continue;
      }
      const endpoint = conversationsAgg.forMember(this.bus.store, message.recipient, message.recipient === controller.id ? 'coordination' : `pair:${message.sender}`, { peer: message.recipient === controller.id ? null : message.sender });
      if (this.bus.running.has(endpoint.id) || messagesAgg.hasPendingDelivery(this.bus.store, endpoint.id)) continue;
      const entry = messagesAgg.prepareDelivery(this.bus.store, endpoint, message);
      if (entry) this.bus.deliver(entry);
    }
  }
  canRun(groupId) {
    return !this.bus.deletingGroups.has(groupId)
      && this.bus.collaboration.communicationOpen(groupId)
      && !this.bus.collaboration.unknown(groupId).length
      && !this.bus.panelUnknown(groupId).length;
  }
  deliver(entry) {
    const endpoint = conversationsAgg.byId(this.bus.store, entry.conversation_id);
    if (!endpoint || endpoint.owner_kind !== 'member' || !this.bus.store.get('SELECT 1 FROM members WHERE id=? AND removed IS NULL', endpoint.member_id)) return;
    const input = JSON.parse(entry.payload);
    this.bus.runEndpoint(endpoint, context => {
      if (context.schema !== CONTEXT_SCHEMA_VERSION) {
        return legacyGroupDeliveryPrompt(input);
      }
      const group = this.bus.store.group(endpoint.group_id);
      return JSON.stringify(this.bus.information.turnInput({
        group,
        charter: group.charter,
        policy: context.policy,
        input,
        schema: context.schema,
        ...this.roundTaskContext(group.id, endpoint.member_id),
      }));
    }, () => {
      messagesAgg.markDeliveryAccepted(this.bus.store, entry);
    }, [input.message, ...(input.additionalMessages ?? []), ...input.notes]).catch(error => {
      messagesAgg.setDeliveryError(this.bus.store, entry, error.message);
      if (this.bus.closing) return;
      const accepted = messagesAgg.deliveryAccepted(this.bus.store, entry);
      this.bus.notify(endpoint.group_id, input.message.sender, `消息 ${input.message.id} 发给成员 ${endpoint.member_id} 的会话失败：${error.message}。${accepted ? '宿主已经接受输入；请查看宿主记录决定是否另发消息。' : '不会自动重试；核实后可用 /retry 明确重试。'}`);
    });
  }
  // Panel 主控协作会话投递:与成员投递同构(turnInput 构造、legacy 回落、accepted/error 写点)。
  deliverPanel(entry) {
    const session = conversationsAgg.byId(this.bus.store, entry.conversation_id);
    if (!session || session.owner_kind !== 'panel_agent' || session.context !== 'coordination') return;
    const panelAgent = this.bus.store.get('SELECT * FROM panel_agents WHERE id=?', session.panel_agent_id);
    if (!panelAgent) return;
    const input = JSON.parse(entry.payload);
    const schema = this.bus.information.panelSchemaForStart(session);
    let prompt;
    try {
      if (schema === CONTEXT_SCHEMA_VERSION) {
        const group = this.bus.store.group(session.group_id);
        // 用户请求的未回执清单随回合输入注入:让主控凭可见状态行动,不凭跨回合记忆;
        // 回执发布后查询为空,注入自动消失。主控完成任务须先发布回执,未发布不得声称已发布。
        const awaitingReceipt = this.bus.store.all(
          `SELECT r.id AS requestId, r.operation_id AS operationId, r.created
           FROM team_requests r
           WHERE r.group_id=? AND r.controller_id=?
             AND NOT EXISTS (SELECT 1 FROM team_request_receipts x WHERE x.request_id=r.id)`,
          group.id,
          panelAgent.id,
        );
        prompt = JSON.stringify(this.bus.information.turnInput({
          group,
          charter: group.charter,
          policy: { mode: 'communication', allowShell: false, domain: 'communication' },
          input,
          schema,
          ...this.roundTaskContext(group.id, panelAgent.id),
          ...(awaitingReceipt.length ? { awaitingReceipt } : {}),
        }));
      } else {
        prompt = legacyPanelDeliveryPrompt(input);
      }
    } catch (error) {
      this.failPanelDelivery(session, input, entry, error);
      return;
    }
    this.bus.runPanelTurn({
      session: { ...session, group_id: session.group_id },
      panelAgent,
      prompt,
      activeTeamId: session.group_id,
      inputs: [input.message, ...(input.additionalMessages ?? []), ...input.notes],
      onAccepted: () => messagesAgg.markDeliveryAccepted(this.bus.store, entry),
    }).catch(error => {
      this.failPanelDelivery(session, input, entry, error);
    });
  }
  failPanelDelivery(session, input, entry, error) {
    messagesAgg.setDeliveryError(this.bus.store, entry, error.message);
    if (this.bus.closing) return;
    const sender = messagesAgg.senderOf(this.bus.store, input.message.id);
    if (sender) {
      const notice = messagesAgg.append(this.bus.store, session.group_id, 'system', sender, 'system',
        `消息 ${input.message.id} 发给 Panel Agent 的会话失败：${error.message}。不会自动重试。`);
      this.bus.emit('notice', notice);
    }
  }
  // Panel 私聊互动答复投递:答复消息已先行落库,这里只负责发起回合。
  deliverPanelPrivate(entry) {
    const session = conversationsAgg.byId(this.bus.store, entry.conversation_id);
    if (!session || session.owner_kind !== 'panel_agent' || session.context !== 'private') return;
    const panelAgent = this.bus.store.get('SELECT * FROM panel_agents WHERE id=?', session.panel_agent_id);
    if (!panelAgent) {
      messagesAgg.setDeliveryError(this.bus.store, entry, 'Panel Agent 不存在');
      return;
    }
    // 会话忙碌或存在待核实运行时挂起:条目保持 pending,回合收尾或用户核实后由 pump 续投。
    if (this.bus.running.has(session.id)) return;
    if (turnsAgg.hasUnknown(this.bus.store, session.id)) return;
    const payload = JSON.parse(entry.payload);
    const row = this.bus.store.get('SELECT * FROM panel_messages WHERE id=? AND panel_agent_id=?', payload.panelMessageId, panelAgent.id);
    if (!row) {
      messagesAgg.setDeliveryError(this.bus.store, entry, '答复消息已被删除');
      return;
    }
    this.bus.runPanelTurn({
      session,
      panelAgent,
      sourceUserMessageId: row.id,
      prompt: row.text,
      activeTeamId: null,
      onAccepted: () => messagesAgg.markDeliveryAccepted(this.bus.store, entry),
    }).catch(error => {
      this.failPanelPrivateDelivery(session, entry, error);
    });
  }
  failPanelPrivateDelivery(session, entry, error) {
    messagesAgg.setDeliveryError(this.bus.store, entry, error.message);
    if (this.bus.closing) return;
    this.bus.store.panelAppend(session.panel_agent_id, 'private', 'system',
      `一条互动答复投递失败：${error.message}。不会自动重试。`);
  }
  async runEndpoint(endpoint, text, onAccepted = () => {}, inputs = []) {
    this.bus.collaboration.requireCommunication(endpoint.group_id);
    if (this.bus.running.has(endpoint.id)) throw new Error('该会话正在运行');
    const member = this.bus.store.member(endpoint.member_id);
    const group = this.bus.store.group(member.group_id);
    const host = this.bus.hosts.get(member.host);
    if (!host) throw new Error(`宿主未配置: ${member.host}`);
    const policy = this.bus.collaboration.policy(endpoint);
    this.bus.requirePolicy(member, policy);
    const sessionKey = typeof host.sessionKey === 'function' ? host.sessionKey({ policy, endpoint, member }) : 'default';
    if (typeof sessionKey !== 'string' || !sessionKey.trim()) throw new Error('宿主会话域无效');
    const fallbackSession = sessionKey === 'default' ? endpoint.session : null;
    const { binding, previousPolicy } = conversationsAgg.sessionState(this.bus.store, endpoint.id, sessionKey, { fallbackSession });
    const effectiveEndpoint = { ...endpoint, session: binding?.session ?? fallbackSession };
    const schema = this.bus.information.memberSchemaForSession(endpoint, sessionKey, binding?.session ?? fallbackSession);
    const prompt = typeof text === 'function'
      ? text({ schema, policy, sessionKey, group, endpoint: effectiveEndpoint })
      : text;
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('回合输入为空');
    const instructions = this.bus.rules(endpoint, schema);
    this.bus.information.assertRuleBudget(instructions, schema);
    const pairPeerId = endpoint.context.startsWith('pair:') ? endpoint.context.slice(5) : null;
    const pairPeerName = pairPeerId
      ? (pairPeerId === 'user' ? '用户' : this.bus.store.get('SELECT name FROM members WHERE id=?', pairPeerId)?.name ?? pairPeerId)
      : null;
    const streamScope = {
      groupId: group.id,
      endpointId: endpoint.id,
      memberId: member.id,
      memberName: member.name,
      host: member.host,
      context: endpoint.context,
    };
    return this.bus.turnExecutor.run({
      conversation: endpoint,
      actor: member,
      host,
      executorKind: 'member',
      executorId: endpoint.member_id,
      inputs,
      prompt,
      instructions,
      schema,
      policy,
      previousPolicy,
      workspace: group.workspace,
      tools: toolsFor(member.role, endpoint.context),
      hostEndpoint: effectiveEndpoint,
      liveEndpoint: effectiveEndpoint,
      sessionKey,
      phaseGroupId: group.id,
      emit: (turnId, event) => this.bus.events.member(endpoint.id, event, turnId),
      executeTool: (turnId, name, args, metadata) => this.bus.tool(endpoint.id, endpoint.key, name, args, { ...metadata, turnId }),
      accepted: () => onAccepted(),
      onSession: (turnId, session) => {
        conversationsAgg.saveBinding(this.bus.store, endpoint.id, sessionKey, session);
        conversationsAgg.setSession(this.bus.store, endpoint.id, session);
        endpoint.session = session;
        effectiveEndpoint.session = session;
        turnsAgg.setSession(this.bus.store, turnId, session);
      },
      onPolicy: (turnId, signature) => conversationsAgg.setPolicySignature(this.bus.store, endpoint.id, signature, sessionKey),
      onStart: turnId => this.bus.events.member(endpoint.id, {
        type: 'framework.session_scope',
        domain: policy.domain,
        sessionKey,
        session: binding?.session ?? fallbackSession,
        reused: Boolean(binding?.session ?? fallbackSession),
        contextSchemaVersion: schema,
      }, turnId),
      rememberSchema: turnId => this.bus.information.rememberTurnSchema(turnId, 'member', schema, sessionKey),
      createToolStream: turnId => {
        const scope = { ...streamScope, turnId };
        const run = this.bus.createToolStreamRun(scope);
        return payload => this.bus.observeToolStreamDelta(scope, run.streams, payload);
      },
      streamFactories: turnId => ({
        panel: null,
        team: (endpoint.context === 'coordination' && inputs.some(message => message.sender === 'user')) || pairPeerId
          ? {
              id: turnId,
              groupId: group.id,
              endpointId: endpoint.id,
              memberId: member.id,
              memberName: member.name,
              recipientName: pairPeerId ? pairPeerName : '用户',
              pairKey: pairPeerId ? [member.id, pairPeerId].sort().join(':') : '',
              kind: 'reply',
              host: member.host,
              context: endpoint.context,
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
      measure: { groupId: group.id, fixed: schema === CONTEXT_SCHEMA_VERSION },
      telemetry: { groupId: group.id, sessionKey, host: member.host, context: endpoint.context, turnKind: 'member' },
      getHostSessionId: () => effectiveEndpoint.session ?? null,
      onComplete: (turnId, result, abort) => {
        const publishedReplies = !abort.signal.aborted && endpoint.context === 'coordination'
          ? this.bus.teamDirectives.publishOutput(turnId, result)
          : [];
        return publishedReplies?.[0] ?? null;
      },
      nativeTurnEvent: false,
      failureDetail: true,
      onFinally: () => setImmediate(() => this.bus.pump()),
    });
  }

  async privateTurn(groupId, text) {
    this.bus.store.group(groupId);
    const controller = this.bus.teamController(groupId);
    if (controller.kind === 'panel_agent') return this.bus.teamDirectives.submit(groupId, { text, controllerId: controller.id, operationId: randomUUID() });
    return this.bus.runEndpoint(conversationsAgg.forMember(this.bus.store, controller.id, 'private'), text);
  }
  async stopWhere(predicate) {
    const active = [...this.bus.running.values()].filter(({ endpoint }) => predicate(endpoint));
    for (const { abort } of active) abort.abort();
    await Promise.allSettled(active.map(item => item.done));
  }
  retry(groupId) { this.bus.collaboration.requireCommunication(groupId); messagesAgg.resetDeliveryErrorsForGroup(this.bus.store, groupId); this.bus.pump(); return { retryRequested: true }; }
  resetSession(endpointId, reason, sessionKey = null) {
    const e = conversationsAgg.byId(this.bus.store, endpointId);
    if (!e || e.owner_kind !== 'member' || this.bus.running.has(e.id) || this.bus.collaboration.unknown(e.group_id).some(r => r.endpoint_id === e.id)) throw new Error('会话不存在、运行中或停止状态未核实');
    if (typeof reason !== 'string' || !reason.trim()) throw new Error('需要明确重建会话的原因');
    this.bus.events.member(e.id, { type: 'framework.session_rotated', previousSession: e.session, reason });
    const rotationKeys = sessionKey
      ? [sessionKey]
      : [...new Set([...conversationsAgg.sessionKeysForRotation(this.bus.store, e.id), 'default'])];
    for (const key of rotationKeys) this.bus.telemetry.rotateSession(e.id, key);
    // v7 起绑定/策略/格式同表;resetSession 本就三者同步删除,整行删除语义一致。
    const remainingSession = conversationsAgg.resetBindings(this.bus.store, e.id, sessionKey);
    conversationsAgg.setSession(this.bus.store, e.id, remainingSession);
    return { endpointId: e.id, previousSession: e.session, sessionKey, historyRetained: true };
  }
}
