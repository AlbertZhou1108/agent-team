import { describe, expect, it } from 'vitest';
import type { PanelStream } from '@/shared/api/raw-types';
import { reduceSummaryStream } from './summary-stream';
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
