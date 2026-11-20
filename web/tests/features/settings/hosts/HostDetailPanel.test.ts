// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import HostDetailPanel from '@/features/settings/hosts/HostDetailPanel.vue';
import { api } from '@/shared/api/client';
import type { DesktopApplicationStatus, HostStatus } from '@/shared/api/raw-types';

vi.mock('@/shared/api/client', () => ({ api: {
  desktopApplications: vi.fn(),
  desktopDetect: vi.fn(),
  desktopVerify: vi.fn(),
  desktopInstall: vi.fn(),
  desktopDisable: vi.fn(),
  desktopEnable: vi.fn(),
  desktopRemove: vi.fn(),
  probeHosts: vi.fn(),
  installHost: vi.fn(),
} }));

const codex: DesktopApplicationStatus = {
  kind: 'codex', label: 'Codex', installed: true, state: 'available', reason: null,
  applicationId: 'app-codex', bundleVersion: '26.1', engineVersion: '0.169.1',
  verifiedAt: '2026-11-20T00:00:00.000Z', userDisabled: false, lifecycleNote: null,
};
const dshPullOnly: DesktopApplicationStatus = {
  ...codex,
  kind: 'dsh',
  label: 'DSH',
  state: 'pull-only',
  applicationId: 'app-dsh',
  lifecycleNote: '需要手动查看消息',
};

const cliAvailable: HostStatus[] = [
  { name: 'codex', status: 'available' },
  { name: 'dsh', status: 'available' },
];

function mountDetail(kind: 'codex' | 'dsh') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return mount(HostDetailPanel, {
    props: { kind },
    global: { plugins: [[VueQueryPlugin, { queryClient: client }]] },
  });
}

async function settle() {
  await flushPromises();
  await new Promise(resolve => setTimeout(resolve, 10));
  await flushPromises();
}

describe('host detail panel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.desktopApplications).mockResolvedValue([codex, dshPullOnly]);
    vi.mocked(api.probeHosts).mockResolvedValue(cliAvailable);
  });

  it('renders the grid sections and returns to the host list', async () => {
    const wrapper = mountDetail('codex');
    await settle();

    expect(wrapper.text()).toContain('Codex 桌面应用');
    expect(wrapper.text()).toContain('角色与能力');
    expect(wrapper.text()).toContain('接入信息');
    expect(wrapper.text()).toContain('CLI 适配器');

    await wrapper.find('[aria-label="返回宿主列表"]').trigger('click');
    expect(wrapper.emitted('back')).toHaveLength(1);
  });

  it('keeps the two-step quota confirmation before verification', async () => {
    vi.mocked(api.desktopVerify).mockResolvedValueOnce({ verified: false, needsConfirmation: true, cost: '会消耗少量模型额度' });
    const wrapper = mountDetail('codex');
    await settle();

    await wrapper.findAll('button').find(button => button.text() === '验证连接')!.trigger('click');
    await settle();
    expect(api.desktopVerify).toHaveBeenCalledWith('codex', false);
    expect(wrapper.findAll('button').some(button => button.text() === '确认消耗额度并验证')).toBe(true);

    vi.mocked(api.desktopVerify).mockResolvedValueOnce({ verified: true, application: codex });
    await wrapper.findAll('button').find(button => button.text() === '确认消耗额度并验证')!.trigger('click');
    await settle();
    expect(api.desktopVerify).toHaveBeenLastCalledWith('codex', true);
  });

  it('shows pull-only only in the detail view', async () => {
    const wrapper = mountDetail('dsh');
    await settle();

    expect(wrapper.text()).toContain('Pull-only');
    expect(wrapper.text()).toContain('仅拉取');
    expect(wrapper.text()).toContain('需要手动查看消息');
  });

  // 状态标签跟标题同一行，右侧只留异常项的操作入口。
  it('puts the capability badge in the title row', async () => {
    const wrapper = mountDetail('codex');
    await settle();

    const titles = wrapper.findAll('[data-slot="item-title"]');
    expect(titles[0].text().replace(/\s/g, '')).toBe('桌面主控可用');
    expect(titles[0].find('[data-slot="badge"]').exists()).toBe(true);
  });

  // 只有不正常的能力项才给「详情」；可用项不该有入口。
  it('offers a detail button only for abnormal capabilities', async () => {
    const wrapper = mountDetail('dsh');
    await settle();

    const labels = wrapper.findAll('button').filter(button => button.text() === '详情');
    expect(labels).toHaveLength(1);

    await labels[0].trigger('click');
    await settle();
    expect(document.body.textContent).toContain('桌面主控 · 仅拉取');
    expect(document.body.textContent).toContain('需要手动查看消息');
    wrapper.unmount();
  });

  // CLI 原因是一长段 stderr，放进弹窗，卡片里只留状态和入口。
  it('shows the CLI failure reason in a dialog', async () => {
    vi.mocked(api.probeHosts).mockResolvedValue([
      { name: 'codex', status: 'available' },
      { name: 'dsh', status: 'error', reason: 'dsh: warning: missing module' },
    ]);
    const wrapper = mountDetail('dsh');
    await settle();

    expect(document.body.textContent).not.toContain('dsh: warning: missing module');
    // 异常项有两个（主控仅拉取 + CLI 需配置），CLI 那张卡排在最后。
    await wrapper.findAll('button').filter(button => button.text() === '详情')[1].trigger('click');
    await settle();

    expect(document.body.textContent).toContain('CLI 适配器 · 需配置');
    expect(document.body.textContent).toContain('dsh: warning: missing module');
    wrapper.unmount();
  });

  // CLI 安装以前在设置页的列表里，现在只在这张卡上出现，且仅在未安装时。
  it('installs the CLI adapter from the capability card', async () => {
    vi.mocked(api.probeHosts).mockResolvedValue([
      { name: 'codex', status: 'available' },
      { name: 'dsh', status: 'missing' },
    ]);
    vi.mocked(api.installHost).mockResolvedValue({ name: 'dsh', status: 'available' });
    const wrapper = mountDetail('dsh');
    await settle();

    await wrapper.findAll('button').find(button => button.text() === '安装')!.trigger('click');
    await settle();

    expect(api.installHost).toHaveBeenCalledWith('dsh');
    expect(api.probeHosts).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });
});
