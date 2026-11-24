import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { PanelStream, TeamStream } from '@/shared/api/raw-types';
import { initialPanelStreamState, reducePanelStream, reducePrivatePanelStream, reduceSummaryStream } from '@/features/streams/panel-reducer';
import { effectScope } from 'vue';
import { openEventStream, useEventStream } from '@/features/streams/use-event-stream';
import { reduceTeamStream } from '@/features/team/use-team-stream';

describe('panel-reducer', () => {
  const stream: PanelStream = {
    agentId: 'panel',
    sessionId: 'private',
    turnId: 'summary',
    context: 'private',
    activeTeamId: null,
    text: '',
    created: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    homeSummary: true,
  };
  const empty = { stream: null, active: false };

  describe('home summary streaming', () => {
    it('shows text before completion, retains text through phases, and settles the final result', () => {
      let state = reduceSummaryStream(empty, { type: 'start', stream });
      state = reduceSummaryStream(state, {
        type: 'delta',
        stream,
        delta: '第一段',
      });
      expect(state.active).toBe(true);
      expect(state.stream?.text).toBe('第一段');
      state = reduceSummaryStream(state, {
        type: 'phase',
        stream: { ...stream, runPhase: 'tool' },
      });
      expect(state.stream?.text).toBe('第一段');
      state = reduceSummaryStream(state, {
        type: 'delta',
        stream,
        delta: '第二段',
      });
      expect(state.stream?.text).toBe('第一段第二段');
      state = reduceSummaryStream(state, {
        type: 'complete',
        stream: { ...stream, text: '最终摘要' },
      });
      expect(state.active).toBe(false);
      expect(state.stream?.text).toBe('最终摘要');
      expect(
        reduceSummaryStream(state, { type: 'delta', stream, delta: 'late' }),
      ).toBe(state);
    });
    it('restores reconnect snapshots without double counting and ignores unrelated Panel conversations', () => {
      let state = reduceSummaryStream(empty, {
        type: 'snapshot',
        streams: [{ ...stream, text: '已生成' }],
      });
      state = reduceSummaryStream(state, {
        type: 'delta',
        stream,
        delta: '后续',
      });
      expect(state.stream?.text).toBe('已生成后续');
      expect(
        reduceSummaryStream(state, {
          type: 'delta',
          stream: { ...stream, turnId: 'chat', homeSummary: false },
          delta: '普通聊天',
        }),
      ).toBe(state);
      state = reduceSummaryStream(state, {
        type: 'snapshot',
        streams: [{ ...stream, text: '已生成后续' }],
      });
      expect(state.stream?.text).toBe('已生成后续');
      expect(
        reduceSummaryStream(state, { type: 'snapshot', streams: [] }),
      ).toEqual(empty);
    });
    it('clears failed or cancelled drafts and does not expose reasoning as summary text', () => {
      const state = reduceSummaryStream(empty, {
        type: 'reasoning-delta',
        stream,
        delta: 'internal',
      });
      expect(state.stream?.text).toBe('');
      expect(state.stream?.reasoning).toBe('');
      expect(reduceSummaryStream(state, { type: 'error', stream })).toEqual(
        empty,
      );
      expect(reduceSummaryStream(state, { type: 'cancelled', stream })).toEqual(
        empty,
      );
    });
  });

  describe('panel private conversation streaming', () => {
    const chat = { ...stream, turnId: 'chat', homeSummary: false };
    const later = { ...stream, turnId: 'later', homeSummary: false };

    it('accumulates text and reasoning per turn while phases only refresh stage metadata', () => {
      let current = reducePrivatePanelStream(null, { type: 'start', stream: chat });
      expect(current).toEqual(chat);
      current = reducePrivatePanelStream(current, {
        type: 'delta',
        stream: chat,
        delta: '甲',
      });
      current = reducePrivatePanelStream(current, {
        type: 'reasoning-delta',
        stream: chat,
        delta: '想',
      });
      expect(current?.text).toBe('甲');
      expect(current?.reasoning).toBe('想');
      // 阶段事件保留已累积正文与思考，只更新阶段/工具。
      current = reducePrivatePanelStream(current, {
        type: 'phase',
        stream: { ...chat, runPhase: 'tool' },
      });
      expect(current?.text).toBe('甲');
      expect(current?.reasoning).toBe('想');
      expect(current?.runPhase).toBe('tool');
      // 同一渲染帧内的后续增量继续累积。
      current = reducePrivatePanelStream(current, {
        type: 'delta',
        stream: chat,
        delta: '乙',
      });
      expect(current?.text).toBe('甲乙');
      // 新一轮回复不继承上一轮正文。
      current = reducePrivatePanelStream(current, {
        type: 'delta',
        stream: later,
        delta: '新',
      });
      expect(current?.text).toBe('新');
      expect(current?.reasoning).toBe('');
    });

    it('rebuilds from snapshots, keeps the completed view, and clears terminal failures', () => {
      const restored = reducePrivatePanelStream(null, {
        type: 'snapshot',
        streams: [
          { ...chat, context: 'coordination' },
          { ...chat, text: '在飞' },
        ],
      });
      expect(restored?.text).toBe('在飞');
      expect(
        reducePrivatePanelStream(restored, {
          type: 'snapshot',
          streams: [{ ...chat, context: 'coordination' }],
        }),
      ).toBeNull();
      const completed = { ...chat, text: '最终回复' };
      expect(
        reducePrivatePanelStream(restored, { type: 'complete', stream: completed }),
      ).toEqual(completed);
      expect(
        reducePrivatePanelStream(restored, { type: 'cancelled', stream: chat }),
      ).toBeNull();
      expect(
        reducePrivatePanelStream(restored, { type: 'error', stream: chat }),
      ).toBeNull();
      // 非私人上下文的团队流事件不会写进私人会话。
      expect(
        reducePrivatePanelStream(restored, {
          type: 'delta',
          stream: { ...chat, context: 'coordination' },
          delta: 'x',
        }),
      ).toBe(restored);
    });
  });

  describe('unified panel stream reducer', () => {
    it('routes each event to both consumers without cross-contamination', () => {
      let state = initialPanelStreamState();
      const summaryEvent = { type: 'delta' as const, stream, delta: '摘要' };
      state = reducePanelStream(state, summaryEvent);
      expect(state.summary.stream?.text).toBe('摘要');
      expect(state.private).toBeNull();
      const chatEvent = {
        type: 'delta' as const,
        stream: { ...stream, turnId: 'chat', homeSummary: false },
        delta: '聊天',
      };
      state = reducePanelStream(state, chatEvent);
      expect(state.private?.text).toBe('聊天');
      expect(state.summary.stream?.text).toBe('摘要');
      // 与两个消费者都无关的事件保持整份状态引用，避免无意义重渲染。
      const unchanged = reducePanelStream(state, {
        type: 'delta',
        stream: {
          ...stream,
          turnId: 'team',
          context: 'coordination',
          homeSummary: false,
        },
        delta: 'x',
      });
      expect(unchanged).toBe(state);
      // snapshot 同时恢复私人会话与摘要快照。
      state = reducePanelStream(state, {
        type: 'snapshot',
        streams: [
          { ...stream, text: '摘要快照' },
          { ...stream, turnId: 'chat', homeSummary: false, text: '会话快照' },
        ],
      });
      expect(state.summary.stream?.text).toBe('摘要快照');
      expect(state.private?.text).toBe('会话快照');
      expect(initialPanelStreamState()).toEqual({
        private: null,
        summary: { stream: null, active: false },
      });
    });
  });
});

