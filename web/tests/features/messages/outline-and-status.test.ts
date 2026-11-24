import { describe, expect, it, vi } from 'vitest';
import { buildOutlineSegments, layoutOutlineBands, OUTLINE_BAND_PITCH, OUTLINE_MAX_BANDS, OUTLINE_MAX_HEIGHT, resolveCurrentSegment } from '@/features/messages/outline-segments';
import type { OutlineSegment } from '@/features/messages/outline-segments';
import type { MessageView } from '@/shared/models/view-types';
import { directiveStatus } from '@/features/messages/directive-status';
import type { TeamDirectiveReceipt } from '@/shared/api/raw-types';
import { buildCompactArcPath, buildExpandedCurvePath, buildMemberActivitySummaries, buildTopology, detectNewFlights } from '@/features/messages/topology';
import { buildRunRows, elapsedLabel, runPhaseOf, toolActionLabel } from '@/features/messages/run-rows';
import type { StreamView } from '@/features/messages/adapters';
import { teamConversationAfterSend, teamConversationSession } from '@/features/messages/conversation-navigation';
import { frameBatch } from '@/features/messages/frame-batch';

describe('outline-segments', () => {
  let seq = 0;
  function message(overrides: Partial<MessageView> = {}): MessageView {
    seq += 1;
    return {
      id: `m${seq}`,
      seq,
      pairKey: 'a:b',
      senderName: '对话成员甲',
      recipientName: 'Panel Agent',
      senderIsLead: false,
      senderIsUser: false,
      kind: 'send',
      text: '普通消息',
      createdAt: '2026-11-05T00:00:00.000Z',
      turnId: null,
      ...overrides,
    };
  }

  const user = (text: string) => message({ senderIsUser: true, senderName: '用户指令', text });

  describe('buildOutlineSegments', () => {
    it('按用户消息切段，内部往返不额外成段', () => {
      const messages = [
        user('第一件事'),
        message(),
        message(),
        user('第二件事'),
        message(),
        user('第三件事'),
      ];

      const segments = buildOutlineSegments(messages);

      expect(segments.map(segment => segment.title)).toEqual(['第一件事', '第二件事', '第三件事']);
      expect(segments.map(segment => segment.index)).toEqual([0, 1, 2]);
      expect(segments[0]!.id).toBe(messages[0]!.id);
    });

    it('用户消息不足三根时不给刻度', () => {
      expect(buildOutlineSegments([user('一'), user('二')])).toEqual([]);
    });

    it('没有用户消息的纯 Agent 会话不给刻度', () => {
      expect(buildOutlineSegments([message(), message(), message()])).toEqual([]);
    });

    it('标题取首行、压空白、超长截断，空文本回落到序号', () => {
      const segments = buildOutlineSegments([
        user('\n  第一行  有 空格 \n第二行'),
        user('很长'.repeat(30)),
        user('   '),
      ]);

      expect(segments[0]!.title).toBe('第一行 有 空格');
      expect(segments[1]!.title).toHaveLength(24);
      expect(segments[2]!.title).toBe('第 3 段');
    });
  });

  describe('layoutOutlineBands', () => {
    const segments: OutlineSegment[] = [0, 1, 2, 3].map(index => ({
      id: `s${index}`,
      index,
      title: `第 ${index + 1} 段`,
    }));

    /** 段落依次占 0..1 的哪一段，四舍五入到小数点后四位便于断言。 */
    const ranges = (bands: ReturnType<typeof layoutOutlineBands>) =>
      bands.map(band => [
        +band.start.toFixed(4),
        +band.end.toFixed(4),
      ]);

    const many = (count: number): OutlineSegment[] =>
      Array.from({ length: count }, ((_, index) => ({
        id: `s${index}`,
        index,
        title: `第 ${index + 1} 段`,
      })));

    it('每块等高:与段落长短无关', () => {
      const bands = layoutOutlineBands(segments);

      expect(ranges(bands)).toEqual([
        [0, 0.25],
        [0.25, 0.5],
        [0.5, 0.75],
        [0.75, 1],
      ]);
    });

    it('每块的高度彼此完全相同', () => {
      const bands = layoutOutlineBands(many(7));

      const heights = bands.map(band => +(band.end - band.start).toFixed(6));
      expect(new Set(heights).size).toBe(1);
    });

    it('一段一块,顺序与段序号一致', () => {
      const bands = layoutOutlineBands(segments);

      expect(bands.map(band => band.indexes)).toEqual([[0], [1], [2], [3]]);
      expect(bands.map(band => band.id)).toEqual(['s0', 's1', 's2', 's3']);
    });

    it('段数超出轨道容量时按顺序并组,块数收到容量上限', () => {
      // 76 段、轨道只放得下 49 块 -> 收到 49 块:27 块装 2 段、22 块装 1 段。
      const bands = layoutOutlineBands(many(76), { maxBands: 49 });

      expect(bands).toHaveLength(49);
      expect(bands[0]!.indexes).toEqual([0, 1]);
      expect(bands[27]!.indexes).toHaveLength(1);
    });

    it('并组时把余数摊到前面的块,各块段数最多差一段', () => {
      const bands = layoutOutlineBands(many(76), { maxBands: 49 });

      const sizes = bands.map(band => band.indexes.length);
      expect(Math.max(...sizes) - Math.min(...sizes)).toBe(1);
      expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(76);
    });

    it('并组后仍保持连续、不丢段、不重复', () => {
      const bands = layoutOutlineBands(many(50), { maxBands: 7 });

      const flattened = bands.flatMap(band => band.indexes);
      expect(flattened).toEqual(Array.from({ length: 50 }, (_, index) => index));
    });

    it('并组块的锚点与标题取组内第一段,跳转落到这一组开头', () => {
      const bands = layoutOutlineBands(many(20), { maxBands: 4 });

      expect(bands[1]!.id).toBe('s5');
      expect(bands[1]!.title).toBe('第 6 段');
    });

    it('并组后每块依然等高,且刚好铺满轨道', () => {
      const bands = layoutOutlineBands(many(20), { maxBands: 4 });

      expect(bands[0]!.start).toBe(0);
      expect(bands.at(-1)!.end).toBe(1);
      const heights = bands.map(band => +(band.end - band.start).toFixed(6));
      expect(new Set(heights)).toEqual(new Set([0.25]));
    });

    it('容量够用时不做任何并组', () => {
      expect(layoutOutlineBands(many(10), { maxBands: 10 })).toHaveLength(10);
      expect(layoutOutlineBands(many(10), { maxBands: 40 })).toHaveLength(10);
    });

    it('容量为 0 或负数时至少留一块,不产生空轨道', () => {
      expect(layoutOutlineBands(segments, { maxBands: 0 })).toHaveLength(1);
      expect(layoutOutlineBands(segments, { maxBands: -3 })).toHaveLength(1);
    });

    it('极端段数(1000)下粒度均匀放粗,块数封顶在容量', () => {
      const bands = layoutOutlineBands(many(1000), { maxBands: OUTLINE_MAX_BANDS });

      expect(bands).toHaveLength(OUTLINE_MAX_BANDS);
      const sizes = bands.map(band => band.indexes.length);
      // 1000 / 40 整除,每块恰好 25 段;不整除时最多差一段。
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
      expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(1000);
      expect(new Set(sizes)).toEqual(new Set([25]));
    });

    it('没有段时不给块', () => {
      expect(layoutOutlineBands([])).toEqual([]);
    });
  });

  describe('outline track budget', () => {
    it('最大高度恰好被格高整除:容量 × 格高 = 最大高度', () => {
      expect(OUTLINE_MAX_BANDS).toBe(Math.floor(OUTLINE_MAX_HEIGHT / OUTLINE_BAND_PITCH));
      expect(OUTLINE_MAX_BANDS * OUTLINE_BAND_PITCH).toBe(OUTLINE_MAX_HEIGHT);
    });

    it('容量是 40 块 / 320px:粒度封顶的锚', () => {
      expect(OUTLINE_BAND_PITCH).toBe(8);
      expect(OUTLINE_MAX_BANDS).toBe(40);
    });
  });

  describe('resolveCurrentSegment', () => {
    const anchors = [
      { id: 'a', top: -500 },
      { id: 'b', top: -20 },
      { id: 'c', top: 300 },
      { id: 'd', top: 900 },
    ];

    it('取顶部已越过视口顶的最后一条', () => {
      expect(resolveCurrentSegment(anchors, 0)).toBe('b');
    });

    it('恰好压线算这一条', () => {
      expect(resolveCurrentSegment(anchors, 300)).toBe('c');
    });

    it('还没滚动时取第一段', () => {
      expect(resolveCurrentSegment([{ id: 'a', top: 40 }, { id: 'b', top: 800 }], 0)).toBe('a');
    });

    it('没有锚点时不给答案', () => {
      expect(resolveCurrentSegment([], 0)).toBeNull();
    });
  });
});

