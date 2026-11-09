import { describe, expect, it } from 'vitest';
import type { PanelStream } from '@/shared/api/raw-types';
import {
  initialPanelStreamState,
  reducePanelStream,
  reducePrivatePanelStream,
  reduceSummaryStream,
} from '@/features/streams/panel-reducer';

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
