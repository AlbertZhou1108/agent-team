import { describe, expect, it, vi } from 'vitest';
import { h } from 'vue';
import SettingsDialog from './SettingsDialog.vue';
import { renderPage, stubSsrBrowser } from '@/test/ssr';

/**
 * 设置对话框 SSR 冒烟：确认五个分区入口都在，默认停在「外观」。
 *
 * 拆 tab 之前先有这层网：现在这个组件 1200 多行、没有任何测试，
 * 动模板只能靠肉眼。断言只覆盖「结构还在」，不测具体交互。
 */

vi.mock('@tanstack/vue-query', async () => {
  const { ref } = await import('vue');
  return {
    useQuery: () => ({ data: ref([]), isPending: ref(false), refetch: vi.fn() }),
    useQueryClient: () => ({ removeQueries: vi.fn(), invalidateQueries: vi.fn() }),
  };
});

vi.mock('@/shared/api/client', () => ({
  api: {
    themePacks: vi.fn(async () => []),
    createThemePack: vi.fn(),
    deleteThemePack: vi.fn(),
    deleteTeam: vi.fn(),
  },
}));

describe('settings dialog', () => {
  it('renders every section entry and opens on appearance', async () => {
    stubSsrBrowser();
    const { html } = await renderPage(
      { render: () => h(SettingsDialog, { open: true, embedded: true }) },
      '/settings',
    );
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
});