describe('directive-status', () => {
  const receipt = (over: Partial<TeamDirectiveReceipt>): TeamDirectiveReceipt => ({
    operationId: 'op-1',
    messageId: 'msg-1',
    seq: 1,
    recipient: '协作助手',
    created: '2026-11-21T12:36:12.000Z',
    status: 'queued',
    error: null,
    ...over,
  });

  describe('投递回执的展示形态', () => {
    it('排队：中性色，不可点', () => {
      expect(directiveStatus(receipt({ status: 'queued' }))).toEqual({
        label: '已排队',
        tone: 'neutral',
        interactive: false,
      });
    });

    it('已投递且无报错：绿色，不可点', () => {
      expect(directiveStatus(receipt({ status: 'delivered' }))).toEqual({
        label: '已投递',
        tone: 'success',
        interactive: false,
      });
    });

    it('已投递但回合报错：降级为「运行异常」，用琥珀色并允许点开详情', () => {
      const state = directiveStatus(receipt({ status: 'delivered', error: 'QUOTA: Insufficient Balance' }));
      expect(state).toEqual({ label: '运行异常', tone: 'warning', interactive: true });
      // 半失败不能和真正的投递失败共用红色。
      expect(state.tone).not.toBe('danger');
    });

    it('投递失败：唯一使用红色的状态', () => {
      expect(directiveStatus(receipt({ status: 'failed', error: '宿主进程以退出码 1 结束' }))).toEqual({
        label: '投递失败',
        tone: 'danger',
        interactive: true,
      });
    });

    it('待核实：蓝色问号，可点但不等同于失败', () => {
      expect(directiveStatus(receipt({ status: 'unknown' }))).toEqual({
        label: '投递待核实',
        tone: 'info',
        interactive: true,
      });
    });

    it('空报错字符串不触发运行异常', () => {
      expect(directiveStatus(receipt({ status: 'delivered', error: '' }))).toMatchObject({
        label: '已投递',
        tone: 'success',
      });
    });
  });
});

