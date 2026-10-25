import { describe, expect, it } from 'vitest';
import type { MessageView, } from '@/shared/models/view-types';
import type { PanelMessage, PanelStream, TeamStream } from '@/shared/api/raw-types';
import { PANEL_PAIR_KEY, toPanelMessageViews, toPanelStreamViews, toStreamMessageViews } from './adapters';

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
