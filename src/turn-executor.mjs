import { telemetryObservation } from './telemetry.mjs';
import { modelSelectionOf } from './actors.mjs';

// 共享回合执行器:成员会话与 Panel 会话共用同一套回合生命周期
// (落库 -> 运行态 -> 流 -> 事件 -> 宿主调用 -> 完成/失败 -> 遥测 -> 清理)。
//
// 薄壳负责且只负责真正的差异:身份与权限、策略/工作区来源、工具集、流形状、
// 私聊同步 vs 团队异步、以及完成时的额外落库(如 Panel 私聊消息)。
export class TurnExecutor {
  constructor(bus) {
    this.bus = bus;
  }

  async run(config) {
    const bus = this.bus;
    const {
      conversation,
      actor,
      host,
      executorKind,
      executorId,
      inputs = [],
      prompt,
      instructions,
      schema,
      policy,
      previousPolicy = null,
      workspace,
      tools,
      attachments = null,
      hostEndpoint,
      liveEndpoint,
      activeTeamId = null,
      sourceUserMessageId = null,
      phaseGroupId = null,
      emit,
      executeTool,
      accepted = () => {},
      onSession,
      onPolicy,
      onStart,
      onComplete = () => null,
      onFinally = () => {},
      rememberSchema,
      createToolStream = null,
      streamFactories,
      measure,
      telemetry,
      getHostSessionId = () => hostEndpoint.session ?? null,
      nativeTurnEvent = false,
      failureDetail = true,
    } = config;

    if (conversation.group_id && bus.deletingGroups.has(conversation.group_id)) throw new Error('团队正在删除');
    const abort = new AbortController();
    const created = new Date().toISOString();
    const turnId = bus.store.createTurn(conversation, {
      executorKind,
      executorId,
      inputs,
      activeTeamId,
      sourceUserMessageId,
    });
    rememberSchema?.(turnId);

    const live = {
      endpoint: liveEndpoint,
      abort,
      turnId,
      done: null,
      created,
      ...(activeTeamId ? { activeTeamId } : {}),
    };
    const { panel: panelInitial = null, team: teamInitial = null } = streamFactories(turnId);
    const hasPanel = Boolean(panelInitial);
    const hasTeam = Boolean(teamInitial);
    const handleToolDelta = createToolStream ? createToolStream(turnId) : null;
    const telemetryStarted = performance.now();

    bus.running.set(conversation.id, live);
    if (hasPanel) {
      bus.panelStreams.set(turnId, panelInitial);
      bus.publishPanelStream({ type: 'start', stream: { ...panelInitial } });
    }
    if (hasTeam) {
      bus.teamStreams.set(turnId, teamInitial);
      bus.publishTeamStream({ type: 'start', stream: { ...teamInitial } });
    }

    // 本回合的流接收器:panel 流与 team 流形状不同、广播通道不同,但阶段/增量
    // 管线完全一致——统一按接收器遍历,不再为三种组合各写一份镜像。
    // 条目可能被 tool-streams 的消息流替换,每次都从映射表取当前对象。
    const sinks = [
      ...(hasPanel ? [{ streams: bus.panelStreams, publish: event => bus.publishPanelStream(event) }] : []),
      ...(hasTeam ? [{ streams: bus.teamStreams, publish: event => bus.publishTeamStream(event) }] : []),
    ];

    const setPhase = (phase, tool = null, publish = true) => {
      for (const sink of sinks) {
        const current = sink.streams.get(turnId);
        if (current && (current.runPhase !== phase || current.tool !== tool)) {
          current.runPhase = phase;
          current.tool = tool;
          current.updatedAt = new Date().toISOString();
          if (publish) sink.publish({ type: 'phase', stream: { ...current } });
        }
      }
    };

    const onTool = async (name, args, metadata = {}) => {
      setPhase('tool', { name, groupId: phaseGroupId });
      try {
        return await executeTool(turnId, name, args, metadata);
      } catch (error) {
        bus.failToolMessageStream(turnId, name, args, error, metadata.nativeCallId ?? null);
        throw error;
      } finally {
        // 工具结束后回到内容阶段:有正文即输出中,否则回到思考中。
        const settled = sinks.map(sink => sink.streams.get(turnId)).find(Boolean);
        if (settled) setPhase(settled.text ? 'writing' : 'thinking');
      }
    };

    const appendDelta = (field, delta, type, metadata) => {
      // 原有增量负载形状:text 增量只挖空 text,reasoning 增量挖空两者。
      const blank = field === 'text' ? { text: '' } : { text: '', reasoning: '' };
      for (const sink of sinks) {
        const current = sink.streams.get(turnId);
        if (!current || current[field].length + delta.length > 2_000_000) continue;
        current[field] += delta;
        current.runPhase = field === 'text' ? 'writing' : 'thinking';
        current.tool = null;
        current.updatedAt = new Date().toISOString();
        sink.publish({ type, stream: { ...current, ...blank }, delta, metadata });
      }
    };

    const onTextDelta = (delta, metadata = {}) => {
      if (typeof delta !== 'string' || !delta) return;
      appendDelta('text', delta, 'delta', metadata);
    };

    const onReasoningDelta = (delta, metadata = {}) => {
      if (typeof delta !== 'string' || !delta) return;
      appendDelta('reasoning', delta, 'reasoning-delta', metadata);
    };

    const promise = Promise.resolve().then(() => {
      emit(turnId, { type: 'input', text: prompt });
      try {
        bus.information.measureRules({
          groupId: measure.groupId,
          endpointId: conversation.id,
          turnId,
          schemaVersion: schema,
          instructions,
          fixed: measure.fixed,
        });
        bus.information.measureTurnInput({ groupId: measure.groupId, endpointId: conversation.id, turnId, schemaVersion: schema, prompt });
      } catch {
        // Measurement is observational and must never change the host outcome.
      }
      onStart?.(turnId);
      return host.run({
        endpoint: hostEndpoint,
        turnId,
        workspace,
        prompt,
        instructions,
        tools,
        policy,
        previousPolicy,
        ...(attachments ? { attachments } : {}),
        signal: abort.signal,
        modelSelection: modelSelectionOf(actor),
        onAccepted: () => {
          accepted(turnId);
          emit(turnId, { type: 'framework.input_accepted' });
        },
        onNativeTurn: ref => {
          bus.store.run('INSERT OR IGNORE INTO native_turn_refs VALUES(?,?)', turnId, String(ref));
          if (nativeTurnEvent) emit(turnId, { type: 'framework.native_turn', ref: String(ref) });
        },
        onTool,
        onSession: value => onSession(turnId, value),
        onModel: observation => emit(turnId, { type: 'framework.model', ...observation }),
        onSelection: selection => { if (selection?.model) emit(turnId, { type: 'framework.model_selection', ...selection }); },
        onToolCallDelta: payload => handleToolDelta?.(payload),
        onTextDelta,
        onReasoningDelta,
        onPolicy: observation => {
          if (observation.signature) onPolicy(turnId, observation.signature);
          emit(turnId, { type: 'framework.policy', ...observation });
        },
        onTelemetry: observation => {
          try {
            bus.telemetry.record({
              groupId: telemetry.groupId ?? conversation.group_id ?? null,
              executorKind,
              executorId,
              endpointId: conversation.id,
              sessionKey: telemetry.sessionKey,
              turnId,
              turnKind: telemetry.turnKind,
              host: telemetry.host,
              hostSessionId: getHostSessionId(),
              context: telemetry.context,
              observation,
            });
          } catch {
            // Telemetry is observational and must never turn a host turn into a failure.
          }
        },
        onEvent: event => { if (!bus.closing) emit(turnId, event); },
      });
    });
    // done 包含落库、回调与 finally；停止调用方等待完整收尾。
    const done = (async () => {
      try {
        const result = await promise;
        bus.store.setTurnState(turnId, abort.signal.aborted ? 'cancelled' : 'completed');
        emit(turnId, { type: 'framework.output', text: result });
        const persistedReply = await onComplete(turnId, result, abort);
        if (hasPanel) {
          bus.panelStreams.delete(turnId);
          bus.publishPanelStream({
            type: 'complete',
            stream: { ...panelInitial, text: String(result ?? panelInitial.text), updatedAt: new Date().toISOString() },
          });
        }
        if (hasTeam) {
          bus.teamStreams.delete(turnId);
          bus.publishTeamStream({
            type: 'complete',
            stream: {
              ...teamInitial,
              text: String(hasPanel ? (persistedReply?.text ?? result ?? teamInitial.text) : (result ?? teamInitial.text)),
              updatedAt: new Date().toISOString(),
              ...(persistedReply ? { messageId: persistedReply.id, messageSeq: persistedReply.seq } : {}),
            },
          });
        }
        bus.discardToolStreamRun(turnId);
        return result;
      } catch (error) {
        bus.store.setTurnState(
          turnId,
          error.runtimeUnknown ? 'unknown' : abort.signal.aborted ? 'cancelled' : 'failed',
          { detail: failureDetail ? error.message : null },
        );
        emit(turnId, { type: abort.signal.aborted ? 'framework.cancelled' : 'framework.error', error: error.message });
        if (hasPanel) {
          bus.panelStreams.delete(turnId);
          bus.publishPanelStream({
            type: abort.signal.aborted ? 'cancelled' : 'error',
            stream: { ...panelInitial, updatedAt: new Date().toISOString() },
            error: error.message,
          });
        }
        if (hasTeam) {
          bus.teamStreams.delete(turnId);
          bus.publishTeamStream({
            type: abort.signal.aborted ? 'cancelled' : 'error',
            stream: { ...teamInitial, updatedAt: new Date().toISOString() },
            error: error.message,
          });
        }
        bus.discardToolStreamRun(turnId, 'error', error.message);
        throw error;
      } finally {
        try {
          bus.telemetry.record({
            groupId: telemetry.groupId ?? conversation.group_id ?? null,
            executorKind,
            executorId,
            endpointId: conversation.id,
            sessionKey: telemetry.sessionKey,
            turnId,
            turnKind: telemetry.turnKind,
            host: telemetry.host,
            hostSessionId: getHostSessionId(),
            context: telemetry.context,
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
        bus.running.delete(conversation.id);
        onFinally();
      }
    })();
    live.done = done;
    return done;
  }
}
