import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp, defineComponent, ref } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { useWorkbenchPage } from './use-workbench-page';

/**
 * 工作台视图状态 composable 单测：纯搬迁后由本文件钉住待办合并/过滤、
 * 清理动作、摘要生成与计时格式，页面 SSR 冒烟测试继续覆盖模板接线。
 */

const holder = vi.hoisted(() => ({
  data: null as unknown as { value: unknown },
  refetch: vi.fn(async () => {}),
  isPending: null as unknown as { value: boolean },
  client: { invalidateQueries: vi.fn(async () => {}) },
  api: {
    dismissWorkbench: vi.fn(async () => {}),
    panelMessage: vi.fn(async () => ({})),
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

const entry = (id: string, kind: string, title: string) => ({
  id,
  kind,
  title,
  groupName: 'team',
  created: '2026-01-01T00:00:00Z',
  path: `/groups/g?message=${id}`,
});
const waitingEntry = (id: string, title: string) => ({
  id,
  title,
  groupName: 'team',
  recipientName: 'lead',
  recipientKind: 'member',
  created: '2026-01-01T00:00:00Z',
  path: `/groups/g?message=${id}`,
});
const agentWaitingEntry = (id: string, title: string) => ({
  id,
  title,
  groupName: 'team',
  senderName: 'one',
  senderKind: 'member',
  recipientName: 'two',
  recipientKind: 'member',
  created: '2026-01-01T00:00:00Z',
  path: `/groups/g?message=${id}`,
});

function workbenchData(overrides: Record<string, unknown> = {}) {
  return {
    pending: [entry('i1', 'interaction', '确认部署？')],
    waiting: [waitingEntry('w1', '整理发布说明')],
    agentWaiting: [agentWaitingEntry('a1', '请确认方案')],
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
  holder.api.panelMessage.mockClear();
  vi.stubGlobal('setInterval', () => 0);
  vi.stubGlobal('clearInterval', () => {});
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
});

describe('workbench page state', () => {
  it('merges the three pending sources and filters/labels them consistently', async () => {
    await mount();
    expect(page.entries.value.map((item) => item.source)).toEqual([
      'interaction',
      'user',
      'agent',
    ]);
    expect(page.total.value).toBe(3);
    expect(page.selectedLabel.value).toBe('全部');
    expect(page.sourceLabel).toEqual({
      interaction: '等待答复',
      user: '你的指令',
      agent: 'Agent 请求',
    });
    page.filter.value = 'user';
    expect(page.entries.value.map((item) => item.id)).toEqual(['w1']);
    expect(page.selectedLabel.value).toBe('等待回复');
    expect(page.emptyText.value).toBe('暂无等待 Agent 回复的指令');
    // 空态文案随筛选变化。
    holder.data.value = workbenchData({ pending: [], waiting: [], agentWaiting: [] });
    page.filter.value = 'all';
    expect(page.emptyText.value).toBe('暂无待处理事项');
    page.filter.value = 'interaction';
    expect(page.emptyText.value).toBe('暂无待你处理的互动卡');
  });

  it('cleans the current filtered list with the mapped dismissal categories', async () => {
    await mount();
    expect(page.cleanDescription.value).toContain('将从工作台隐藏当前列表的 3 项');
    expect(page.cleanDescription.value).toContain('互动卡仍保持待处理');
    await page.cleanEntries();
    expect(holder.api.dismissWorkbench).toHaveBeenCalledTimes(1);
    expect(holder.api.dismissWorkbench).toHaveBeenCalledWith([
      { category: 'interaction', id: 'i1' },
      { category: 'waiting:user', id: 'w1' },
      { category: 'waiting:agent', id: 'a1' },
    ]);
    expect(holder.refetch).toHaveBeenCalledTimes(1);
    expect(page.cleaning.value).toBe(false);
    expect(page.confirmClean.value).toBe(false);
  });

  it('cleans recent activity separately from pending entries', async () => {
    holder.data.value = workbenchData({
      recent: [{ id: 'r1', name: 'run', groupName: 'team', created: '', path: '/groups/g', state: 'completed' }],
    });
    await mount();
    await page.cleanRecentActivity();
    expect(holder.api.dismissWorkbench).toHaveBeenCalledWith([
      { category: 'activity:recent', id: 'r1' },
    ]);
    expect(page.cleaningActivity.value).toBe(false);
    expect(page.confirmCleanActivity.value).toBe(false);
  });

  it('generates the progress summary through the panel message API and invalidates panel queries', async () => {
    holder.data.value = workbenchData({ panelReady: true });
    await mount();
    await page.summarize();
    expect(holder.api.panelMessage).toHaveBeenCalledTimes(1);
    const [prompt, teamId, options] = holder.api.panelMessage.mock.calls[0] as unknown as [
      string,
      null,
      { clientMessageId: string },
    ];
    expect(prompt).toContain('[主页进展摘要]');
    expect(teamId).toBeNull();
    expect(typeof options.clientMessageId).toBe('string');
    expect(holder.client.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['panel-agent'],
    });
    expect(page.generating.value).toBe(false);
    expect(holder.refetch).toHaveBeenCalledTimes(1);
  });

  it('formats elapsed time in seconds and minutes for the activity list', async () => {
    await mount();
    expect(page.elapsed(new Date(Date.now() - 5_000).toISOString())).toMatch(/^\d+ 秒$/);
    expect(page.elapsed(new Date(Date.now() - 125_000).toISOString())).toMatch(/^2 分 \d+ 秒$/);
  });
});