describe('use-event-stream', () => {
  class FakeEventSource {
    static instances: FakeEventSource[] = [];
    url: string;
    closed = false;
    onopen: (() => void) | null = null;
    private listeners = new Map<string, Array<(event: { data: string }) => void>>();

    constructor(url: string) {
      this.url = url;
      FakeEventSource.instances.push(this);
    }
    addEventListener(name: string, listener: (event: { data: string }) => void) {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
    }
    close() {
      this.closed = true;
    }
    emit(payload: unknown) {
      for (const listener of this.listeners.get('panel-stream') ?? [])
        listener({ data: typeof payload === 'string' ? payload : JSON.stringify(payload) });
    }
  }

  let frames: Array<() => void> = [];
  let cancelled = 0;

  beforeEach(() => {
    FakeEventSource.instances = [];
    frames = [];
    cancelled = 0;
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => {
      frames.push(() => run(0));
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {
      cancelled += 1;
    });
  });

  function flushFrame() {
    const pending = frames;
    frames = [];
    for (const run of pending) run();
  }

  describe('unified event stream', () => {
    it('batches token deltas into one render frame while applying state transitions immediately', () => {
      const seen: string[] = [];
      openEventStream<{ type: string; delta?: string }>({
        url: '/api/panel-agent/events',
        eventName: 'panel-stream',
        onEvent: (event) => seen.push(event.delta ?? event.type),
        flushImmediately: (event) =>
          event.type !== 'delta' && event.type !== 'reasoning-delta',
      });
      const source = FakeEventSource.instances[0]!;
      source.emit({ type: 'start' });
      expect(seen).toEqual(['start']);
      source.emit({ type: 'delta', delta: '甲' });
      source.emit({ type: 'delta', delta: '乙' });
      expect(seen).toEqual(['start']);
      flushFrame();
      // 同一帧内的增量按到达顺序合并应用一次。
      expect(seen).toEqual(['start', '甲', '乙']);
      source.emit({ type: 'complete' });
      expect(seen).toEqual(['start', '甲', '乙', 'complete']);
    });

    it('drops malformed events and stops delivering after close', () => {
      const seen: unknown[] = [];
      const handle = openEventStream({
        url: '/api/teams/g1/events',
        eventName: 'panel-stream',
        onEvent: (event) => seen.push(event),
      });
      const source = FakeEventSource.instances[0]!;
      source.emit('not json');
      source.emit({ type: 'start' });
      flushFrame();
      expect(seen).toEqual([{ type: 'start' }]);
      handle.close();
      expect(source.closed).toBe(true);
      source.emit({ type: 'start' });
      flushFrame();
      expect(seen).toEqual([{ type: 'start' }]);
    });

    it('useEventStream closes its connection when the owning scope is disposed', () => {
      const scope = effectScope();
      const handle = scope.run(() =>
        useEventStream({ url: '/api/panel-agent/events', eventName: 'panel-stream', onEvent: () => {} }),
      )!;
      expect(FakeEventSource.instances).toHaveLength(1);
      scope.stop();
      expect(FakeEventSource.instances[0]!.closed).toBe(true);
      handle.close();
      expect(cancelled).toBe(0);
    });

    it('flushes pending frame events on demand before closing', () => {
      const seen: unknown[] = [];
      const handle = openEventStream({
        url: '/api/panel-agent/events',
        eventName: 'panel-stream',
        onEvent: (event) => seen.push(event),
      });
      FakeEventSource.instances[0]!.emit({ type: 'delta', delta: 'x' });
      expect(seen).toEqual([]);
      handle.flush();
      expect(seen).toEqual([{ type: 'delta', delta: 'x' }]);
      handle.close();
    });
  });
});

