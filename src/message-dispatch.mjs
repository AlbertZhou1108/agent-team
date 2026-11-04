import { randomUUID } from 'node:crypto';
import { toolsFor } from './tools.mjs';
import { CONTEXT_SCHEMA_VERSION } from './information.mjs';
import { legacyGroupDeliveryPrompt } from './prompts.mjs';

// 消息调度:outbox 与待处理消息的投递循环、成员回合执行与会话重建。
// 本模块不反向依赖 Bus;跨职责调用经 bus 引用。

export class MessageDispatch {
  constructor(bus) {
    this.bus = bus;
  }
  notify(groupId, recipient, text) {
    if (this.bus.closing || !recipient || !this.bus.store.get('SELECT 1 FROM groups WHERE id=?', groupId)) return;
    const notice = this.bus.store.append(groupId, 'system', recipient, 'system', text);
    this.bus.emit('notice', notice);
  }
  pump() {
    if (this.bus.closing) return;
    for (const entry of this.bus.store.pendingDeliveries()) {
      const conversation = this.bus.store.conversationById(entry.conversation_id);
      // 群级守卫(归档/群待核实)只作用于有群归属的会话;私聊会话的忙碌与
      // unknown 守卫在 deliverPanelPrivate 内做会话级判断。
      if (!conversation || (conversation.group_id && !this.bus.canRun(conversation.group_id)) || this.bus.running.has(conversation.id)) continue;
      if (entry.owner_kind === 'panel_agent') {
        if (conversation.context === 'private') this.bus.deliverPanelPrivate(entry);
        else this.bus.deliverPanel(entry);
      }
      else this.bus.deliver(entry);
    }
    for (const message of this.bus.store.pending()) {
      if (this.bus.store.get('SELECT 1 FROM attached WHERE message_id=?', message.id)) continue;
      if (!this.bus.canRun(message.group_id)) continue;
      const controller = this.bus.teamController(message.group_id);
      if (message.recipient === controller.id && controller.kind === 'panel_agent') {
        const session = this.bus.store.conversation('panel_agent', controller.id, 'coordination', { groupId: message.group_id });
        if (this.bus.running.has(session.id) || this.bus.store.hasPendingDelivery(session.id)) continue;
        const entry = this.bus.store.prepareDelivery(session, message);
        if (entry) this.bus.deliverPanel(entry);
        continue;
      }
      const endpoint = this.bus.store.conversation('member', message.recipient, message.recipient === controller.id ? 'coordination' : `pair:${message.sender}`, { peer: message.recipient === controller.id ? null : message.sender });
      if (this.bus.running.has(endpoint.id) || this.bus.store.hasPendingDelivery(endpoint.id)) continue;
      const entry = this.bus.store.prepareDelivery(endpoint, message);
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
    const endpoint = this.bus.store.conversationById(entry.conversation_id);
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
      }));
    }, () => {
      this.bus.store.setDeliveryAccepted(entry);
    }, [input.message, ...(input.additionalMessages ?? []), ...input.notes]).catch(error => {
      this.bus.store.setDeliveryError(entry, error.message);
      if (this.bus.closing) return;
      const accepted = this.bus.store.deliveryAccepted(entry);
      this.bus.notify(endpoint.group_id, input.message.sender, `消息 ${input.message.id} 发给成员 ${endpoint.member_id} 的会话失败：${error.message}。${accepted ? '宿主已经接受输入；请查看宿主记录决定是否另发消息。' : '不会自动重试；核实后可用 /retry 明确重试。'}`);
    });
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
    const binding = this.bus.store.get('SELECT * FROM conversation_session_bindings WHERE conversation_id=? AND session_key=?', endpoint.id, sessionKey);
    const fallbackSession = sessionKey === 'default' ? endpoint.session : null;
    const effectiveEndpoint = { ...endpoint, session: binding?.session ?? fallbackSession };
    const previousPolicy = this.bus.store.get('SELECT signature FROM conversation_session_policies WHERE conversation_id=? AND session_key=?', endpoint.id, sessionKey)?.signature
      ?? (!binding && fallbackSession ? this.bus.store.get('SELECT policy_signature FROM conversations WHERE id=?', endpoint.id)?.policy_signature : null);
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
        this.bus.store.run('INSERT INTO conversation_session_bindings VALUES(?,?,?,?) ON CONFLICT(conversation_id,session_key) DO UPDATE SET session=excluded.session,updated=excluded.updated', endpoint.id, sessionKey, session, new Date().toISOString());
        this.bus.store.setConversationSession(endpoint.id, session);
        endpoint.session = session;
        effectiveEndpoint.session = session;
        this.bus.store.setTurnSession(turnId, session);
      },
      onPolicy: (turnId, signature) => this.bus.store.setConversationPolicySignature(endpoint.id, signature, sessionKey),
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
    return this.bus.runEndpoint(this.bus.store.conversation('member', controller.id, 'private'), text);
  }
  async stopWhere(predicate) {
    const active = [...this.bus.running.values()].filter(({ endpoint }) => predicate(endpoint));
    for (const { abort } of active) abort.abort();
    await Promise.allSettled(active.map(item => item.done));
  }
  retry(groupId) { this.bus.collaboration.requireCommunication(groupId); this.bus.store.run('UPDATE outbox SET error=NULL WHERE accepted IS NULL AND conversation_id IN (SELECT id FROM conversations WHERE group_id=?)', groupId); this.bus.pump(); return { retryRequested: true }; }
  resetSession(endpointId, reason, sessionKey = null) {
    const e = this.bus.store.conversationById(endpointId);
    if (!e || e.owner_kind !== 'member' || this.bus.running.has(e.id) || this.bus.collaboration.unknown(e.group_id).some(r => r.endpoint_id === e.id)) throw new Error('会话不存在、运行中或停止状态未核实');
    if (typeof reason !== 'string' || !reason.trim()) throw new Error('需要明确重建会话的原因');
    this.bus.events.member(e.id, { type: 'framework.session_rotated', previousSession: e.session, reason });
    const rotationKeys = sessionKey
      ? [sessionKey]
      : [...new Set([
          ...this.bus.store.all('SELECT session_key FROM conversation_session_bindings WHERE conversation_id=?', e.id).map(row => row.session_key),
          'default',
        ])];
    for (const key of rotationKeys) this.bus.telemetry.rotateSession(e.id, key);
    if (sessionKey) {
      this.bus.store.run('DELETE FROM conversation_session_bindings WHERE conversation_id=? AND session_key=?', e.id, sessionKey);
      this.bus.store.run('DELETE FROM conversation_session_policies WHERE conversation_id=? AND session_key=?', e.id, sessionKey);
      this.bus.information.forgetSessionFormats(e.id, sessionKey);
    } else {
      this.bus.store.run('DELETE FROM conversation_session_bindings WHERE conversation_id=?', e.id);
      this.bus.store.run('DELETE FROM conversation_session_policies WHERE conversation_id=?', e.id);
      this.bus.store.run('UPDATE conversations SET policy_signature=NULL,updated=? WHERE id=?', new Date().toISOString(), e.id);
      this.bus.information.forgetSessionFormats(e.id);
    }
    const remaining = this.bus.store.get('SELECT session FROM conversation_session_bindings WHERE conversation_id=? ORDER BY updated DESC LIMIT 1', e.id);
    this.bus.store.setConversationSession(e.id, remaining?.session ?? null);
    return { endpointId: e.id, previousSession: e.session, sessionKey, historyRetained: true };
  }
}