describe('run-rows', () => {
  function view(overrides: Partial<StreamView> = {}): StreamView {
    return {
      message: {
        id: 'stream:turn-1',
        seq: Number.MAX_SAFE_INTEGER,
        pairKey: 'panel',
        senderName: 'Panel Agent',
        recipientName: '用户',
        senderIsLead: false,
        senderIsUser: false,
        kind: 'send',
        text: '',
        createdAt: '2026-10-30T00:00:00.000Z',
      },
      pending: true,
      turnId: 'turn-1',
      startedAt: '2026-10-30T00:00:00.000Z',
      ...overrides,
    };
  }

  describe('run rows', () => {
    it('uses the server phase and falls back to content when it is absent', () => {
      expect(runPhaseOf(view({ runPhase: 'tool', tool: { name: 'team_read' } }))).toBe('tool');
      expect(runPhaseOf(view())).toBe('accepted');
      expect(runPhaseOf(view({ message: { ...view().message, text: '正文' } }))).toBe('writing');
      expect(runPhaseOf(view({ reasoning: '思考' }))).toBe('thinking');
    });

    it('aggregates the turn stream and its tool draft into one row', () => {
      const rows = buildRunRows([
        view({ message: { ...view().message, text: '正文' }, runPhase: 'writing' }),
        view({ message: { ...view().message, id: 'stream:tool', text: '草稿' }, toolCallId: 'call-1', runPhase: 'tool' }),
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ key: 'turn-1', name: 'Panel Agent', phase: 'writing' });
      // 工具草稿不改变回合阶段,避免正文已开始时被工具事件拉回“调用工具”。
      expect(rows[0]!.tool).toBeNull();
    });

    it('keeps one row per concurrent turn and picks the longest reasoning', () => {
      const rows = buildRunRows([
        view({ turnId: 'a', message: { ...view().message, id: 'stream:a', senderName: 'A' }, reasoning: '短' }),
        view({ turnId: 'b', message: { ...view().message, id: 'stream:b', senderName: 'B' }, reasoning: '更长的思考' }),
      ]);
      expect(rows.map(row => row.name)).toEqual(['A', 'B']);
      expect(rows[1]!.reasoning).toBe('更长的思考');
    });

    it('labels known tools with the team name and hides unknown internal names', () => {
      expect(toolActionLabel({ name: 'team_read', groupId: 'g1' }, { g1: '圆桌' })).toBe('正在读取「圆桌」的团队消息');
      expect(toolActionLabel({ name: 'team_read', groupId: null })).toBe('正在读取团队消息');
      expect(toolActionLabel({ name: 'internal_probe' })).toBe('正在执行操作');
      expect(toolActionLabel(null)).toBe('');
    });

    it('measures elapsed time from the server stream start', () => {
      expect(elapsedLabel('2026-10-30T00:00:00.000Z', Date.parse('2026-10-30T00:00:12.000Z'))).toBe('12 秒');
      expect(elapsedLabel('2026-10-30T00:00:00.000Z', Date.parse('2026-10-30T00:00:00.400Z'))).toBe('');
      expect(elapsedLabel(null, Date.now())).toBe('');
    });

    it('propagates memberId on buildRunRows', () => {
      const streams = [
        view({ turnId: 'a', memberId: 'm-lead', message: { ...view().message, id: 'stream:a', senderName: '主控' } }),
        view({ turnId: 'b', memberId: 'm-worker', message: { ...view().message, id: 'stream:b', senderName: '成员A' } }),
      ];
      expect(buildRunRows(streams).map(row => row.memberId)).toEqual(['m-lead', 'm-worker']);
    });

    it('builds communication topology edges and prevents duplicate flights on token updates', async () => {
      const rows = [
        {
          key: 'turn-1',
          name: '主 Agent',
          phase: 'thinking' as const,
          tool: null,
          startedAt: null,
          reasoning: '',
          views: [],
        },
        {
          key: 'turn-2',
          name: '前端研发',
          phase: 'tool' as const,
          tool: null,
          startedAt: null,
          reasoning: '',
          views: [],
        },
      ];
      const msg = (id: string, senderName: string, recipientName: string): MessageView => ({
        id,
        seq: 1,
        pairKey: `${senderName}:${recipientName}`,
        senderName,
        recipientName,
        senderIsLead: senderName === '主 Agent',
        senderIsUser: false,
        kind: 'send',
        text: 'hi',
        createdAt: '2026-11-24T00:00:00.000Z',
        turnId: null,
      });
      const messages = [
        msg('m1', '用户指令', '主 Agent'),
        msg('m2', '主 Agent', '前端研发'),
        msg('m3', '前端研发', '后端研发'),
      ];

      const topoIdle = buildTopology(rows, messages, []);
      expect(topoIdle.members.map(m => m.name)).toEqual(['主 Agent', '前端研发', '后端研发']);
      // No lines when nobody is actively communicating.
      expect(topoIdle.edges).toHaveLength(0);

      const activeStream = view({
        turnId: 't-active',
        pending: true,
        message: { ...view().message, id: 'stream:t-active', senderName: '主 Agent', recipientName: '前端研发' },
      });
      const topoActive = buildTopology(rows, messages, [activeStream]);
      expect(topoActive.edges).toHaveLength(1);
      expect(topoActive.edges.map(e => `${e.from}->${e.to}`)).toEqual(['主 Agent->前端研发']);

      const summaries = buildMemberActivitySummaries(messages);
      expect(summaries['前端研发']?.count).toBe(2);
      expect(summaries['前端研发']?.lastMessageId).toBe('m3');
      expect(summaries['前端研发']?.lastSummary).toContain('后端研发');
      // Member who never sent a message has no lastSummary or jump target.
      expect(summaries['后端研发']?.count).toBe(1);
      expect(summaries['后端研发']?.lastMessageId).toBeNull();
      expect(summaries['后端研发']?.lastSummary).toBe('');

      const seenMessages = new Set<string>();
      const seenStreams = new Set<string>();
      // Initial hydration does not trigger flights.
      expect(detectNewFlights(seenMessages, seenStreams, messages, [], false)).toEqual([]);

      const stream = view({
        turnId: 't-new',
        message: { ...view().message, id: 'stream:t-new', senderName: '主 Agent', recipientName: '前端研发' },
      });
      const firstFlights = detectNewFlights(seenMessages, seenStreams, messages, [stream], true);
      expect(firstFlights).toHaveLength(1);
      expect(firstFlights[0]?.from).toBe('主 Agent');
      expect(firstFlights[0]?.to).toBe('前端研发');

      // Subsequent token updates on the same stream do not re-trigger flights.
      const tokenUpdated = { ...stream, message: { ...stream.message, text: 'hello world' } };
      expect(detectNewFlights(seenMessages, seenStreams, messages, [tokenUpdated], true)).toEqual([]);

      expect(buildCompactArcPath(20, 14, 76, 14, 1)).toMatch(/^M 20 14 C 20 /);
      expect(buildExpandedCurvePath(380, 32, 380, 112, 1)).toMatch(/^M 380 32 C /);

    });
  });
});

