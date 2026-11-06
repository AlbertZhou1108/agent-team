import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createSSRApp, h } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { renderToString } from 'vue/server-renderer';
import HomeWorkbench from './HomeWorkbench.vue';

// node 环境的 SSR 冒烟里 DOMPurify 没有 DOM 可用；摘要正文用桩组件渲染，
// 只验证「摘要区域 + 内容接线」，不重测 Markdown 渲染。
vi.mock('@/components/ai-elements/MarkdownRenderer.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return {
    default: defineComponent({
      props: ['content', 'defer'],
      setup: (props) => () =>
        h('div', { 'data-testid': 'markdown-renderer', 'data-content': String(props.content) }),
    }),
  };
});

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
    expect(html).toContain('全部');
    expect(html).not.toContain('全部 (3)');
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

// ── 页面级 SSR 冒烟（P4-4 后补）：只验证页面能挂载 + 关键区块/空状态存在。 ──
describe('home workbench page SSR smoke', () => {
  const emptyWorkbench = {
    pending: [],
    waiting: [],
    agentWaiting: [],
    running: [],
    recent: [],
    panelReady: false,
    summary: null,
    summaryRequest: null,
  };

  it('mounts as a labelled landmark with a titled disclosure and summary card', async () => {
    holder.ref.value = emptyWorkbench;
    const html = await renderWithRouter();
    expect(html).toContain('aria-labelledby="workbench-title"');
    expect(html).toContain('id="workbench-title"');
    expect(html).toContain('工作台');
    expect(html).toContain('进展摘要');
    expect(html).toMatch(/data-state="open"[^>]*data-slot="disclosure"/);
  });

  it('renders empty states for pending items, running activity and the summary hint', async () => {
    holder.ref.value = emptyWorkbench;
    const html = await renderWithRouter();
    expect(html).toContain('暂无待处理事项');
    expect(html).toContain('暂无运行中的成员');
    expect(html).toContain('点击刷新图标，汇总全部团队的近期进展。');
    // 没有待办时清理按钮禁用。
    expect(html).toContain('清理当前列表');
    expect(html).not.toContain('aria-label="进展摘要内容"');
  });

  it('renders the summary region and refresh control when a summary and a ready panel exist', async () => {
    holder.ref.value = {
      ...emptyWorkbench,
      panelReady: true,
      summary: { id: 's1', text: '本轮摘要内容', created: new Date().toISOString() },
    };
    const html = await renderWithRouter();
    expect(html).toContain('aria-label="进展摘要内容"');
    expect(html).toContain('aria-label="刷新摘要"');
    expect(html).toContain('本轮摘要内容');
    expect(html).toContain('生成于');
  });

  it('hides the refresh control when the panel agent is not ready', async () => {
    holder.ref.value = emptyWorkbench;
    const html = await renderWithRouter();
    expect(html).not.toContain('aria-label="刷新摘要"');
    expect(html).not.toContain('aria-label="正在刷新摘要"');
    expect(html).toContain('进展摘要');
  });
});