describe('use-team-stream', () => {
  const stream: TeamStream = {
    id: 's1',
    groupId: 'g1',
    endpointId: 'e1',
    memberId: 'm1',
    memberName: '甲',
    recipientName: '乙',
    pairKey: 'm1:m2',
    kind: 'reply',
    host: 'codex',
    context: 'pair:m1:m2',
    turnId: 't1',
    text: '',
    created: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
  };

  describe('team stream reducer', () => {
    it('rebuilds in-flight streams from snapshots for the current team only', () => {
      const next = reduceTeamStream(
        {},
        {
          type: 'snapshot',
          streams: [
            { ...stream, id: 'a', groupId: 'g1' },
            { ...stream, id: 'b', groupId: 'other' },
          ],
        },
        'g1',
      );
      expect(Object.keys(next)).toEqual(['a']);
    });

    it('accumulates deltas and reasoning while phases preserve accumulated content', () => {
      let state = reduceTeamStream({}, { type: 'start', stream }, 'g1');
      state = reduceTeamStream(
        state,
        { type: 'delta', stream, delta: '第一段' },
        'g1',
      );
      expect(state.s1?.text).toBe('第一段');
      state = reduceTeamStream(
        state,
        { type: 'reasoning-delta', stream, delta: '思考' },
        'g1',
      );
      expect(state.s1?.reasoning).toBe('思考');
      state = reduceTeamStream(
        state,
        { type: 'phase', stream: { ...stream, runPhase: 'tool' } },
        'g1',
      );
      expect(state.s1?.text).toBe('第一段');
      expect(state.s1?.reasoning).toBe('思考');
      expect(state.s1?.runPhase).toBe('tool');
    });

    it('supports in-place replacement deltas and settles terminal events', () => {
      let state = reduceTeamStream(
        {},
        { type: 'delta', stream, delta: '旧' },
        'g1',
      );
      state = reduceTeamStream(
        state,
        { type: 'delta', stream, delta: '替换', replace: true },
        'g1',
      );
      expect(state.s1?.text).toBe('替换');
      state = reduceTeamStream(
        state,
        { type: 'delta', stream, delta: '短', replace: true },
        'g1',
      );
      expect(state.s1?.text).toBe('替换');
      state = reduceTeamStream(state, { type: 'complete', stream }, 'g1');
      expect(state.s1?.phase).toBe('complete');
      expect(
        reduceTeamStream(state, { type: 'cancelled', stream }, 'g1'),
      ).toEqual({});
      expect(reduceTeamStream(state, { type: 'error', stream }, 'g1')).toEqual(
        {},
      );
    });

    it('ignores events from other teams and unknown terminal events', () => {
      const state = reduceTeamStream({}, { type: 'start', stream }, 'g1');
      expect(
        reduceTeamStream(
          state,
          { type: 'delta', stream: { ...stream, groupId: 'other' }, delta: 'x' },
          'g1',
        ),
      ).toBe(state);
      expect(reduceTeamStream({}, { type: 'cancelled', stream }, 'g1')).toEqual(
        {},
      );
    });
  });
});

