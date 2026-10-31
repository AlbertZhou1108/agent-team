import { describe, expect, it } from 'vitest';
import type { MessageView, } from '@/shared/models/view-types';
import type { PanelMessage, PanelStream, TeamStream } from '@/shared/api/raw-types';
import { PANEL_PAIR_KEY, reuseMessageViews, toPanelMessageViews, toPanelStreamViews, toStreamMessageViews } from './adapters';

const message: MessageView = {
  id: 'message-1',
  seq: 1,
  pairKey: 'agent:worker',
  senderName: 'Agent',
  recipientName: 'Worker',
  senderIsLead: true,
  senderIsUser: false,
  kind: 'send',
  text: 'durable',
  createdAt: '2026-10-24T00:00:00.000Z',
};

function stream(overrides: Partial<TeamStream> = {}): TeamStream {
  return {
    id: 'turn:call',
    groupId: 'team',
    endpointId: 'endpoint',
    memberId: 'agent',
    memberName: 'Agent',
    recipientName: 'Worker',
    pairKey: 'agent:worker',
    kind: 'message',
    messageKind: 'note',
    host: 'dsh',
    context: 'coordination',
    turnId: 'turn',
    text: 'draft',
    created: '2026-10-24T00:00:00.000Z',
    updatedAt: '2026-10-24T00:00:01.000Z',
    ...overrides,
  };
}

describe('stream message views', () => {
  it('keeps drafts pending and displays a completed message before cache sync', () => {
    const [draft] = toStreamMessageViews([], [stream()], '', 'agent');
    expect(draft).toMatchObject({
      message: { id: 'stream:turn:call', text: 'draft', kind: 'note' },
      pending: true,
    });

    const [completed] = toStreamMessageViews([], [stream({
      phase: 'complete',
      messageId: 'message-2',
      messageSeq: 2,
      text: 'persisted note',
    })], '', 'agent');
    expect(completed).toMatchObject({
      message: {
        id: 'message-2',
        seq: 2,
        text: 'persisted note',
        kind: 'note',
      },
      pending: false,
    });
  });

  it('deduplicates a durable row and respects the selected pair', () => {
    const completed = stream({
      phase: 'complete',
      messageId: message.id,
      messageSeq: message.seq,
      text: message.text,
    });
    expect(toStreamMessageViews([message], [completed], '', 'agent')).toEqual([]);
    expect(toStreamMessageViews(
      [],
      [stream({ pairKey: 'agent:other' })],
      'agent:worker',
      'agent',
    )).toEqual([]);
  });
});

function panelRow(overrides: Partial<PanelMessage> = {}): PanelMessage {
  return {
    seq: 7,
    id: 'panel-1',
    panel_agent_id: 'agent',
    context: 'private',
    role: 'assistant',
    text: 'panel reply',
    active_team_id: null,
    created: '2026-10-25T00:00:00.000Z',
    ...overrides,
  };
}

