import { randomUUID } from 'node:crypto';
import { toolsFor } from './tools.mjs';
import { telemetryObservation } from './telemetry.mjs';
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
    for (const entry of this.bus.store.all('SELECT * FROM panel_outbox WHERE accepted IS NULL AND error IS NULL ORDER BY rowid')) {
      const session = this.bus.store.get('SELECT * FROM panel_sessions WHERE id=?', entry.session_id);
      if (session && this.bus.canRun(session.group_id) && !this.bus.running.has(entry.session_id)) {
        this.bus.deliverPanel(entry);
      }
    }
    for (const entry of this.bus.store.all('SELECT * FROM outbox WHERE accepted IS NULL AND error IS NULL ORDER BY rowid')) {
      const endpoint = this.bus.store.get('SELECT * FROM endpoints WHERE id=?', entry.endpoint_id);
      if (endpoint && this.bus.canRun(endpoint.group_id) && !this.bus.running.has(entry.endpoint_id)) this.bus.deliver(entry);
    }
    for (const message of this.bus.store.pending()) {
      if (this.bus.store.get('SELECT 1 FROM attached WHERE message_id=?', message.id)) continue;
      if (this.bus.store.get('SELECT 1 FROM panel_attached WHERE message_id=?', message.id)) continue;
      if (!this.bus.canRun(message.group_id)) continue;
      const controller = this.bus.teamController(message.group_id);
      if (message.recipient === controller.id && controller.kind === 'panel_agent') {
        const session = this.bus.store.panelSession(controller.id, 'coordination', message.group_id);
        if (this.bus.running.has(session.id) || this.bus.store.get('SELECT 1 FROM panel_outbox WHERE session_id=? AND accepted IS NULL AND error IS NULL', session.id)) continue;
        const entry = this.bus.store.preparePanel(message, session);
        if (entry) this.bus.deliverPanel(entry);
        continue;
      }
      const endpoint = this.bus.store.endpoint(message.recipient, message.recipient === controller.id ? 'coordination' : `pair:${message.sender}`, message.recipient === controller.id ? null : message.sender);
      if (this.bus.running.has(endpoint.id) || this.bus.store.get('SELECT 1 FROM outbox WHERE endpoint_id=? AND accepted IS NULL AND error IS NULL', endpoint.id)) continue;
      const entry = this.bus.store.prepare(message, endpoint);
      if (entry) this.bus.deliver(entry);
    }
  }
  canRun(groupId) {
    return this.bus.collaboration.communicationOpen(groupId)
      && !this.bus.collaboration.unknown(groupId).length
      && !this.bus.panelUnknown(groupId).length;
  }
  deliver(entry) {
    const endpoint = this.bus.store.get('SELECT * FROM endpoints WHERE id=?', entry.endpoint_id);
    if (!endpoint || !this.bus.store.get('SELECT 1 FROM members WHERE id=? AND removed IS NULL', endpoint.member_id)) return;
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
      this.bus.store.run('UPDATE outbox SET accepted=? WHERE id=?', new Date().toISOString(), entry.id);
    }, [input.message, ...(input.additionalMessages ?? []), ...input.notes]).catch(error => {
      this.bus.store.run('UPDATE outbox SET error=? WHERE id=?', error.message, entry.id);
      if (this.bus.closing) return;
      const accepted = this.bus.store.get('SELECT accepted FROM outbox WHERE id=?', entry.id)?.accepted;
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
    const abort = new AbortController();
    const policy = this.bus.collaboration.policy(endpoint);
    this.bus.requirePolicy(member, policy);
    const sessionKey = typeof host.sessionKey === 'function' ? host.sessionKey({ policy, endpoint, member }) : 'default';
    if (typeof sessionKey !== 'string' || !sessionKey.trim()) throw new Error('宿主会话域无效');
    const binding = this.bus.store.get('SELECT * FROM endpoint_session_bindings WHERE endpoint_id=? AND session_key=?', endpoint.id, sessionKey);
    const fallbackSession = sessionKey === 'default' ? endpoint.session : null;
    const effectiveEndpoint = { ...endpoint, session: binding?.session ?? fallbackSession };
    const previousPolicy = this.bus.store.get('SELECT signature FROM endpoint_session_policies WHERE endpoint_id=? AND session_key=?', endpoint.id, sessionKey)
      ?? (!binding && fallbackSession ? this.bus.store.get('SELECT signature FROM endpoint_policy WHERE endpoint_id=?', endpoint.id) : null);
    const schema = this.bus.information.memberSchemaForSession(endpoint, sessionKey, binding?.session ?? fallbackSession);
    const prompt = typeof text === 'function'
      ? text({ schema, policy, sessionKey, group, endpoint: effectiveEndpoint })
      : text;
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('回合输入为空');
    const instructions = this.bus.rules(endpoint, schema);
    this.bus.information.assertRuleBudget(instructions, schema);
    const turnId = this.bus.store.createTurn(effectiveEndpoint, inputs);
    this.bus.information.rememberTurnSchema(turnId, 'member', schema, sessionKey);
    this.bus.store.run(
      'INSERT INTO runtime_attempts(turn_id,group_id,endpoint_id,state,policy,created) VALUES(?,?,?,?,?,?)',
      turnId,
      group.id,
      endpoint.id,
      'running',
      JSON.stringify(policy),
      new Date().toISOString(),
    );
    const live = { endpoint: effectiveEndpoint, abort, turnId, done: null, created: new Date().toISOString() };
    const pairPeerId = endpoint.context.startsWith('pair:') ? endpoint.context.slice(5) : null;
    const pairPeerName = pairPeerId
      ? (pairPeerId === 'user' ? '用户' : this.bus.store.get('SELECT name FROM members WHERE id=?', pairPeerId)?.name ?? pairPeerId)
      : null;
    const teamStream = (endpoint.context === 'coordination' && inputs.some(message => message.sender === 'user')) || pairPeerId
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
          // 阶段由服务端维护:前端据此区分思考、输出与工具调用,不必靠内容反推。
          runPhase: 'accepted',
          tool: null,
          created: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
      : null;
    const streamScope = {
      groupId: group.id,
      endpointId: endpoint.id,
      memberId: member.id,
      memberName: member.name,
      host: member.host,
      context: endpoint.context,
      turnId,
    };
    const toolStreamRun = this.bus.createToolStreamRun(streamScope);
    const telemetryStarted = performance.now();
    this.bus.running.set(endpoint.id, live);
    if (teamStream) {
      this.bus.teamStreams.set(turnId, teamStream);
      this.bus.publishTeamStream({ type: 'start', stream: { ...teamStream } });
    }
    // 成员的阶段只作用于团队流;工具名即公开信息,不附带参数。
    const setPhase = (phase, tool = null, publish = true) => {
      if (!teamStream) return;
      const current = this.bus.teamStreams.get(turnId);
      if (!current || (current.runPhase === phase && current.tool === tool)) return;
      current.runPhase = phase;
      current.tool = tool;
      current.updatedAt = new Date().toISOString();
      if (publish) this.bus.publishTeamStream({ type: 'phase', stream: { ...current } });
    };
    this.bus.events.member(endpoint.id, { type: 'input', text: prompt }, turnId);
    try {
      this.bus.information.measureRules({
        groupId: group.id,
        endpointId: endpoint.id,
        turnId,
        schemaVersion: schema,
        instructions,
        fixed: schema === CONTEXT_SCHEMA_VERSION,
      });
      this.bus.information.measureTurnInput({ groupId: group.id, endpointId: endpoint.id, turnId, schemaVersion: schema, prompt });
    } catch {
      // Measurement is observational and must never change the host outcome.
    }
    this.bus.events.member(endpoint.id, {
      type: 'framework.session_scope',
      domain: policy.domain,
      sessionKey,
      session: binding?.session ?? fallbackSession,
      reused: Boolean(binding?.session ?? fallbackSession),
      contextSchemaVersion: schema,
    }, turnId);
    const promise = Promise.resolve().then(() => host.run({
      endpoint: effectiveEndpoint, turnId, workspace: group.workspace, prompt, instructions,
      tools: toolsFor(member.role, endpoint.context), policy, previousPolicy, signal: abort.signal,
      modelSelection: {
        model_provider: member.model_provider ?? null,
        model: member.model ?? null,
        reasoning_effort: member.reasoning_effort ?? null,
      },
      onAccepted: () => { onAccepted(); this.bus.events.member(endpoint.id, { type: 'framework.input_accepted' }, turnId); },
      onNativeTurn: ref => { this.bus.store.run('INSERT OR IGNORE INTO native_turn_refs VALUES(?,?)', turnId, String(ref)); },
      onTool: async (name, args, metadata = {}) => {
        setPhase('tool', { name, groupId: group.id });
        try {
          return await this.bus.tool(endpoint.id, endpoint.key, name, args, {
            ...metadata,
            turnId,
          });
        } catch (error) {
          this.bus.failToolMessageStream(
            turnId,
            name,
            args,
            error,
            metadata.nativeCallId ?? null,
          );
          throw error;
        } finally {
          const settled = this.bus.teamStreams.get(turnId);
          if (settled) setPhase(settled.text ? 'writing' : 'thinking');
        }
      },
      onSession: session => {
        this.bus.store.run('INSERT INTO endpoint_session_bindings VALUES(?,?,?,?) ON CONFLICT(endpoint_id,session_key) DO UPDATE SET session=excluded.session,updated=excluded.updated', endpoint.id, sessionKey, session, new Date().toISOString());
        this.bus.store.run('UPDATE endpoints SET session=? WHERE id=?', session, endpoint.id);
        endpoint.session = session;
        effectiveEndpoint.session = session;
        this.bus.store.run('UPDATE turns SET session=? WHERE id=?', session, turnId);
      },
      onModel: observation => { this.bus.events.member(endpoint.id, { type: 'framework.model', ...observation }, turnId); },
      onSelection: selection => { if (selection?.model) this.bus.events.member(endpoint.id, { type: 'framework.model_selection', ...selection }, turnId); },
      onToolCallDelta: payload => this.bus.observeToolStreamDelta(
        streamScope,
        toolStreamRun.streams,
        payload,
      ),
      onTextDelta: (delta, metadata = {}) => {
        if (!teamStream || typeof delta !== 'string' || !delta) return;
        const current = this.bus.teamStreams.get(turnId);
        if (!current || current.text.length + delta.length > 2_000_000) return;
        current.text += delta;
        current.runPhase = 'writing';
        current.tool = null;
        current.updatedAt = new Date().toISOString();
        this.bus.publishTeamStream({
          type: 'delta',
          stream: { ...current, text: '' },
          delta,
          metadata,
        });
      },
      onReasoningDelta: (delta, metadata = {}) => {
        if (!teamStream || typeof delta !== 'string' || !delta) return;
        const current = this.bus.teamStreams.get(turnId);
        if (!current || current.reasoning.length + delta.length > 2_000_000) return;
        current.reasoning += delta;
        current.runPhase = 'thinking';
        current.tool = null;
        current.updatedAt = new Date().toISOString();
        this.bus.publishTeamStream({
          type: 'reasoning-delta',
          stream: { ...current, text: '', reasoning: '' },
          delta,
          metadata,
        });
      },
      onPolicy: observation => {
        if (observation.signature) {
          this.bus.store.run('INSERT INTO endpoint_session_policies VALUES(?,?,?) ON CONFLICT(endpoint_id,session_key) DO UPDATE SET signature=excluded.signature', endpoint.id, sessionKey, observation.signature);
          this.bus.store.run('INSERT INTO endpoint_policy VALUES(?,?) ON CONFLICT(endpoint_id) DO UPDATE SET signature=excluded.signature', endpoint.id, observation.signature);
        }
        this.bus.events.member(endpoint.id, { type: 'framework.policy', ...observation }, turnId);
      },
      onTelemetry: observation => {
        try {
          this.bus.telemetry.record({
            groupId: group.id,
            executorKind: 'member',
            executorId: endpoint.member_id,
            endpointId: endpoint.id,
            sessionKey,
            turnId,
            turnKind: 'member',
            host: member.host,
            hostSessionId: effectiveEndpoint.session ?? null,
            context: endpoint.context,
            observation,
          });
        } catch {
          // Telemetry is observational and must never turn a host turn into a failure.
        }
      },
      onEvent: event => { if (!this.bus.closing) this.bus.events.member(endpoint.id, event, turnId); },
    }));
    live.done = promise;
    try {
      const result = await promise;
      this.bus.store.run("UPDATE runtime_attempts SET state=?,ended=? WHERE turn_id=?", abort.signal.aborted ? 'cancelled' : 'completed', new Date().toISOString(), turnId);
      this.bus.events.member(endpoint.id, { type: 'framework.output', text: result }, turnId);
      const publishedReplies = !abort.signal.aborted && endpoint.context === 'coordination'
        ? this.bus.teamDirectives.publishOutput(turnId, result)
        : [];
      const persistedReply = publishedReplies?.[0] ?? null;
      if (teamStream) {
        this.bus.teamStreams.delete(turnId);
        this.bus.publishTeamStream({
          type: 'complete',
          stream: {
            ...teamStream,
            text: String(result ?? teamStream.text),
            updatedAt: new Date().toISOString(),
            ...(persistedReply
              ? { messageId: persistedReply.id, messageSeq: persistedReply.seq }
              : {}),
          },
        });
      }
      this.bus.discardToolStreamRun(turnId);
      return result;
    }
    catch (error) {
      this.bus.store.run('UPDATE runtime_attempts SET state=?,detail=?,ended=? WHERE turn_id=?', error.runtimeUnknown ? 'unknown' : abort.signal.aborted ? 'cancelled' : 'failed', error.message, new Date().toISOString(), turnId);
      this.bus.events.member(endpoint.id, { type: abort.signal.aborted ? 'framework.cancelled' : 'framework.error', error: error.message }, turnId);
      if (teamStream) {
        this.bus.teamStreams.delete(turnId);
        this.bus.publishTeamStream({
          type: abort.signal.aborted ? 'cancelled' : 'error',
          stream: { ...teamStream, updatedAt: new Date().toISOString() },
          error: error.message,
        });
      }
      this.bus.discardToolStreamRun(turnId, 'error', error.message);
      throw error;
    }
    finally {
      try {
        this.bus.telemetry.record({
          groupId: group.id,
          executorKind: 'member',
          executorId: endpoint.member_id,
          endpointId: endpoint.id,
          sessionKey,
          turnId,
          turnKind: 'member',
          host: member.host,
          hostSessionId: effectiveEndpoint.session ?? null,
          context: endpoint.context,
          observation: telemetryObservation({
            source: 'framework.measured',
            scope: 'turn',
            aggregation: 'delta',
            timing: { executionWallMs: Math.max(0, Math.round(performance.now() - telemetryStarted)) },
            quality: { executionWallMs: 'measured' },
            completeness: { executionWallMs: 'complete' },
          }),
        });
      } catch { /* telemetry must not affect the host outcome */ }
      this.bus.running.delete(endpoint.id); setImmediate(() => this.bus.pump());
    }
  }
  async privateTurn(groupId, text) {
    this.bus.store.group(groupId);
    const controller = this.bus.teamController(groupId);
    if (controller.kind === 'panel_agent') return this.bus.teamDirectives.submit(groupId, { text, controllerId: controller.id, operationId: randomUUID() });
    return this.bus.runEndpoint(this.bus.store.endpoint(controller.id, 'private'), text);
  }
  async stopWhere(predicate) {
    const active = [...this.bus.running.values()].filter(({ endpoint }) => predicate(endpoint));
    for (const { abort } of active) abort.abort();
    await Promise.allSettled(active.map(item => item.done));
  }
  retry(groupId) { this.bus.collaboration.requireCommunication(groupId); this.bus.store.run('UPDATE outbox SET error=NULL WHERE accepted IS NULL AND endpoint_id IN (SELECT id FROM endpoints WHERE group_id=?)', groupId); this.bus.pump(); return { retryRequested: true }; }
  resetSession(endpointId, reason, sessionKey = null) {
    const e = this.bus.store.get('SELECT * FROM endpoints WHERE id=?', endpointId);
    if (!e || this.bus.running.has(e.id) || this.bus.collaboration.unknown(e.group_id).some(r => r.endpoint_id === e.id)) throw new Error('会话不存在、运行中或停止状态未核实');
    if (typeof reason !== 'string' || !reason.trim()) throw new Error('需要明确重建会话的原因');
    this.bus.events.member(e.id, { type: 'framework.session_rotated', previousSession: e.session, reason });
    const rotationKeys = sessionKey
      ? [sessionKey]
      : [...new Set([
          ...this.bus.store.all('SELECT session_key FROM endpoint_session_bindings WHERE endpoint_id=?', e.id).map(row => row.session_key),
          'default',
        ])];
    for (const key of rotationKeys) this.bus.telemetry.rotateSession(e.id, key);
    if (sessionKey) {
      this.bus.store.run('DELETE FROM endpoint_session_bindings WHERE endpoint_id=? AND session_key=?', e.id, sessionKey);
      this.bus.store.run('DELETE FROM endpoint_session_policies WHERE endpoint_id=? AND session_key=?', e.id, sessionKey);
      this.bus.information.forgetSessionFormats(e.id, sessionKey);
    } else {
      this.bus.store.run('DELETE FROM endpoint_session_bindings WHERE endpoint_id=?', e.id);
      this.bus.store.run('DELETE FROM endpoint_session_policies WHERE endpoint_id=?', e.id);
      this.bus.store.run('DELETE FROM endpoint_policy WHERE endpoint_id=?', e.id);
      this.bus.information.forgetSessionFormats(e.id);
    }
    const remaining = this.bus.store.get('SELECT session FROM endpoint_session_bindings WHERE endpoint_id=? ORDER BY updated DESC LIMIT 1', e.id);
    this.bus.store.run('UPDATE endpoints SET session=? WHERE id=?', remaining?.session ?? null, e.id);
    return { endpointId: e.id, previousSession: e.session, sessionKey, historyRetained: true };
  }
}
