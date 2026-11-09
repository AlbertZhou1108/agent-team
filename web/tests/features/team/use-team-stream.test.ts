import { describe, expect, it } from 'vitest';
import type { TeamStream } from '@/shared/api/raw-types';
import { reduceTeamStream } from '@/features/team/use-team-stream';

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
