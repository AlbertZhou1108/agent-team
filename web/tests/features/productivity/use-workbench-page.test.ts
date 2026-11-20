import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp, defineComponent } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { useWorkbenchPage } from '@/features/productivity/use-workbench-page';

/**
 * 工作台视图状态 composable 单测：钉住未读双 Tab 分离、禁用态逻辑、
 * 清理动作、状态/耗时/时间格式化与摘要生成。
 */

const holder = vi.hoisted(() => ({
  data: null as unknown as { value: unknown },
  refetch: vi.fn(async () => {}),
  isPending: null as unknown as { value: boolean },
  client: { invalidateQueries: vi.fn(async () => {}) },
  api: {
    dismissWorkbench: vi.fn(async () => {}),
    summarizeWorkbench: vi.fn(async () => ({ summary: null })),
  },
}));

vi.mock('@tanstack/vue-query', async () => {
  const { ref } = await import('vue');
  holder.data = ref(undefined);
  holder.isPending = ref(false);
  return {
    useQuery: () => ({
      data: holder.data,
      isPending: holder.isPending,
      isError: ref(false),
      refetch: holder.refetch,
    }),
    useQueryClient: () => holder.client,
  };
});
vi.mock('@/shared/api/client', () => ({ api: holder.api }));

type Page = ReturnType<typeof useWorkbenchPage>;
let page!: Page;

async function mount() {
  const Comp = defineComponent({
    setup() {
      page = useWorkbenchPage();
      return () => null;
    },
  });
  await renderToString(createSSRApp(Comp));
}

const pendingEntry = (id: string, title: string, interactionKind = 'takeover') => ({
  id,
  kind: 'interaction',
  interactionKind,
  title,
  groupName: '开发验收',
  senderName: 'Codex',
  conversation: 'group:g',
  created: '2026-01-01T00:00:00Z',
  path: `/groups/g?interaction=${id}`,
});

function workbenchData(overrides: Record<string, unknown> = {}) {
  return {
    pending: [pendingEntry('i1', '确认部署？')],
    unread: [],
    unreadTotal: 0,
    running: [],
    recent: [],
    panelReady: false,
    summary: null,
    summaryRequest: null,
    ...overrides,
  };
}

beforeEach(() => {
  holder.data.value = workbenchData();
  holder.isPending.value = false;
  holder.refetch.mockClear();
  holder.client.invalidateQueries.mockClear();
  holder.api.dismissWorkbench.mockClear();
  holder.api.summarizeWorkbench.mockClear();
  vi.stubGlobal('setInterval', () => 0);
  vi.stubGlobal('clearInterval', () => {});
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
});

