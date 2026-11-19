// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import DesktopApplications from '@/features/settings/DesktopApplications.vue';
import { api } from '@/shared/api/client';
import type { DesktopApplicationStatus } from '@/shared/api/raw-types';

vi.mock('@/shared/api/client', () => ({ api: {
  desktopApplications: vi.fn(),
  desktopDetect: vi.fn(),
  desktopVerify: vi.fn(),
  desktopInstall: vi.fn(),
  desktopDisable: vi.fn(),
  desktopEnable: vi.fn(),
  desktopRemove: vi.fn(),
} }));

const available: DesktopApplicationStatus = {
  kind: 'codex', label: 'Codex', installed: true, state: 'available', reason: null,
  applicationId: 'app1', installPath: '/Applications/ChatGPT.app', bundleVersion: '26.1', enginePath: '/engine', engineVersion: '0.169.1',
  verifiedAt: '2026-11-20T00:00:00.000Z', userDisabled: false, lifecycleNote: null, diagnostics: null,
};
const uninstalled: DesktopApplicationStatus = {
  kind: 'dsh', label: 'DSH', installed: false, state: 'unavailable', reason: '未检测到应用安装',
  applicationId: null,
};

function mountComponent() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return mount(DesktopApplications, {
    props: { active: true },
    global: { plugins: [[VueQueryPlugin, { queryClient: client }]] },
  });
}
async function settle() {
  await flushPromises();
  await new Promise(resolve => setTimeout(resolve, 10));
  await flushPromises();
}

describe('desktop applications panel', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('lists one row per supported application with a single user-visible state', async () => {
    vi.mocked(api.desktopApplications).mockResolvedValue([available, uninstalled]);
    const wrapper = mountComponent();
    await settle();
    const badges = wrapper.findAll('[data-slot="badge"]').map(badge => badge.text());
    expect(badges).toEqual(['可用', '未安装']);
  });

  it('demands explicit quota confirmation before running verification', async () => {
    vi.mocked(api.desktopApplications).mockResolvedValue([available]);
    vi.mocked(api.desktopVerify).mockResolvedValue({ verified: false, needsConfirmation: true, cost: '会消耗少量模型额度' });
    const wrapper = mountComponent();
    await settle();
    const verifyButton = wrapper.findAll('button').find(button => button.text() === '验证')!;
    await verifyButton.trigger('click');
    await settle();
    // 第一次点击:只请求确认,不执行验证;按钮转为确认文案。
    expect(api.desktopVerify).toHaveBeenCalledWith('codex', false);
    expect(wrapper.findAll('button').some(button => button.text() === '确认消耗额度并验证')).toBe(true);
    // 第二次点击:携带确认执行。
    vi.mocked(api.desktopVerify).mockResolvedValue({ verified: true, application: available });
    await wrapper.findAll('button').find(button => button.text() === '确认消耗额度并验证')!.trigger('click');
    await settle();
    expect(api.desktopVerify).toHaveBeenLastCalledWith('codex', true);
    expect(wrapper.findAll('button').some(button => button.text() === '验证')).toBe(true);
  });

  it('shows the install result including the manual bridge payload for dsh', async () => {
    vi.mocked(api.desktopApplications).mockResolvedValue([uninstalled]);
    vi.mocked(api.desktopInstall).mockResolvedValue({
      applicationId: 'app-fake-dsh',
      binding: { id: 'b1', name: 'DSH Desktop 接入', bindingKind: 'activation', surface: 'desktop', host: 'dsh' },
      socketPath: '/tmp/bus.sock',
      manual: true,
      mcpConfig: { serverName: 'agent_team', transport: 'stdio' },
      limitations: ['需要手动粘贴'],
      nextStep: '把 mcpConfig 粘贴进 DSH Desktop Profile 的 MCP 设置。',
    });
    const wrapper = mountComponent();
    await settle();
    await wrapper.findAll('button').find(button => button.text() === '接入')!.trigger('click');
    await settle();
    expect(api.desktopInstall).toHaveBeenCalledWith('dsh');
    expect(wrapper.text()).toContain('粘贴到 DSH Desktop Profile 的 MCP 配置');
    expect(wrapper.text()).toContain('serverName');
  });
});
