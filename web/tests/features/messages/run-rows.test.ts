// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import RunStatusCard from '@/components/ai-elements/RunStatusCard.vue';
import {
  buildCompactArcPath,
  buildExpandedCurvePath,
  buildMemberActivitySummaries,
  buildTopology,
  detectNewFlights,
} from '@/features/messages/topology';
import type { MessageView } from '@/shared/models/view-types';
import { buildRunRows, elapsedLabel, runPhaseOf, toolActionLabel } from '@/features/messages/run-rows';
import type { StreamView } from '@/features/messages/adapters';

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

  it('propagates memberId and invokes stop callback for header and per-row stop buttons', async () => {
    setActivePinia(createPinia());
    const onStop = vi.fn().mockResolvedValue(undefined);
    const streams = [
      view({ turnId: 'a', memberId: 'm-lead', message: { ...view().message, id: 'stream:a', senderName: '主控' } }),
      view({ turnId: 'b', memberId: 'm-worker', message: { ...view().message, id: 'stream:b', senderName: '成员A' } }),
    ];
    expect(buildRunRows(streams).map(row => row.memberId)).toEqual(['m-lead', 'm-worker']);

    const wrapper = mount(RunStatusCard, {
      props: {
        source: () => streams,
        onStop,
      },
    });
    expect(wrapper.find('[data-testid="run-card-capsule"]').exists()).toBe(true);
    await wrapper.get('.run-card-toggle').trigger('click');
    expect(wrapper.find('[data-testid="member-topology-overlay"]').exists()).toBe(false);

    await wrapper.get('[data-testid="run-card-stop"]').trigger('click');
    await flushPromises();
    expect(onStop).toHaveBeenNthCalledWith(1);

    await wrapper.get('[data-stop-member="m-worker"]').trigger('click');
    await flushPromises();
    expect(onStop).toHaveBeenCalledWith('m-worker');
    wrapper.unmount();
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

    // Keeps the collapsed capsule visible when idle if >=2 members have communicated.
    setActivePinia(createPinia());
    const idleCard = mount(RunStatusCard, {
      props: {
        source: () => [],
        messages,
      },
    });
    expect(idleCard.find('[data-testid="run-card-capsule"]').exists()).toBe(true);
    await idleCard.get('.run-card-toggle').trigger('click');
    expect(idleCard.text()).toContain('成员通信 · 3 位成员');
    expect(idleCard.text()).not.toContain('待命中');
    expect(idleCard.text()).toContain('收发 2 条');
    expect(idleCard.find('.topology-expanded').exists()).toBe(false);
    expect(idleCard.find('[data-testid="run-card-stop"]').exists()).toBe(false);
    // 后端研发 never sent a message, so no jump button is rendered for it.
    expect(idleCard.findAll('[data-jump-message]')).toHaveLength(2);
    await idleCard.get('[data-jump-message="m3"]').trigger('click');
    expect(idleCard.emitted('jumpMessage')).toEqual([['m3']]);
    idleCard.unmount();
  });
});
