import { streamMessageToolName, partialJsonString } from '../message-stream.mjs';

/** @typedef {Record<string, any>} StreamScope */
/** @typedef {{ streams: Map<string, any>, scope: StreamScope }} ToolStreamRun */

const messageToolNames = new Set(['send', 'note', 'team_send', 'team_note']);

/**
 * 流式输出的运行时注册表:Panel 私聊/协作流、团队流和工具增量消息流。
 * 状态归本模块所有;Bus 保留同名委托方法作为协调入口,事件仍由 Bus 发出。
 */
export class ToolStreams {
  constructor(/** @type {import("./types.mjs").BusRef} */ bus) {
    this.bus = bus;
    this.panelStreams = new Map();
    this.teamStreams = new Map();
    this.toolStreamRuns = new Map();
  }
  /** @param {string | null} [agentId] @returns {object[]} */
  panelStreaming(agentId = null) {
    return [...this.panelStreams.values()]
      .filter(stream => !agentId || stream.agentId === agentId)
      .map(stream => ({ ...stream }));
  }
  /** @param {object} event */
  publishPanelStream(event) {
    if (!this.bus.closing) this.bus.emit('panel-stream', event);
  }
  /** @param {string | null} [groupId] @returns {object[]} */
  teamStreaming(groupId = null) {
    return [...this.teamStreams.values()]
      .filter(stream => !groupId || stream.groupId === groupId)
      .map(stream => ({ ...stream }));
  }
  /** @param {object} event */
  publishTeamStream(event) {
    if (!this.bus.closing) this.bus.emit('team-stream', event);
  }
  /** @param {StreamScope} scope @returns {ToolStreamRun} */
  createToolStreamRun(scope) {
    const run = { scope, streams: new Map() };
    this.toolStreamRuns.set(scope.turnId, run);
    return run;
  }
  /** @param {ToolStreamRun} run @param {string} name @param {object} args @param {string | null} [preferredCallId] */
  selectToolStream(run, name, args, preferredCallId = null) {
    const entries = [...run.streams.entries()];
    if (preferredCallId && run.streams.has(preferredCallId)) {
      const preferred = entries.find(([key]) => key === preferredCallId);
      if (preferred?.[1].name === name) return preferred;
    }
    const serialized = JSON.stringify(args);
    return entries.find(([, state]) => (
      state.name === name && state.arguments === serialized
    )) ?? entries.find(([, state]) => state.name === name) ?? null;
  }
  /** @param {StreamScope} scope @param {unknown} value */
  resolveStreamTarget(scope, value) {
    if (typeof value !== 'string' || !value) return null;
    return this.bus.store.get(
      'SELECT id,name FROM members WHERE group_id=? AND removed IS NULL AND (id=? OR name=?) LIMIT 1',
      scope.groupId,
      value,
      value,
    ) ?? null;
  }
  /** @param {StreamScope} scope @param {Map<string, any>} streams @param {Record<string, any>} payload */
  observeToolStreamDelta(scope, streams, payload) {
    const name = streamMessageToolName(payload.name ?? streams.get(payload.callId)?.name);
    if (!messageToolNames.has(name)) return;
    const key = payload.callId ?? `${scope.turnId}:${payload.index ?? 0}`;
    const state = streams.get(key) ?? { name, arguments: '', stream: null, previousText: '' };
    state.name = name ?? state.name;
    if (payload.complete) state.arguments = payload.argumentsDelta ?? '';
    else state.arguments += payload.argumentsDelta ?? '';
    streams.set(key, state);
    const targetValue = partialJsonString(state.arguments, 'to');
    const target = this.resolveStreamTarget(scope, targetValue);
    const text = partialJsonString(state.arguments, 'text');
    if (!text) return;
    if (!state.stream) {
      state.stream = {
        id: `tool:${scope.turnId}:${key}`,
        groupId: scope.groupId,
        endpointId: scope.endpointId,
        memberId: scope.memberId,
        memberName: scope.memberName,
        recipientName: target?.name ?? targetValue ?? '团队',
        pairKey: target ? [scope.memberId, target.id].sort().join(':') : '',
        kind: 'message',
        messageKind: name === 'note' || name === 'team_note' ? 'note' : 'send',
        host: scope.host,
        context: scope.context,
        turnId: scope.turnId,
        toolCallId: key,
        text: '',
        created: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.teamStreams.set(state.stream.id, state.stream);
      this.publishTeamStream({ type: 'start', stream: { ...state.stream } });
    } else {
      if (target) {
        state.stream.recipientName = target.name;
        state.stream.pairKey = [scope.memberId, target.id].sort().join(':');
      } else if (targetValue) {
        state.stream.recipientName = targetValue;
      }
    }
    const replace = !text.startsWith(state.previousText);
    const delta = replace ? text : text.slice(state.previousText.length);
    if (!delta) return;
    state.previousText = text;
    state.stream.text = text;
    state.stream.updatedAt = new Date().toISOString();
    this.publishTeamStream({
      type: 'delta',
      stream: { ...state.stream, text: '' },
      delta,
      replace,
    });
  }
  /** @param {StreamScope} scope @param {Map<string, any>} streams @param {Record<string, any>} payload @param {Record<string, any> | null} result */
  completeToolStream(scope, streams, payload, result) {
    const key = payload.callId ?? `${scope.turnId}:${payload.index ?? 0}`;
    const state = streams.get(key);
    if (!state?.stream) return;
    const message = result?.messageId
      ? this.bus.store.get('SELECT * FROM messages WHERE id=?', result.messageId)
      : null;
    if (message) {
      const target = this.bus.store.get('SELECT id,name FROM members WHERE id=?', message.recipient);
      state.stream.text = message.text;
      state.stream.recipientName = target?.name ?? message.recipient;
      state.stream.pairKey = [message.sender, message.recipient].sort().join(':');
      state.stream.messageId = message.id;
      state.stream.messageSeq = message.seq;
    }
    state.stream.updatedAt = new Date().toISOString();
    this.teamStreams.delete(state.stream.id);
    this.publishTeamStream({ type: 'complete', stream: { ...state.stream } });
    streams.delete(key);
  }
  /** @param {string} turnId @param {string} name @param {object} args @param {Record<string, any> | null} result @param {string | null} [preferredCallId] */
  completeToolMessageStream(turnId, name, args, result, preferredCallId = null) {
    const run = this.toolStreamRuns.get(turnId);
    if (!run || !messageToolNames.has(name)) return;
    const selected = this.selectToolStream(run, name, args, preferredCallId);
    if (!selected) return;
    this.completeToolStream(
      run.scope,
      run.streams,
      { callId: selected[0] },
      result,
    );
  }
  /** @param {string} turnId @param {string} name @param {object} args @param {unknown} error @param {string | null} [preferredCallId] */
  failToolMessageStream(turnId, name, args, error, preferredCallId = null) {
    const run = this.toolStreamRuns.get(turnId);
    if (!run || !messageToolNames.has(name)) return;
    const selected = this.selectToolStream(run, name, args, preferredCallId);
    if (!selected) return;
    const [key, state] = selected;
    if (state.stream) {
      this.teamStreams.delete(state.stream.id);
      this.publishTeamStream({
        type: 'error',
        stream: { ...state.stream, updatedAt: new Date().toISOString() },
        error: error instanceof Error ? error.message : String(error),
      });
    }
    run.streams.delete(key);
  }
  /** @param {string} turnId @param {string} [type] @param {string | null} [error] */
  discardToolStreamRun(turnId, type = 'cancelled', error = null) {
    const run = this.toolStreamRuns.get(turnId);
    if (run) {
      for (const state of run.streams.values()) {
        if (!state.stream) continue;
        this.teamStreams.delete(state.stream.id);
        this.publishTeamStream({
          type,
          stream: { ...state.stream, updatedAt: new Date().toISOString() },
          ...(error ? { error } : {}),
        });
      }
    }
    this.toolStreamRuns.delete(turnId);
  }
}
