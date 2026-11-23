// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import DesktopTitlebar from '@/app/layouts/DesktopTitlebar.vue';
import type { AgentTeamDesktop, DesktopMenuState } from '@/env';

function stubDesktop(overrides: Partial<AgentTeamDesktop> = {}) {
  const state: DesktopMenuState = {
    hasService: true,
    dev: false,
    showingError: false,
    version: '0.5.3',
  };
  const bridge: AgentTeamDesktop = {
    isDesktop: true,
    platform: 'win32',
    retryService: vi.fn(async () => true),
    chooseDirectory: vi.fn(async () => ({ path: null })),
    windowControl: vi.fn(async () => true),
    isMaximized: vi.fn(async () => false),
    onMaximizedChange: vi.fn(() => () => {}),
    getMenuState: vi.fn(async () => state),
    onMenuStateChange: vi.fn(() => () => {}),
    runMenuAction: vi.fn(async () => true),
    ...overrides,
  };
  globalThis.agentTeam = bridge;
  return bridge;
}

afterEach(() => {
  delete globalThis.agentTeam;
  document.documentElement.removeAttribute('data-desktop');
});

describe('DesktopTitlebar', () => {
  it('浏览器环境下不渲染桌面顶栏也不写入 data-desktop', async () => {
    delete globalThis.agentTeam;
    const wrapper = mount(DesktopTitlebar);
    await flushPromises();
    expect(wrapper.find('[data-testid="desktop-titlebar"]').exists()).toBe(false);
    expect(document.documentElement.hasAttribute('data-desktop')).toBe(false);
  });

  it('Windows 下渲染单行自定义菜单与窗口控制按钮，不含「在浏览器中打开」顶栏快捷按钮', async () => {
    const bridge = stubDesktop({ platform: 'win32' });
    const wrapper = mount(DesktopTitlebar);
    await flushPromises();

    const bar = wrapper.get('[data-testid="desktop-titlebar"]');
    expect(bar.attributes('data-platform')).toBe('win32');
    expect(document.documentElement.getAttribute('data-desktop')).toBe('true');
    expect(bar.find('[data-testid="desktop-menu-file"]').text()).toBe('文件');
    expect(bar.find('[data-testid="desktop-menu-service"]').text()).toBe('服务');
    expect(bar.find('[data-testid="desktop-menu-help"]').text()).toBe('帮助');
    expect(bar.find('[data-testid="desktop-service-status"]').text()).toContain('本地服务就绪');
    expect(bar.text()).not.toContain('浏览器打开');
    expect(wrapper.html()).not.toContain('显示 Agent Team');

    await bar.get('[data-testid="window-minimize"]').trigger('click');
    await bar.get('[data-testid="window-maximize"]').trigger('click');
    await bar.get('[data-testid="window-close"]').trigger('click');
    expect(bridge.windowControl).toHaveBeenNthCalledWith(1, 'minimize');
    expect(bridge.windowControl).toHaveBeenNthCalledWith(2, 'maximize-toggle');
    expect(bridge.windowControl).toHaveBeenNthCalledWith(3, 'close');

    wrapper.unmount();
    expect(document.documentElement.hasAttribute('data-desktop')).toBe(false);
  });

  it('Linux 下渲染无边框圆形窗口控制按钮与中文菜单', async () => {
    stubDesktop({ platform: 'linux' });
    const wrapper = mount(DesktopTitlebar);
    await flushPromises();

    const bar = wrapper.get('[data-testid="desktop-titlebar"]');
    expect(bar.attributes('data-platform')).toBe('linux');
    expect(bar.find('[data-testid="desktop-menu-file"]').exists()).toBe(true);
    expect(bar.get('[data-testid="window-close"]').classes()).toContain('rounded-full');
  });

  it('macOS 下预留交通灯安全区且不渲染窗内菜单与右侧窗口控制按钮', async () => {
    stubDesktop({ platform: 'darwin' });
    const wrapper = mount(DesktopTitlebar);
    await flushPromises();

    const bar = wrapper.get('[data-testid="desktop-titlebar"]');
    expect(bar.attributes('data-platform')).toBe('darwin');
    expect(bar.find('[data-testid="desktop-menu-file"]').exists()).toBe(false);
    expect(bar.find('[data-testid="window-minimize"]').exists()).toBe(false);
    expect(bar.find('[data-testid="window-close"]').exists()).toBe(false);
    expect(bar.html()).toContain('pl-[76px]');
  });
});
