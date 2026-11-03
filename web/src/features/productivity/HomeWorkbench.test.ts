import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createSSRApp, h } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { renderToString } from 'vue/server-renderer';
import HomeWorkbench from './HomeWorkbench.vue';

const holder = vi.hoisted(() => ({ ref: null as unknown as { value: unknown } }));

vi.mock('@tanstack/vue-query', async () => {
  const { ref } = await import('vue');
  holder.ref = ref(undefined);
  return {
    useQuery: () => ({
      data: holder.ref,
      isPending: ref(false),
      isError: ref(false),
      refetch: vi.fn(),
    }),
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  };
});

beforeEach(() => {
  holder.ref.value = undefined;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    setTimeout(() => callback(0), 0);
    return 0;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('setInterval', () => 0);
  vi.stubGlobal('clearInterval', () => {});
});

function render() {
  return renderToString(createSSRApp(HomeWorkbench));
}

async function renderWithRouter() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { render: () => null } }],
  });
  await router.push('/');
  await router.isReady();
  return renderToString(createSSRApp(HomeWorkbench).use(router));
}

describe('home workbench', () => {
  it('is one titled collapsible section with tabbed activity views and the summary inside', async () => {
    const html = await render();
    expect(html).toMatch(/data-state="open"[^>]*data-slot="disclosure"/);
    expect(html).toMatch(/data-slot="disclosure-heading">[\s\S]{0,80}工作台/);
    expect(html).toContain('data-slot="tabs"');
    expect((html.match(/data-slot="tabs-trigger"/g) ?? []).length).toBe(2);
    expect(html).toMatch(/data-slot="tabs-trigger"[\s\S]{0,1500}运行活动/);
    expect(html).toContain('待处理');
    expect(html).toContain('清理当前列表');
    expect(html).toMatch(/data-slot="tabs-trigger"[\s\S]{0,1500}最近执行/);
    // 卡头统一:标题与分段控件同处一行 card-header,不再让控件独占卡内宽度。
    expect(html).toMatch(/data-slot="card-header"[\s\S]{0,400}执行活动[\s\S]{0,400}data-slot="tabs-list"/);
    expect(html.indexOf('工作台')).toBeLessThan(html.indexOf('进展摘要'));
    expect(html).not.toMatch(/data-slot="disclosure"[\s\S]*data-slot="disclosure"/);
    // 首页卡片使用共享的稳定高度与内部滚动类，数据变化不改变外部布局。
    expect(html).toContain('home-card');
    expect(html).toContain('home-card-scroll');
  });

  it('lists unanswered directives in the workbench waiting section', async () => {
    holder.ref.value = {
      pending: [],
      agentWaiting: [],
      waiting: [
        {
          id: 'm1',
          title: '请整理发布说明',
          groupName: 'team',
          recipientName: 'lead',
          recipientKind: 'member',
          created: new Date().toISOString(),
          path: '/groups/g?message=m1',
        },
      ],
      running: [],
      recent: [],
      panelReady: false,
      summary: null,
      summaryRequest: null,
    };
    const html = await renderWithRouter();
    expect(html).toContain('你的指令');
    expect(html).toContain('请整理发布说明');
    expect(html).toContain('team');
    expect(html).toContain('lead');
    expect(html).toContain('已等待');
  });

  it('renders all three sources in the unified pending list', async () => {
    holder.ref.value = {
      pending: [
        { id: 'i1', kind: 'interaction', title: '确认部署？', groupName: 'team', created: new Date().toISOString(), path: '/groups/g?interaction=i1' },
      ],
      waiting: [
        { id: 'w1', title: '整理发布说明', groupName: 'team', recipientName: 'lead', recipientKind: 'member', created: new Date().toISOString(), path: '/groups/g?message=w1' },
      ],
      agentWaiting: [
        { id: 'a1', title: '请确认方案', groupName: 'team', senderName: 'one', senderKind: 'member', recipientName: 'two', recipientKind: 'member', created: new Date().toISOString(), path: '/groups/g?message=a1' },
      ],
      running: [],
      recent: [],
      panelReady: false,
      summary: null,
      summaryRequest: null,
    };
    const html = await renderWithRouter();
    expect(html).toContain('等待答复');
    expect(html).toContain('你的指令');
    expect(html).toContain('Agent 请求');
    expect(html).toContain('one → two');
    expect(html).toContain('清理当前列表');
  });

  it('renders caller actions in the workbench header action area', async () => {
    const html = await renderToString(
      createSSRApp({
        render: () =>
          h(HomeWorkbench, null, {
            actions: () => h('button', { 'aria-label': '打开 Panel Agent' }, 'x'),
          }),
      }),
    );
    expect(html).toMatch(/data-slot="disclosure-actions"[\s\S]*aria-label="打开 Panel Agent"/);
  });
});