describe('panel message views', () => {
  it('maps roles onto the shared MessageView shape', () => {
    const views = toPanelMessageViews([
      panelRow(),
      panelRow({ id: 'panel-2', role: 'user', text: 'hi', seq: 8 }),
      panelRow({ id: 'panel-3', role: 'system', text: 'progress', seq: 9 }),
    ], '欧鲸鲸');
    expect(views).toEqual([
      expect.objectContaining({
        id: 'panel-1', pairKey: PANEL_PAIR_KEY, kind: 'send',
        senderName: '欧鲸鲸', recipientName: '用户', senderIsUser: false,
      }),
      expect.objectContaining({
        id: 'panel-2', kind: 'send', senderName: '用户',
        recipientName: '欧鲸鲸', senderIsUser: true,
      }),
      expect.objectContaining({ id: 'panel-3', kind: 'system', senderName: '系统' }),
    ]);
  });

  it('renders context-matched streams and synthesizes a running placeholder', () => {
    const panelStream: PanelStream = {
      agentId: 'agent',
      sessionId: 'session',
      turnId: 'turn-1',
      context: 'private',
      activeTeamId: null,
      text: 'draft',
      reasoning: 'thinking',
      created: '2026-10-25T00:00:00.000Z',
      updatedAt: '2026-10-25T00:00:01.000Z',
    };
    const views = toPanelStreamViews([panelStream], { agentName: '欧鲸鲸', activeTeamId: null });
    expect(views).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({ id: 'stream:turn-1', text: 'draft', pairKey: PANEL_PAIR_KEY }),
        pending: true,
        reasoning: 'thinking',
      }),
    ]);
    // 其他团队上下文的流不进入当前视图
    expect(toPanelStreamViews(
      [{ ...panelStream, activeTeamId: 'team-a' }],
      { agentName: '欧鲸鲸', activeTeamId: null },
    )).toEqual([]);
    // 无流但回合运行中 → 合成 running 占位,保持滚动锚点
    expect(toPanelStreamViews([], { agentName: '欧鲸鲸', activeTeamId: null, running: true })).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({ id: 'panel-agent-running', text: '' }),
        pending: true,
      }),
    ]);
    expect(toPanelStreamViews([panelStream], { agentName: '欧鲸鲸', activeTeamId: null, running: true })).toHaveLength(1);
  });
});

describe('reuseMessageViews', () => {
  it('keeps object and array identity when nothing changed', () => {
    const first = toPanelMessageViews([panelRow()], '欧鲸鲸');
    const again = toPanelMessageViews([panelRow()], '欧鲸鲸');
    const reused = reuseMessageViews(first, again);
    expect(reused).toBe(first);
    expect(reused[0]).toBe(first[0]);
  });

  it('only replaces the rows whose content changed', () => {
    const rows = [panelRow(), panelRow({ id: 'panel-2', seq: 8, text: 'second' })];
    const first = toPanelMessageViews(rows, '欧鲸鲸');
    const next = toPanelMessageViews([
      rows[0]!,
      { ...rows[1]!, text: 'second revised' },
    ], '欧鲸鲸');
    const reused = reuseMessageViews(first, next);
    expect(reused).not.toBe(first);
    expect(reused[0]).toBe(first[0]);
    expect(reused[1]).not.toBe(first[1]);
    expect(reused[1]!.text).toBe('second revised');
  });

  it('appends new rows without disturbing the cached ones', () => {
    const first = toPanelMessageViews([panelRow()], '欧鲸鲸');
    const next = toPanelMessageViews([panelRow(), panelRow({ id: 'panel-2', seq: 8 })], '欧鲸鲸');
    const reused = reuseMessageViews(first, next);
    expect(reused).toHaveLength(2);
    expect(reused[0]).toBe(first[0]);
  });
});

describe('panel message attachment mapping', () => {
  it('carries structured attachments into the message view without touching text', async () => {
    const { toPanelMessageViews } = await import('./adapters');
    const rows = [
      {
        seq: 1, id: 'm1', panel_agent_id: 'p1', context: 'private', role: 'user',
        text: '看附件', active_team_id: null, created: '2026-10-31T00:00:00.000Z',
        attachments: [
          { id: 'a1', name: 'notes.txt', mediaType: 'text/plain', size: 12, availability: 'available' },
          { id: 'a2', name: 'shot.png', mediaType: 'image/png', size: 2048, availability: 'missing' },
        ],
      },
      {
        seq: 2, id: 'm2', panel_agent_id: 'p1', context: 'private', role: 'assistant',
        text: '回复', active_team_id: null, created: '2026-10-31T00:00:01.000Z',
      },
    ] as never;
    const views = toPanelMessageViews(rows, '助手');
    expect(views[0].attachments).toHaveLength(2);
    expect(views[0].attachments?.[1]).toMatchObject({ id: 'a2', availability: 'missing' });
    expect(views[0].text).toBe('看附件');
    expect(views[1].attachments).toBeUndefined();
  });
});