describe('conversation-navigation', () => {
  describe('sending from a linked interaction conversation', () => {
    it('leaves the old history anchor and session before displaying the new directive', () => {
      const query = { session: 'member-user', interaction: 'old-card', pair: 'member:user', panel: 'details' };
      expect(teamConversationAfterSend(query)).toEqual({ panel: 'details' });
      expect(query.interaction).toBe('old-card');
    });
  });

  describe('interaction links use the team conversation',()=>{
    it('ignores the source session in old interaction URLs so the user-facing card is visible',()=>{
      expect(teamConversationSession({session:'member-to-manager',interaction:'confirmation'})).toBe('');
    });
    it('preserves explicit session navigation without an interaction anchor',()=>{
      expect(teamConversationSession({session:'member-to-manager'})).toBe('member-to-manager');
      expect(teamConversationSession({})).toBe('');
    });
  });
});

describe('frame-batch', () => {
  it('applies a burst once per frame in order and cancels stale events on navigation', () => {
    let run!: () => void;
    const schedule = vi.fn(callback => { run = callback; return 1; });
    const apply = vi.fn();
    const batch = frameBatch(apply, schedule, vi.fn());
    for (let i = 0; i < 100; i++) batch.push(i);
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();
    run();
    expect(apply.mock.calls.map(([value]) => value)).toEqual(Array.from({ length: 100 }, (_, i) => i));
    batch.push('stale');
    batch.dispose();
    batch.flush();
    expect(apply).toHaveBeenCalledTimes(100);
  });
});
