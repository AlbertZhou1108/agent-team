import { describe, expect, it } from 'vitest';
import type { MessageView } from '@/shared/models/view-types';
import type { PanelMessage, PanelStream, TeamStream } from '@/shared/api/raw-types';
import { PANEL_PAIR_KEY, reuseMessageViews, toPanelMessageViews, toPanelStreamViews, toStreamMessageViews } from '@/features/messages/adapters';
import { buildMessageGroups, isSystemStack } from '@/features/messages/message-groups';
import { referenceText, parseReferences } from '@/features/messages/references';
import { tidyNoticeText } from '@/features/messages/system-notice';

describe('adapters', () => {
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
      const { toPanelMessageViews } = await import('@/features/messages/adapters');
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
});

describe('message-groups', () => {
  function view(partial: Partial<MessageView> & { id: string; senderName: string }): MessageView {
    return {
      seq: 1,
      pairKey: 'a:b',
      recipientName: '主控',
      senderIsLead: false,
      senderIsUser: false,
      kind: 'send',
      text: '内容',
      createdAt: '2026-10-25T00:00:00.000Z',
      ...partial,
    };
  }

  describe('buildMessageGroups', () => {
    it('merges consecutive messages from the same sender into one run', () => {
      const groups = buildMessageGroups([
        view({ id: '1', senderName: '演示甲' }),
        view({ id: '2', senderName: '演示甲' }),
        view({ id: '3', senderName: '演示甲' }),
      ]);
      expect(groups).toHaveLength(1);
      expect(groups[0]).toMatchObject({ kind: 'run', sender: '演示甲→主控' });
      expect((groups[0] as { messages: MessageView[] }).messages.map(m => m.id)).toEqual(['1', '2', '3']);
    });

    it('splits runs when the sender alternates', () => {
      const groups = buildMessageGroups([
        view({ id: '1', senderName: '演示甲' }),
        view({ id: '2', senderName: '演示乙' }),
        view({ id: '3', senderName: '演示甲' }),
      ]);
      expect(groups.map(group => group.kind)).toEqual(['run', 'run', 'run']);
      expect(groups.map(group => (group as { sender?: string }).sender)).toEqual(['演示甲→主控', '演示乙→主控', '演示甲→主控']);
    });

    it('does not merge fan-out messages to different recipients from one sender', () => {
      const groups = buildMessageGroups([
        view({ id: '1', senderName: '欧鲸鲸', recipientName: '演示甲' }),
        view({ id: '2', senderName: '欧鲸鲸', recipientName: '演示乙' }),
      ]);
      expect(groups).toHaveLength(1);
      expect(groups[0]).toMatchObject({ kind: 'fanout' });
      expect((groups[0] as { messages: MessageView[] }).messages.map(m => m.recipientName)).toEqual(['演示甲', '演示乙']);
    });

    it('keeps fan-out only for identical text to different recipients', () => {
      const groups = buildMessageGroups([
        view({ id: '1', senderName: '欧鲸鲸', recipientName: '演示甲', text: '相同指令' }),
        view({ id: '2', senderName: '欧鲸鲸', recipientName: '演示乙', text: '相同指令' }),
        view({ id: '3', senderName: '欧鲸鲸', recipientName: '演示甲', text: '不同的后续内容' }),
      ]);
      expect(groups).toHaveLength(2);
      expect(groups[0]).toMatchObject({ kind: 'fanout' });
      expect((groups[0] as { messages: MessageView[] }).messages).toHaveLength(2);
      expect(groups[1]).toMatchObject({ kind: 'run' });
    });

    it('does not treat repeated identical messages to the same recipient as fan-out', () => {
      const groups = buildMessageGroups([
        view({ id: '1', senderName: '欧鲸鲸', recipientName: '演示甲', text: '重发' }),
        view({ id: '2', senderName: '欧鲸鲸', recipientName: '演示甲', text: '重发' }),
      ]);
      expect(groups).toHaveLength(1);
      expect(groups[0]).toMatchObject({ kind: 'run' });
    });

    it('keeps user messages in their own runs and groups consecutive ones', () => {
      const groups = buildMessageGroups([
        view({ id: '1', senderName: '用户', senderIsUser: true }),
        view({ id: '2', senderName: '用户', senderIsUser: true }),
        view({ id: '3', senderName: '演示甲' }),
      ]);
      expect(groups).toHaveLength(2);
      expect(groups[0]).toMatchObject({ kind: 'run', sender: '用户→主控' });
      expect(groups[1]).toMatchObject({ kind: 'run', sender: '演示甲→主控' });
    });

    it('collects consecutive system messages into a stack and breaks runs', () => {
      const groups = buildMessageGroups([
        view({ id: '1', senderName: '演示甲' }),
        view({ id: '2', senderName: '系统', kind: 'system' }),
        view({ id: '3', senderName: '系统', kind: 'system' }),
        view({ id: '4', senderName: '演示甲' }),
      ]);
      expect(groups).toHaveLength(3);
      expect(groups[0]).toMatchObject({ kind: 'run' });
      expect(groups[1]).toMatchObject({ kind: 'system' });
      expect(groups[2]).toMatchObject({ kind: 'run' });
      expect(isSystemStack(groups[1]!)).toBe(true);
    });

    it('renders a lone system message as a non-stacked single group', () => {
      const groups = buildMessageGroups([
        view({ id: '1', senderName: '系统', kind: 'system' }),
        view({ id: '2', senderName: '演示甲' }),
      ]);
      expect(groups).toHaveLength(2);
      expect(isSystemStack(groups[0]!)).toBe(false);
    });

    it('keeps notes independent even when the same sender repeats', () => {
      const groups = buildMessageGroups([
        view({ id: '1', senderName: '演示甲', kind: 'note' }),
        view({ id: '2', senderName: '演示甲', kind: 'note' }),
      ]);
      expect(groups.map(group => group.kind)).toEqual(['single', 'single']);
    });

    it('can disable system stacking for panel-style feeds', () => {
      const groups = buildMessageGroups(
        [
          view({ id: '1', senderName: '系统', kind: 'system' }),
          view({ id: '2', senderName: '系统', kind: 'system' }),
        ],
        { groupSystemMessages: false },
      );
      expect(groups).toHaveLength(2);
      expect(isSystemStack(groups[0]!)).toBe(false);
    });
  });
});

