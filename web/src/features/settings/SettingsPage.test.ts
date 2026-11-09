import { describe, expect, it, vi } from 'vitest';
import { h } from 'vue';
import SettingsPage from './SettingsPage.vue';
import { renderPage, stubSsrBrowser } from '@/test/ssr';

/**
 * 设置页 SSR 冒烟：五个分区入口都在，深链能切到对应分区。
 *
 * 拆成「页面 + 五个标签组件」之前先有这层网：这个组件此前没有任何测试，
 * 动模板只能靠肉眼。断言只覆盖结构，不测具体交互。
 */

vi.mock('@tanstack/vue-query', async () => {
  const { ref } = await import('vue');
  return {
    useQuery: () => ({ data: ref([]), isPending: ref(false), refetch: vi.fn() }),
    useQueryClient: () => ({ removeQueries: vi.fn(), invalidateQueries: vi.fn() }),
  };
});

// 这两个子组件各自依赖宿主/服务查询层，冒烟测试只关心设置页自身的结构。
vi.mock('./HostStatuses.vue', async () => { const { h } = await import('vue'); return { default: { render: () => h('div', 'host-statuses') } }; });
vi.mock('./LocalService.vue', async () => { const { h } = await import('vue'); return { default: { render: () => h('div', 'local-service') } }; });

vi.mock('@/shared/api/client', () => ({
  api: {
    themePacks: vi.fn(async () => []),
    createThemePack: vi.fn(),
    deleteThemePack: vi.fn(),
    deleteTeam: vi.fn(),
  },
}));

function render(component = SettingsPage, path = '/settings') {
  stubSsrBrowser();
  return renderPage({ render: () => h(component) }, path);
}

describe('settings page', () => {
  it('renders every section entry and opens on appearance', async () => {
    const { html } = await render();
    // 只认 role="tab" 按钮里的文字：正文里也可能出现「通用」这类词，
    // 先前用 toContain 断言时，把标签改坏测试仍然通过。
    const labels = html
      .split('role="tab"')
      .slice(1)
      .map((chunk) => chunk.slice(chunk.indexOf('>') + 1).replace(/<!--.*?-->/g, '').split('<')[0].trim());
    expect(labels).toEqual(['外观', '通用', '工具', '模型策略', '团队管理']);
    // 默认只选中第一个分区。
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
  });

  it.each([
    ['appearance', '设计预设'],
    ['general', '思考过程'],
    ['tools', '工具是面板里的功能模块'],
    ['policy', '当前规则'],
    ['teams', '归档团队'],
  ])('deep link ?section=%s renders that panel', async (section, marker) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { html } = await render(SettingsPage, `/settings?section=${section}`);
      expect(html).toContain(marker);
      // 拆标签组件时最容易漏搬图标导入；vue-tsc 不检查模板里的组件名，
      // 只有运行时的「Failed to resolve component」会暴露这种回归。
      expect(warn.mock.calls.flat().join('\n')).not.toMatch(/Failed to resolve component/);
    } finally {
      warn.mockRestore();
    }
  });
});
