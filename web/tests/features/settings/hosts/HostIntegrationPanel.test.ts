// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import HostIntegrationPanel from '@/features/settings/hosts/HostIntegrationPanel.vue';
import { api } from '@/shared/api/client';
import type { DesktopApplicationStatus } from '@/shared/api/raw-types';

vi.mock('@/shared/api/client', () => ({ api: {
  desktopApplications: vi.fn(),
  desktopDetect: vi.fn(),
} }));

const codex: DesktopApplicationStatus = {
  kind: 'codex', label: 'Codex', installed: true, state: 'available', reason: null,
  applicationId: 'app-codex', verifiedAt: '2026-11-20T00:00:00.000Z', userDisabled: false,
};
const claude: DesktopApplicationStatus = {
  ...codex,
  kind: 'claude',
  label: 'Claude',
  state: 'pull-only',
  applicationId: 'app-claude',
};
const dsh: DesktopApplicationStatus = {
  ...codex,
  kind: 'dsh',
  label: 'DSH',
  state: 'available',
  applicationId: 'app-dsh',
};
const zcode: DesktopApplicationStatus = {
  ...codex,
  kind: 'zcode',
  label: 'ZCode',
  state: 'available',
  applicationId: 'app-zcode',
};

function mountPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return mount(HostIntegrationPanel, {
    props: { active: true },
    global: { plugins: [[VueQueryPlugin, { queryClient: client }]] },
  });
}

async function settle() {
  await flushPromises();
  await new Promise(resolve => setTimeout(resolve, 10));
  await flushPromises();
}

describe('host integration panel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.desktopApplications).mockResolvedValue([codex, claude, dsh, zcode]);
  });

  it('shows four host cards with available state and a detail button at the end', async () => {
    const wrapper = mountPanel();
    await settle();

    const text = wrapper.text();
    expect(text).toContain('Codex 桌面应用');
    expect(text).toContain('Claude 桌面应用');
    expect(text).toContain('DeepSeek Harness 桌面应用');
    expect(text).toContain('ZCode 桌面应用');
    expect(text).toContain('桌面应用已检测 · 内置引擎可用');

    const badges = wrapper.findAll('[data-slot="badge"]').map(badge => badge.text());
    expect(badges.slice(0, 4)).toEqual(['可用', '可用', '可用', '可用']);
    expect(wrapper.findAll('button').filter(button => button.text() === '查看详情')).toHaveLength(4);
  });

  it('emits the selected host when the detail button is clicked', async () => {
    const wrapper = mountPanel();
    await settle();

    await wrapper.findAll('button').find(button => button.text() === '查看详情')!.trigger('click');
    expect(wrapper.emitted('open-detail')?.[0]).toEqual(['codex']);
  });

  // 状态标签紧跟在标题后面，不再单占右侧一列；右侧只留进入详情页的按钮。
  it('puts the state badge in the title row and leaves only the action on the right', async () => {
    const wrapper = mountPanel();
    await settle();

    const titles = wrapper.findAll('[data-slot="item-title"]');
    expect(titles).toHaveLength(4);
    expect(titles[0].find('[data-slot="badge"]').exists()).toBe(true);
    expect(titles[0].text().replace(/\s/g, '')).toBe('Codex桌面应用可用');
    expect(wrapper.findAll('[data-slot="item-actions"]')[0].find('[data-slot="badge"]').exists()).toBe(false);
  });

  // 宿主集成已经包含 CLI 适配器状态，设置页不再重复一整块列表。
  it('no longer renders a separate CLI adapter list', async () => {
    const wrapper = mountPanel();
    await settle();

    expect(wrapper.text()).not.toContain('CLI 适配器');
    expect(wrapper.text()).not.toContain('Codex CLI');
  });

  it('refreshes with an icon button instead of a text button', async () => {
    const wrapper = mountPanel();
    await settle();

    const button = wrapper.find('[aria-label="重新检测"]');
    expect(button.exists()).toBe(true);
    expect(button.text()).toBe('');
    expect(button.find('svg').exists()).toBe(true);

    await button.trigger('click');
    await settle();
    expect(api.desktopApplications).toHaveBeenCalledTimes(2);
  });
});
