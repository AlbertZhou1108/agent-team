// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { mount } from '@vue/test-utils';
import TeamTraceWorkspace from '@/features/sessions/TeamTraceWorkspace.vue';
import type { HistoryRow, SessionEndpoint, TurnSummary } from '@/shared/api/raw-types';

const rawRows = ref<HistoryRow[]>([]);
const rawEventsMock = {
  rows: rawRows,
  isPending: ref(false),
  hasNextPage: ref(false),
  isFetchingNextPage: ref(false),
  fetchNextPage: vi.fn(),
};

vi.mock('@/features/sessions/use-raw-events', () => ({
  useRawEventsQuery: () => rawEventsMock,
}));

const endpoint: SessionEndpoint = {
  id: 'ep-1',
  group_id: 'g-1',
  member_id: 'm-1',
  context: 'coordination',
  peer: null,
  session: 's-1',
};

const turnSummaries: TurnSummary[] = [
  {
    id: 't-1',
    ordinal: 1,
    state: 'failed',
    created: '2026-11-22T00:00:01.000Z',
    ended: '2026-11-22T00:00:05.000Z',
    eventCount: 10,
    firstSeq: 1,
    lastSeq: 10,
    errorSummary: 'boom 1',
  },
  {
    id: 't-2',
    ordinal: 2,
    state: 'failed',
    created: '2026-11-22T00:00:06.000Z',
    ended: '2026-11-22T00:00:10.000Z',
    eventCount: 12,
    firstSeq: 11,
    lastSeq: 22,
    errorSummary: 'boom 2',
  },
  {
    id: 't-3',
    ordinal: 3,
    state: 'completed',
    created: '2026-11-22T00:00:11.000Z',
    ended: '2026-11-22T00:00:20.000Z',
    eventCount: 24,
    firstSeq: 23,
    lastSeq: 46,
  },
];

describe('TeamTraceWorkspace', () => {
  it('syncs the timeline progress segments with the selected turn status filter', async () => {
    const wrapper = mount(TeamTraceWorkspace, {
      props: {
        mode: 'trace',
        endpoints: [endpoint],
        endpoint,
        members: [],
        turnSummaries,
        unaffiliatedEvents: [],
      },
      global: {
        stubs: {
          TurnTraceSection: {
            props: ['turn'],
            template: '<div class="stub-turn" :data-turn-id="turn.id" />',
          },
        },
      },
    });

    const segments = () => wrapper.findAll('[aria-label="回合时间轴概览"] button');
    const rows = () => wrapper.findAll('.stub-turn');

    expect(segments().map((node) => node.attributes('aria-label'))).toEqual([
      '定位到第 1 轮',
      '定位到第 2 轮',
      '定位到第 3 轮',
    ]);
    expect(rows()).toHaveLength(3);

    const filterButtons = wrapper.findAll('[aria-label="回合状态筛选"] button');
    await filterButtons.find((btn) => btn.text() === '失败')!.trigger('click');
    expect(segments().map((node) => node.attributes('aria-label'))).toEqual([
      '定位到第 1 轮',
      '定位到第 2 轮',
    ]);
    expect(rows()).toHaveLength(2);

    await filterButtons.find((btn) => btn.text() === '已完成')!.trigger('click');
    expect(segments().map((node) => node.attributes('aria-label'))).toEqual([
      '定位到第 3 轮',
    ]);
    expect(rows()).toHaveLength(1);

    await filterButtons.find((btn) => btn.text() === '全部')!.trigger('click');
    expect(segments()).toHaveLength(3);
    expect(rows()).toHaveLength(3);
  });

  it('filters raw events by segmented category and search query', async () => {
    rawEventsMock.rows.value = [
      {
        seq: 1,
        conversation_id: 'ep-1',
        turn_id: 't-1',
        created: '2026-11-22T00:00:01.000Z',
        event: JSON.stringify({ method: 'framework.error', message: 'bad' }),
      },
      {
        seq: 2,
        conversation_id: 'ep-1',
        turn_id: 't-1',
        created: '2026-11-22T00:00:02.000Z',
        event: JSON.stringify({ method: 'tool.call', name: 'read_file' }),
      },
    ];

    const wrapper = mount(TeamTraceWorkspace, {
      props: {
        mode: 'events',
        endpoints: [endpoint],
        endpoint,
        members: [],
        turnSummaries: [],
        unaffiliatedEvents: [],
        searchQuery: 'framework.error',
      },
    });

    expect(wrapper.findAll('[data-record-row]')).toHaveLength(1);
    expect(wrapper.text()).toContain('显示 1 / 2 条');

    const toolBtn = wrapper
      .findAll('[aria-label="原始事件分类过滤"] button')
      .find((btn) => btn.text() === '工具')!;
    await toolBtn.trigger('click');
    expect(wrapper.findAll('[data-record-row]')).toHaveLength(0);
    expect(wrapper.text()).toContain('没有匹配的原始事件');
  });
});
