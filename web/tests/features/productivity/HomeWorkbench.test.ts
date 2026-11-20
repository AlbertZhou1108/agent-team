import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createSSRApp, h } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { renderToString } from 'vue/server-renderer';
import HomeWorkbench from '@/features/productivity/HomeWorkbench.vue';

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
  it('is one titled collapsible section with symmetric dual-tab cards and no stale section', async () => {
    const html = await render();
    expect(html).toMatch(/data-state="open"[^>]*data-slot="disclosure"/);
    expect(html).toMatch(/data-slot="disclosure-heading">[\s\S]{0,80}工作台/);
    expect((html.match(/data-slot="tabs"/g) ?? []).length).toBe(2);
    expect((html.match(/data-slot="tabs-trigger"/g) ?? []).length).toBe(4);
    expect(html).toContain('未读');
    expect(html).toContain('待处理');
    expect(html).toContain('未读消息');
    expect(html).toContain('执行活动');
    expect(html).toContain('运行活动');
    expect(html).toContain('最近执行');
    // 清理按钮常驻在两张卡片头部，不随 Tab 切换隐藏。
    expect(html).toContain('清理待处理卡片');
    expect(html).toContain('清理最近执行');
    // 不再渲染「没回音」板块。
    expect(html).not.toContain('没回音');
    expect(html).not.toContain('清理没回音');
    expect(html).not.toContain('没有等待回复的记录');
    // 卡头统一：标题与分段控件同处一行 card-header。
    expect(html).toMatch(/data-slot="card-header"[\s\S]{0,400}未读[\s\S]{0,400}data-slot="tabs-list"/);
    expect(html).toMatch(/data-slot="card-header"[\s\S]{0,400}执行活动[\s\S]{0,400}data-slot="tabs-list"/);
    expect(html.indexOf('工作台')).toBeLessThan(html.indexOf('进展摘要'));
    expect(html).not.toMatch(/data-slot="disclosure"[\s\S]*data-slot="disclosure"/);
    expect(html).toContain('home-card');
    expect(html).toContain('home-summary-card');
    expect(html).toContain('home-card-scroll');
  });

  it('renders pending interactions with title-first layout, status badge, and direct interaction link', async () => {
    const now = new Date().toISOString();
    holder.ref.value = {
      pending: [
        {
          id: 'i1',
          kind: 'interaction',
          interactionKind: 'choice',
          title: '选择本次接口契约测试的 mock 策略',
          groupName: '开发验收',
          senderName: 'Codex',
          conversation: 'group:g',
          created: now,
          path: '/groups/g?interaction=i1',
        },
      ],
      unread: [
        {
          id: 'group:g',
          scope: 'group',
          scopeId: 'g',
          conversation: 'group:g',
          title: '开发验收',
          groupName: '开发验收',
          count: 4,
          latest: now,
          latestSeq: 5,
          path: '/groups/g',
        },
      ],
      unreadTotal: 4,
      running: [
        {
          id: 'run-1',
          name: 'Codex',
          groupName: '开发验收',
          created: now,
          queued: 2,
          path: '/groups/g?session=c1',
        },
      ],
      recent: [],
      panelReady: false,
      summary: null,
      summaryRequest: null,
    };
    const html = await renderWithRouter();
    // 待处理 Tab 渲染主标题、右侧状态胶囊、来源与精准跳转链接。
    expect(html).toContain('选择本次接口契约测试的 mock 策略');
    expect(html).toContain('待选择');
    expect(html).toContain('开发验收 · Codex');
    expect(html).toContain('/groups/g?interaction=i1');
    // 运行活动渲染标题旁绿色状态指示与排队条数，非零计数徽标可见。
    expect(html).toContain('aria-label="运行中"');
    expect(html).toContain('排队 2 条');
    expect(html).toContain('data-testid="tab-count-pending"');
    expect(html).toContain('data-testid="tab-count-unread"');
    expect(html).toContain('data-testid="tab-count-running"');
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

// ── 页面级 SSR 冒烟：验证页面能挂载 + 关键区块/空状态存在。 ──
describe('home workbench page SSR smoke', () => {
  const emptyWorkbench = {
    pending: [],
    unread: [],
    unreadTotal: 0,
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
    expect(html).toContain('暂无待处理卡片');
    expect(html).toContain('暂无运行中的成员');
    expect(html).toContain('点击刷新图标，汇总全部团队的近期进展。');
    expect(html).toContain('清理待处理卡片');
    expect(html).toContain('清理最近执行');
    expect(html).not.toContain('data-testid="tab-count-pending"');
    expect(html).not.toContain('data-testid="tab-count-unread"');
    expect(html).not.toContain('data-testid="tab-count-running"');
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