describe('workbench page state', () => {
  it('separates pending cards and unread messages into independent tab lists', async () => {
    holder.data.value = workbenchData({
      unread: [
        {
          id: 'group:g',
          scope: 'group',
          scopeId: 'g',
          conversation: 'group:g',
          title: '开发验收',
          groupName: '开发验收',
          count: 4,
          latest: '2026-01-02T00:00:00Z',
          latestSeq: 9,
          path: '/groups/g',
        },
        {
          id: 'panel:g',
          scope: 'panel',
          scopeId: 'pa:g',
          conversation: 'panel:g',
          title: '开发验收',
          groupName: '开发验收',
          count: 2,
          latest: '2026-01-02T00:01:00Z',
          latestSeq: 3,
          path: '/agent',
        },
      ],
      unreadTotal: 6,
    });
    await mount();
    expect(page.inboxTab.value).toBe('pending');
    expect(page.pending.value).toHaveLength(1);
    expect(page.pending.value[0].path).toBe('/groups/g?interaction=i1');
    expect(page.unread.value).toHaveLength(2);
    expect(page.unreadTotal.value).toBe(6);
    expect(page.unreadTitle(page.unread.value[0])).toBe('开发验收');
    expect(page.unreadTitle(page.unread.value[1])).toBe('Panel Agent（开发验收）');
    expect(page.pendingSource(page.pending.value[0])).toBe('开发验收 · Codex');
  });

  it('disables clean buttons on non-cleanable tabs or when the target list is empty', async () => {
    holder.data.value = workbenchData({
      recent: [
        {
          id: 'r1',
          name: 'Codex',
          groupName: '开发验收',
          created: '2026-01-01T00:00:00Z',
          ended: '2026-01-01T00:02:18Z',
          path: '/groups/g',
          state: 'failed',
          detail: '退出码 1',
        },
      ],
    });
    await mount();
    expect(page.cleanPendingDisabled.value).toBe(false);
    page.inboxTab.value = 'unread';
    expect(page.cleanPendingDisabled.value).toBe(true);

    expect(page.activityTab.value).toBe('running');
    expect(page.cleanActivityDisabled.value).toBe(true);
    page.activityTab.value = 'recent';
    expect(page.cleanActivityDisabled.value).toBe(false);
  });

  it('cleans pending cards only and leaves unread alone', async () => {
    await mount();
    expect(page.cleanDescription.value).toContain('1 张待处理卡片');
    expect(page.cleanDescription.value).toContain('未读消息不受影响');
    await page.cleanEntries();
    expect(holder.api.dismissWorkbench).toHaveBeenCalledTimes(1);
    expect(holder.api.dismissWorkbench).toHaveBeenCalledWith([
      { category: 'interaction', id: 'i1' },
    ]);
    expect(holder.refetch).toHaveBeenCalledTimes(1);
    expect(page.cleaning.value).toBe(false);
    expect(page.confirmClean.value).toBe(false);
  });

  it('cleans recent activity separately from pending entries', async () => {
    holder.data.value = workbenchData({
      recent: [
        {
          id: 'r1',
          name: 'run',
          groupName: 'team',
          created: '2026-01-01T00:00:00Z',
          ended: '2026-01-01T00:01:05Z',
          path: '/groups/g',
          state: 'completed',
        },
      ],
    });
    await mount();
    await page.cleanRecentActivity();
    expect(holder.api.dismissWorkbench).toHaveBeenCalledWith([
      { category: 'activity:recent', id: 'r1' },
    ]);
    expect(page.cleaningActivity.value).toBe(false);
    expect(page.confirmCleanActivity.value).toBe(false);
  });

  it('maps interaction kinds, execution states, and formats durations for scanability', async () => {
    await mount();
    expect(page.interactionMeta('choice')).toEqual({ label: '待选择', variant: 'info' });
    expect(page.interactionMeta('input')).toEqual({ label: '待填写', variant: 'info' });
    expect(page.interactionMeta('group_create')).toEqual({ label: '待确认', variant: 'warning' });

    expect(page.statusMeta('failed')).toEqual({ label: '失败', variant: 'destructive' });
    expect(page.statusMeta('unknown')).toEqual({ label: '待核实', variant: 'warning' });
    expect(page.statusMeta('completed')).toEqual({ label: '已完成', variant: 'success' });
    expect(page.statusMeta('cancelled')).toEqual({ label: '已中断', variant: 'secondary' });

    expect(
      page.recentMeta({
        id: 'r1',
        name: 'Codex',
        groupName: '开发验收',
        created: '2026-01-01T00:00:00Z',
        ended: '2026-01-01T00:02:18Z',
        state: 'failed',
        detail: '退出码 1',
        path: '/groups/g',
      }),
    ).toBe('耗时 2 分 18 秒 · 退出码 1');
  });

  it('generates the progress summary through the dedicated workbench summary API without touching private chat', async () => {
    holder.data.value = workbenchData({ panelReady: true });
    await mount();
    await page.summarize();
    expect(holder.api.summarizeWorkbench).toHaveBeenCalledTimes(1);
    expect(page.generating.value).toBe(false);
    expect(holder.refetch).toHaveBeenCalledTimes(1);
  });

  it('formats elapsed time in seconds and minutes for the activity list', async () => {
    await mount();
    expect(page.elapsed(new Date(Date.now() - 5_000).toISOString())).toMatch(/^\d+ 秒$/);
    expect(page.elapsed(new Date(Date.now() - 125_000).toISOString())).toMatch(/^2 分 \d+ 秒$/);
  });
});
