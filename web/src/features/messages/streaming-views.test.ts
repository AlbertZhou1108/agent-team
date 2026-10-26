import { describe, expect, it } from 'vitest';
import { PANEL_PAIR_KEY, toPanelStreamViews, toStreamMessageViews } from './adapters';
import type { PanelStream, TeamStream } from '@/shared/api/raw-types';

// 这些用例锁定流式视图转换的“引用稳定性”契约:流式组件只在该函数的返回值变化时
// 重渲染,而父组件(MessageFeed)不再读取流数组。转换本身必须保持纯函数行为。
function teamStream(overrides: Partial<TeamStream> = {}): TeamStream {
  return {
    id: 'turn:call',
    groupId: 'team',
    endpointId: 'endpoint',
    memberId: 'agent',
    memberName: 'Agent',
    recipientName: 'Worker',
    pairKey: 'agent:worker',
    kind: 'message',
    host: 'dsh',
    context: 'coordination',
    turnId: 'turn',
    text: 'draft',
    created: '2026-10-26T00:00:00.000Z',
    updatedAt: '2026-10-26T00:00:01.000Z',
    ...overrides,
  };
}

function panelStream(overrides: Partial<PanelStream> = {}): PanelStream {
  return {
    agentId: 'agent',
    sessionId: 'session',
    turnId: 'turn-1',
    context: 'private',
    activeTeamId: null,
    text: 'draft',
    reasoning: '',
    created: '2026-10-26T00:00:00.000Z',
    updatedAt: '2026-10-26T00:00:01.000Z',
    ...overrides,
  };
}

describe('streaming views shape', () => {
  it('keeps the stream id stable while text accumulates, so the bubble is reused', () => {
    const first = toPanelStreamViews([panelStream({ text: 'a' })], { agentName: 'P', activeTeamId: null });
    const next = toPanelStreamViews([panelStream({ text: 'a + b' })], { agentName: 'P', activeTeamId: null });
    expect(first[0]!.message.id).toBe(next[0]!.message.id);
    expect(next[0]!.message.text).toBe('a + b');
    expect(next[0]!.pending).toBe(true);
  });

  it('reports the pending flag only while the host turn is running', () => {
    const draft = toStreamMessageViews([], [teamStream({ text: 'streaming' })], '', 'agent');
    expect(draft[0]!.pending).toBe(true);
    const done = toStreamMessageViews(
      [],
      [teamStream({ phase: 'complete', messageId: 'm2', messageSeq: 2, text: 'streaming' })],
      '',
      'agent',
    );
    expect(done[0]!.pending).toBe(false);
  });

  it('exposes one view per active stream so multi-stream chips can be built', () => {
    const views = toStreamMessageViews(
      [],
      [teamStream({ id: 'a', turnId: 'a', memberName: 'A' }), teamStream({ id: 'b', turnId: 'b', memberName: 'B' })],
      '',
      undefined,
    );
    expect(views).toHaveLength(2);
    expect(views.map(view => view.message.senderName)).toEqual(['A', 'B']);
    expect(new Set(views.map(view => view.message.id)).size).toBe(2);
  });

  it('filters panel streams by the active team context', () => {
    const views = toPanelStreamViews(
      [panelStream({ activeTeamId: 'team-a' }), panelStream({ turnId: 'turn-2', activeTeamId: null })],
      { agentName: 'P', activeTeamId: 'team-a' },
    );
    expect(views).toHaveLength(1);
    expect(views[0]!.message.pairKey).toBe(PANEL_PAIR_KEY);
  });

  it('drops a stream whose durable message has already landed', () => {
    const views = toStreamMessageViews(
      [{
        id: 'persisted',
        seq: 3,
        pairKey: 'agent:worker',
        senderName: 'Agent',
        recipientName: 'Worker',
        senderIsLead: false,
        senderIsUser: false,
        kind: 'send',
        text: 'done',
        createdAt: '2026-10-26T00:00:02.000Z',
      }],
      [teamStream({ phase: 'complete', messageId: 'persisted', messageSeq: 3, text: 'done' })],
      '',
      undefined,
    );
    expect(views).toEqual([]);
  });
});