describe('streaming-views', () => {
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
});

describe('references', () => {
  describe('conversation references', () => {
    it('round trips multiple references including multiline text and keeps the user body', () => {
      const items = [
        { id: 'message/a', seq: 3, sender: 'Alice', text: 'first\n\n> nested' },
        { id: 'msg-b', seq: 5, sender: 'Bob', text: 'second' },
      ];
      expect(parseReferences(referenceText(items, '请比较这两段')).items).toEqual(
        items,
      );
      expect(parseReferences(referenceText(items, '请比较这两段')).text).toBe(
        '请比较这两段',
      );
    });
    it('keeps ordinary text and malformed references intact', () => {
      for (const text of [
        '普通消息',
        '> 引用消息 #x',
        '> 引用消息 #1 · A · %xy\n> text',
      ])
        expect(parseReferences(text)).toEqual({ items: [], text });
    });
  });
});

describe('system-notice', () => {
  const MSG = '786f45ed-6503-4aa3-9073-7d7b106afac1';
  const MEMBER = 'f2259358-8ed7-4d46-838a-86afa38bf5d1';

  describe('投递失败通知的展示清洗', () => {
    it('把成员投递失败里的消息与成员 UUID 换成不含标识的说法', () => {
      const legacy = `消息 ${MSG} 发给成员 ${MEMBER} 的会话失败：dsh 退出 (1)：请求超时。不会自动重试；核实后可用 /retry 明确重试。`;
      const shown = tidyNoticeText(legacy);
      expect(shown).toBe('发给成员的消息没有送达：dsh 退出 (1)：请求超时。不会自动重试；核实后可用 /retry 明确重试。');
      expect(shown).not.toContain(MSG);
      expect(shown).not.toContain(MEMBER);
    });

    it('Panel Agent 的旧通知同样清掉消息 id', () => {
      const legacy = `消息 ${MSG} 发给 Panel Agent 的会话失败：连接中断。不会自动重试。`;
      expect(tidyNoticeText(legacy)).toBe('发给 Panel Agent 的消息没有送达：连接中断。不会自动重试。');
    });

    it('已经干净的新通知保持原样', () => {
      const fresh = '发给「主 Agent」的消息没有送达：ERR_MODULE_NOT_FOUND: Cannot find module …/policy.mjs。不会自动重试，核实后可用 /retry 重试。';
      expect(tidyNoticeText(fresh)).toBe(fresh);
    });

    it('普通正文里的 UUID 不被改写', () => {
      const plain = `请看一下 ${MSG} 这条记录`;
      expect(tidyNoticeText(plain)).toBe(plain);
    });

    it('空文本原样返回', () => {
      expect(tidyNoticeText('')).toBe('');
    });
  });
});