describe('panel-stream-store', () => {
  class FakeEventSource {
    static instances: FakeEventSource[] = [];
    url: string;
    closed = false;
    onopen: (() => void) | null = null;
    private listeners = new Map<string, Array<(event: { data: string }) => void>>();

    constructor(url: string) {
      this.url = url;
      FakeEventSource.instances.push(this);
    }
    addEventListener(name: string, listener: (event: { data: string }) => void) {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
    }
    close() {
      this.closed = true;
    }
    emit(name: string, payload: unknown) {
      for (const listener of this.listeners.get(name) ?? [])
        listener({ data: JSON.stringify(payload) });
    }
  }

  const stream: PanelStream = {
    agentId: 'panel',
    sessionId: 'private',
    turnId: 'chat',
    context: 'private',
    activeTeamId: null,
    text: '',
    created: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
  };

  let frames: Array<() => void> = [];

  beforeEach(() => {
    vi.resetModules();
    FakeEventSource.instances = [];
    frames = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => {
      frames.push(() => run(0));
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });

  async function store() {
    return (await import('@/features/panel-agent/panel-stream-store')).usePanelStream();
  }

  function flushFrame() {
    const pending = frames;
    frames = [];
    for (const run of pending) run();
  }

  describe('panel stream singleton', () => {
    it('opens exactly one EventSource for every consumer and closes it after the last release', async () => {
      const panelStream = await store();
      const releasePanel = panelStream.retain();
      const releaseWorkbench = panelStream.retain();
      expect(FakeEventSource.instances).toHaveLength(1);
      expect(FakeEventSource.instances[0]!.url).toBe('/api/panel-agent/events');
      releasePanel();
      expect(FakeEventSource.instances[0]!.closed).toBe(false);
      releaseWorkbench();
      expect(FakeEventSource.instances[0]!.closed).toBe(true);
      // 释放后再消费会重新建立连接，但同一时刻仍只有一条。
      const releaseAgain = panelStream.retain();
      expect(FakeEventSource.instances).toHaveLength(2);
      releaseAgain();
    });

    it('feeds both consumers from the unified reducer and notifies subscribers per event', async () => {
      const panelStream = await store();
      const release = panelStream.retain();
      const events: string[] = [];
      const stop = panelStream.subscribe((event) => events.push(event.type));
      const source = FakeEventSource.instances[0]!;
      source.emit('panel-stream', {
        type: 'snapshot',
        streams: [
          { ...stream, text: '在飞' },
          {
            ...stream,
            turnId: 'summary',
            homeSummary: true,
            text: '摘要',
          },
        ],
      });
      // snapshot 是状态转换，立即应用，不等渲染帧。
      expect(panelStream.state.value.private?.text).toBe('在飞');
      expect(panelStream.state.value.summary.stream?.text).toBe('摘要');
      source.emit('panel-stream', { type: 'delta', stream, delta: '继续' });
      // 增量按帧合并：帧前未落状态，帧后只应用一次。
      expect(panelStream.state.value.private?.text).toBe('在飞');
      flushFrame();
      expect(panelStream.state.value.private?.text).toBe('在飞继续');
      expect(events).toEqual(['snapshot', 'delta']);
      stop();
      release();
    });

    it('clears private/summary projections on demand and on last release', async () => {
      let panelStream = await store();
      let release = panelStream.retain();
      FakeEventSource.instances[0]!.emit('panel-stream', {
        type: 'snapshot',
        streams: [
          { ...stream, text: '会话' },
          { ...stream, turnId: 'summary', homeSummary: true, text: '摘要' },
        ],
      });
      panelStream.clearPrivate();
      expect(panelStream.state.value.private).toBeNull();
      expect(panelStream.state.value.summary.stream?.text).toBe('摘要');
      panelStream.resetSummary();
      expect(panelStream.state.value.summary).toEqual({
        stream: null,
        active: false,
      });
      FakeEventSource.instances[0]!.emit('panel-stream', {
        type: 'snapshot',
        streams: [{ ...stream, text: '会话' }],
      });
      release();
      expect(panelStream.state.value.private).toBeNull();
      // 释放后重新 retain 会拿到全新连接与干净状态。
      panelStream = await store();
      release = panelStream.retain();
      expect(panelStream.state.value.private).toBeNull();
      release();
    });

    it('notifies open subscribers on connect (and immediately when already connected)', async () => {
      const panelStream = await store();
      const release = panelStream.retain();
      const opened = vi.fn();
      const stop = panelStream.subscribeOpen(opened);
      expect(opened).not.toHaveBeenCalled();
      FakeEventSource.instances[0]!.onopen?.();
      expect(opened).toHaveBeenCalledTimes(1);
      // 已连接时新增订阅者立即回调一次（各消费者各自的 onopen 对账语义）。
      const late = vi.fn();
      const stopLate = panelStream.subscribeOpen(late);
      expect(late).toHaveBeenCalledTimes(1);
      stop();
      stopLate();
      release();
    });
  });
});
