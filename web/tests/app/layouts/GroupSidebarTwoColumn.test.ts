// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick, ref } from 'vue';
import { NotebookPen, Search } from '@lucide/vue';
import GroupSidebar from '@/app/layouts/GroupSidebar.vue';
import App from '@/App.vue';
import { useTeamOrganization } from '@/stores/team-organization';
import { usePreferencesStore } from '@/stores/preferences';
import { useUiStore } from '@/stores/ui';
import { useSortable, SORT_DRAG_TYPE } from '@/shared/use-sortable';
import {
  filterTeamsByQuery,
  formatActiveTime,
  recentTeams,
  sortFoldersByName,
  sortTeamsByActivity,
} from '@/features/layout/team-activity';
import type { Group, Member } from '@/shared/api/raw-types';

vi.mock('@tanstack/vue-query', async () => {
  const { ref: vueRef } = await import('vue');
  return {
    useQuery: () => ({ data: vueRef([]), isPending: vueRef(false), isError: vueRef(false), refetch: vi.fn() }),
  };
});

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
  RouterView: { render: () => null },
}));

const sampleGroups: Group[] = [
  { id: 'g-pin-old', name: '开发验收', workspace: '/tmp/a', lead: 'm1', created: '2026-11-20T08:00:00Z' },
  { id: 'g-pin-new', name: '多角色圆桌', workspace: '/tmp/b', lead: 'm2', created: '2026-11-21T10:00:00Z' },
  { id: 'g-fe', name: '界面验收', workspace: '/tmp/c', lead: 'm3', created: '2026-11-21T09:00:00Z' },
  { id: 'g-be', name: '接口联调', workspace: '/tmp/d', lead: 'm4', created: '2026-11-21T07:00:00Z' },
  { id: 'g-root-1', name: '随心记通信测试', workspace: '/tmp/e', lead: 'm5', created: '2026-11-21T06:00:00Z' },
  { id: 'g-root-2', name: '联调观察室', workspace: '/tmp/f', lead: 'm6', created: '2026-11-21T11:00:00Z' },
];

const sampleMembers: Member[] = [
  { id: 'm1', group_id: 'g-pin-old', name: '张测试', host: 'codex', role: 'lead', profile: '', removed: null, model_provider: null, model: null, reasoning_effort: null },
  { id: 'm2', group_id: 'g-pin-new', name: '林主持', host: 'claude', role: 'lead', profile: '', removed: null, model_provider: null, model: null, reasoning_effort: null },
  { id: 'm3', group_id: 'g-fe', name: '苏前端', host: 'codex', role: 'lead', profile: '', removed: null, model_provider: null, model: null, reasoning_effort: null },
  { id: 'm4', group_id: 'g-be', name: '周后端', host: 'codex', role: 'lead', profile: '', removed: null, model_provider: null, model: null, reasoning_effort: null },
  { id: 'm5', group_id: 'g-root-1', name: '陈验证', host: 'codex', role: 'lead', profile: '', removed: null, model_provider: null, model: null, reasoning_effort: null },
];

const defaultToolEntries = [
  { id: 'builtin.search', label: '全局搜索', icon: Search, current: false },
  { id: 'builtin.notes', label: '随心记', icon: NotebookPen, current: false },
];

function stubMediaQuery(matches = false) {
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
}

function mountSidebar(overrides: Record<string, unknown> = {}) {
  return mount(GroupSidebar, {
    props: {
      groups: sampleGroups,
      members: sampleMembers,
      currentGroupId: 'g-pin-new',
      homeActive: false,
      toolEntries: defaultToolEntries,
      agentActive: false,
      agentUnreadCount: 3,
      settingsActive: false,
      groupUnreadByTeam: new Map([['g-pin-new', 3]]),
      activityByTeam: new Map([
        ['g-pin-new', Date.parse('2026-11-21T12:00:00Z')],
        ['g-pin-old', Date.parse('2026-11-21T08:00:00Z')],
        ['g-root-2', Date.parse('2026-11-21T11:30:00Z')],
      ]),
      ...overrides,
    },
  });
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  stubMediaQuery(false);
});

describe('GroupSidebar 两栏导航', () => {
  it('渲染一级 5 项分固定区/插件区、含分割线、无 Logo、仅图标无文字、无收起按钮与连接状态', () => {
    const wrapper = mountSidebar();
    const rail = wrapper.get('[data-testid="primary-rail"]');

    // 顶部无 Logo、无应用名文字、无连接状态 UI、无收起按钮。
    expect(rail.text()).not.toContain('Agent Team');
    expect(rail.text()).not.toContain('本机已连接');
    expect(rail.text()).not.toContain('正在连接');
    expect(rail.find('[aria-label*="收起"]').exists()).toBe(false);

    // 固定区 3 项 + 分割线 + 插件区 2 项。
    const fixedIds = rail.findAll('[data-nav-zone="fixed"] [data-primary-id]').map(el => el.attributes('data-primary-id'));
    const pluginIds = rail.findAll('[data-nav-zone="plugin"] [data-tool-id]').map(el => el.attributes('data-tool-id'));
    expect(fixedIds).toEqual(['home', 'team', 'agent']);
    expect(pluginIds).toEqual(['builtin.search', 'builtin.notes']);
    expect(rail.find('.primary-nav-separator').exists()).toBe(true);

    // 一级按钮全部仅图标（无 item-content 文字、无折叠箭头），但具备完整 aria-label。
    const navButtons = rail.findAll('[data-component="navigation-item"]');
    expect(navButtons.length).toBe(6); // 5 一级项 + 底部设置
    for (const button of navButtons) {
      expect(button.attributes('data-collapsed')).toBe('true');
      expect(button.find('[data-slot="item-content"]').exists()).toBe(false);
      expect(button.find('[data-part="disclosure-indicator"]').exists()).toBe(false);
      expect(button.attributes('aria-label')).toBeTruthy();
    }

    // Panel Agent 未读角标保留在一级图标上。
    expect(rail.find('.sidebar-unread-count').text()).toBe('3');
    // 默认选中团队，二级面板展示。
    expect(wrapper.find('[data-testid="team-secondary-panel"]').exists()).toBe(true);
    const teamBtn = rail.get('[data-primary-id="team"] [data-component="navigation-item"]');
    expect(teamBtn.attributes('aria-pressed')).toBe('true');
    expect(teamBtn.attributes('data-current')).toBe('true');
  });

  it('点击跳页/动作型一级项触发对应事件并隐藏二级面板，再点团队恢复显示', async () => {
    const wrapper = mountSidebar();
    const rail = wrapper.get('[data-testid="primary-rail"]');

    await rail.get('[data-primary-id="home"] [data-component="navigation-item"]').trigger('click');
    expect(wrapper.emitted('select')).toEqual([['']]);
    expect(wrapper.find('[data-testid="team-secondary-panel"]').exists()).toBe(false);

    await rail.get('[data-primary-id="team"] [data-component="navigation-item"]').trigger('click');
    expect(wrapper.find('[data-testid="team-secondary-panel"]').exists()).toBe(true);

    await rail.get('[data-primary-id="agent"] [data-component="navigation-item"]').trigger('click');
    expect(wrapper.emitted('openAgent')).toHaveLength(1);
    expect(wrapper.find('[data-testid="team-secondary-panel"]').exists()).toBe(false);

    await rail.get('[data-primary-id="team"] [data-component="navigation-item"]').trigger('click');
    await rail.get('[data-tool-id="builtin.notes"] [data-component="navigation-item"]').trigger('click');
    expect(wrapper.emitted('activateTool')).toEqual([['builtin.notes']]);
    expect(wrapper.find('[data-testid="team-secondary-panel"]').exists()).toBe(false);

    await rail.get('[data-primary-id="team"] [data-component="navigation-item"]').trigger('click');
    await rail.get('[data-tool-id="builtin.search"] [data-component="navigation-item"]').trigger('click');
    expect(wrapper.emitted('activateTool')).toEqual([['builtin.notes'], ['builtin.search']]);
    expect(wrapper.find('[data-testid="team-secondary-panel"]').exists()).toBe(false);
  });

  it('遵循固定区排序偏好渲染一级图标', () => {
    const preferences = usePreferencesStore();
    preferences.setPrimaryNavOrder(['agent', 'team', 'home']);
    const wrapper = mountSidebar();
    const fixedIds = wrapper
      .findAll('[data-nav-zone="fixed"] [data-primary-id]')
      .map(el => el.attributes('data-primary-id'));
    expect(fixedIds).toEqual(['agent', 'team', 'home']);
  });

  it('窄屏模式下仅渲染一级栏，不渲染团队二级面板', () => {
    stubMediaQuery(true);
    const wrapper = mountSidebar();
    expect(wrapper.find('[data-testid="primary-rail"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="team-secondary-panel"]').exists()).toBe(false);
  });
});

describe('TeamSecondaryPanel 新设计：固定排序、全分组折叠、最近访问 9 项、浮动收起与多选批量归档', () => {
  it('按 置顶 → 文件夹按名称 → 未分组 展示，三者均支持收起/展开且默认折叠并持久化', async () => {
    const org = useTeamOrganization();
    org.togglePin('g-pin-old');
    org.togglePin('g-pin-new');
    const fBe = org.createFolder('后端架构')!;
    const fFe = org.createFolder('前端开发')!;
    org.move(['g-fe'], fFe);
    org.move(['g-be'], fBe);

    const wrapper = mountSidebar();
    const panel = wrapper.get('[data-testid="team-secondary-panel"]');

    // 分区顺序：置顶 → 文件夹（zh-CN 拼音：后端架构 在 前端开发 之前）→ 未分组。
    const sections = panel.findAll('[data-section-kind]');
    expect(sections.map(s => s.attributes('data-section-kind'))).toEqual([
      'pinned',
      'folder',
      'folder',
      'ungrouped',
    ]);

    // 置顶、文件夹、未分组均具备折叠按钮且默认折叠，组内按活跃时间降序。
    const pinnedTrigger = panel.get('[data-section-kind="pinned"] .team-folder-trigger');
    const ungroupedTrigger = panel.get('[data-section-kind="ungrouped"] .team-folder-trigger');
    expect(pinnedTrigger.attributes('aria-expanded')).toBe('false');
    expect(ungroupedTrigger.attributes('aria-expanded')).toBe('false');

    await pinnedTrigger.trigger('click');
    await ungroupedTrigger.trigger('click');
    expect(pinnedTrigger.attributes('aria-expanded')).toBe('true');
    expect(ungroupedTrigger.attributes('aria-expanded')).toBe('true');
    expect(org.sections).toEqual({ pinned: false, ungrouped: false });
    expect(
      panel.findAll('[data-section-kind="pinned"] [data-team-id]').map(el => el.attributes('data-team-id')),
    ).toEqual(['g-pin-new', 'g-pin-old']);
    expect(
      panel.findAll('[data-section-kind="ungrouped"] [data-team-id]').map(el => el.attributes('data-team-id')),
    ).toEqual(['g-root-2', 'g-root-1']);

    // 再次点击可收起并持久化。
    await pinnedTrigger.trigger('click');
    expect(pinnedTrigger.attributes('aria-expanded')).toBe('false');
    expect(org.sections.pinned).toBe(true);

    // 命名文件夹按名称排序且默认折叠，点击后展开并持久化。
    const folderTriggers = panel.findAll('[data-section-kind="folder"] .team-folder-trigger');
    expect(folderTriggers.map(t => t.text().replace(/\s+/g, ''))).toEqual([
      '后端架构·1',
      '前端开发·1',
    ]);
    for (const trigger of folderTriggers) {
      expect(trigger.attributes('aria-expanded')).toBe('false');
    }
    await folderTriggers[1]!.trigger('click');
    expect(org.folders.find(f => f.id === fFe)?.collapsed).toBe(false);

    // 最近访问在「全部」标签页可见且带横向滚动条。
    const recentStrip = panel.get('.recent-teams-strip');
    expect(recentStrip.classes()).toContain('overflow-x-auto');
    expect(recentStrip.classes()).toContain('scrollbar-thin');
  });

  it('最近访问随切换团队即时更新顺序、最多保留 9 个且过滤已归档团队', async () => {
    const manyGroups: Group[] = Array.from({ length: 11 }, (_, idx) => ({
      id: `team-${idx + 1}`,
      name: `团队${idx + 1}`,
      workspace: `/tmp/t-${idx + 1}`,
      lead: 'm1',
      created: '2026-11-21T10:00:00Z',
    }));

    const wrapper = mountSidebar({
      groups: manyGroups,
      currentGroupId: 'team-1',
    });
    const panel = wrapper.get('[data-testid="team-secondary-panel"]');

    const recentIds = () =>
      panel.findAll('.recent-team-avatar').map(btn => btn.attributes('title'));

    expect(recentIds()).toEqual(['团队1']);

    // 依次切换到 team-2..team-11，最新访问排在首位且总量上限为 9 个。
    for (let i = 2; i <= 11; i += 1) {
      await wrapper.setProps({ currentGroupId: `team-${i}` });
      await nextTick();
    }
    expect(recentIds()).toEqual([
      '团队11', '团队10', '团队9', '团队8', '团队7', '团队6', '团队5', '团队4', '团队3',
    ]);

    // 再次点击较早访问的团队（team-5）时，移到最前位且不重复。
    await panel.get('.recent-team-avatar[title="团队5"]').trigger('click');
    expect(wrapper.emitted('select')).toEqual([['team-5']]);
    await nextTick();
    expect(recentIds()).toEqual([
      '团队5', '团队11', '团队10', '团队9', '团队8', '团队7', '团队6', '团队4', '团队3',
    ]);

    // 若团队被归档移除出 groups，自动从最近访问过滤掉。
    await wrapper.setProps({
      groups: manyGroups.filter(g => g.id !== 'team-10'),
    });
    await nextTick();
    expect(recentIds()).toEqual([
      '团队5', '团队11', '团队9', '团队8', '团队7', '团队6', '团队4', '团队3',
    ]);
  });

  it('右下角浮动收起按钮可收起团队二级面板，点击一级「团队」图标重新展开', async () => {
    const wrapper = mountSidebar();
    const rail = wrapper.get('[data-testid="primary-rail"]');
    const collapseBtn = wrapper.get('[data-testid="team-secondary-collapse-btn"]');

    expect(collapseBtn.attributes('aria-label')).toBe('收起团队面板');
    await collapseBtn.trigger('click');
    expect(wrapper.find('[data-testid="team-secondary-panel"]').exists()).toBe(false);
    expect(wrapper.emitted('update:secondaryOpen')).toEqual([[false]]);

    // 点击最左一级图标栏的「团队」图标重新展开。
    await rail.get('[data-primary-id="team"] [data-component="navigation-item"]').trigger('click');
    expect(wrapper.find('[data-testid="team-secondary-panel"]').exists()).toBe(true);
    expect(wrapper.emitted('update:secondaryOpen')).toEqual([[false], [true]]);
  });

  it('支持按团队名与成员名搜索，以及分段筛选切换（最近访问仅在「全部」标签页出现）', async () => {
    const org = useTeamOrganization();
    org.togglePin('g-pin-new');
    const fFe = org.createFolder('前端开发')!;
    org.move(['g-fe'], fFe);

    const wrapper = mountSidebar();
    const panel = wrapper.get('[data-testid="team-secondary-panel"]');
    expect(panel.find('.recent-teams-strip').exists()).toBe(true);

    // 按成员名搜索「苏前端」自动展开匹配文件夹并隐藏最近访问。
    const searchInput = panel.get('input[aria-label="搜索团队或成员"]');
    await searchInput.setValue('苏前端');
    await nextTick();
    expect(panel.findAll('[data-team-id]').map(el => el.attributes('data-team-id'))).toEqual(['g-fe']);
    expect(panel.find('.recent-teams-strip').exists()).toBe(false);

    // 清空搜索，切换分段到「置顶 / 文件夹 / 未分组」均不展示最近访问，切回「全部」恢复。
    await searchInput.setValue('');
    const tabs = panel.findAll('[role="tab"]');
    await tabs[1]!.trigger('mousedown', { button: 0 });
    expect(panel.findAll('[data-section-kind]').map(el => el.attributes('data-section-kind'))).toEqual(['pinned']);
    expect(panel.find('[data-section-kind="pinned"] .collapse-reveal').attributes('data-open')).toBe('true');
    expect(panel.find('.recent-teams-strip').exists()).toBe(false);

    await tabs[2]!.trigger('mousedown', { button: 0 });
    expect(panel.find('.recent-teams-strip').exists()).toBe(false);

    await tabs[3]!.trigger('mousedown', { button: 0 });
    expect(panel.find('.recent-teams-strip').exists()).toBe(false);

    await tabs[0]!.trigger('mousedown', { button: 0 });
    expect(panel.find('.recent-teams-strip').exists()).toBe(true);
  });

  it('保留 Shift/Cmd 多选，置顶为空时不显示占位并支持多选工具栏批量置顶/取消置顶与批量归档', async () => {
    const org = useTeamOrganization();
    org.expandSection('ungrouped');
    const wrapper = mountSidebar({
      groups: sampleGroups.slice(4),
      currentGroupId: 'g-root-2',
    });
    const panel = wrapper.get('[data-testid="team-secondary-panel"]');
    expect(panel.find('[data-section-kind="pinned"]').exists()).toBe(false);

    const nav = panel.get('.team-navigation');
    expect(nav.attributes('data-multi-select')).toBeUndefined();

    const cards = panel.findAll('[data-section-kind="ungrouped"] .team-card');
    expect(cards).toHaveLength(2);

    // Cmd/Ctrl 点击第二张卡片加入选区：当前团队卡与新选中卡同具 data-selected，且 nav 标明多选态。
    await cards[1]!.trigger('click', { metaKey: true });
    expect(nav.attributes('data-multi-select')).toBe('true');
    expect(cards[0]!.attributes('data-current')).toBe('true');
    expect(cards[0]!.attributes('data-selected')).toBe('true');
    expect(cards[1]!.attributes('data-selected')).toBe('true');
    expect(panel.get('[data-batch-toolbar="true"]').text()).toContain('已选 2 个团队');

    // 点击批量置顶后进入置顶分组（自动展开）并清空选区。
    await panel.get('[aria-label="批量置顶已选团队"]').trigger('click');
    expect(org.teams['g-root-2']?.pinned).toBe(true);
    expect(org.teams['g-root-1']?.pinned).toBe(true);
    expect(org.sections.pinned).toBe(false);
    expect(panel.find('[data-batch-toolbar="true"]').exists()).toBe(false);
    expect(panel.findAll('[data-section-kind="pinned"] .team-card')).toHaveLength(2);

    // 在置顶分组中再次多选，按钮切换为「取消置顶」，点击后恢复到未分组。
    const pinnedCards = panel.findAll('[data-section-kind="pinned"] .team-card');
    await pinnedCards[0]!.trigger('click');
    await pinnedCards[1]!.trigger('click', { metaKey: true });
    await panel.get('[aria-label="批量取消置顶已选团队"]').trigger('click');
    expect(org.teams['g-root-2']?.pinned).toBeUndefined();
    expect(org.teams['g-root-1']?.pinned).toBeUndefined();
    expect(panel.find('[data-section-kind="pinned"]').exists()).toBe(false);

    // 重新多选并验证批量归档。
    const ungroupedCards = panel.findAll('[data-section-kind="ungrouped"] .team-card');
    await ungroupedCards[0]!.trigger('click');
    await ungroupedCards[1]!.trigger('click', { metaKey: true });
    await panel.get('[aria-label="批量归档已选团队"]').trigger('click');
    expect(wrapper.emitted('archive')).toEqual([[['g-root-2', 'g-root-1']]]);
  });
});

describe('全局搜索插件禁用与跨区拖拽隔离', () => {
  it('禁用 builtin.search 后弹层卸载且 ⌘K / Ctrl+K 不再打开搜索弹层', async () => {
    stubMediaQuery();
    const preferences = usePreferencesStore();
    const ui = useUiStore();
    const wrapper = mount(App);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, cancelable: true }));
    await nextTick();
    expect(ui.searchOpen).toBe(true);

    // 禁用全局搜索插件后浮层卸载并关闭 searchOpen，且 ⌘K 不再打开。
    preferences.setToolEnabled('builtin.search', false);
    await nextTick();
    expect(ui.searchOpen).toBe(false);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, cancelable: true }));
    await nextTick();
    expect(ui.searchOpen).toBe(false);

    wrapper.unmount();
  });

  it('useSortable 不同 scope 之间隔离，不互相接收拖拽', () => {
    const fixedRoot = ref<HTMLElement | null>(document.createElement('div'));
    const pluginRoot = ref<HTMLElement | null>(document.createElement('div'));
    const fixedReorder = vi.fn();
    const pluginReorder = vi.fn();

    const fixed = useSortable({
      root: fixedRoot,
      scope: 'primary-fixed',
      ids: () => ['home', 'team', 'agent'],
      canDrag: () => true,
      canTarget: () => true,
      axis: () => 'y',
      onReorder: fixedReorder,
    });
    const plugin = useSortable({
      root: pluginRoot,
      scope: 'primary-plugin',
      ids: () => ['builtin.search:left-nav', 'builtin.notes:left-nav'],
      canDrag: () => true,
      canTarget: () => true,
      axis: () => 'y',
      onReorder: pluginReorder,
    });

    const elA = document.createElement('div');
    const elB = document.createElement('div');
    fixed.bindItem('home', elA);
    plugin.bindItem('builtin.search:left-nav', elB);

    expect(SORT_DRAG_TYPE).toBe('sortable-item-drags');
    expect(fixedReorder).not.toHaveBeenCalled();
    expect(pluginReorder).not.toHaveBeenCalled();

    fixed.dispose();
    plugin.dispose();
  });

  it('team-activity 纯函数按名称排序文件夹、按活跃时间排序团队与格式化相对时间', () => {
    const folders = sortFoldersByName([{ name: '运维' }, { name: '前端开发' }, { name: '后端' }]);
    expect(folders.map(f => f.name)).toEqual(['后端', '前端开发', '运维']);

    const sorted = sortTeamsByActivity(sampleGroups.slice(0, 2), new Map([
      ['g-pin-old', 2000],
      ['g-pin-new', 1000],
    ]));
    expect(sorted.map(g => g.id)).toEqual(['g-pin-new', 'g-pin-old']); // created 2026 > 2000ms

    const now = Date.parse('2026-11-21T12:00:00Z');
    expect(formatActiveTime(now - 20_000, now)).toBe('刚刚活跃');
    expect(formatActiveTime(now - 10 * 60_000, now)).toBe('10 分钟前');
    expect(formatActiveTime(now - 2 * 3_600_000, now)).toBe('2 小时前');
    expect(formatActiveTime(now - 26 * 3_600_000, now)).toBe('昨天');

    expect(filterTeamsByQuery(sampleGroups, sampleMembers, '林主持').map(g => g.id)).toEqual(['g-pin-new']);
    expect(recentTeams(sampleGroups, ['g-be', 'missing', 'g-fe', 'g-be']).map(g => g.id)).toEqual(['g-be', 'g-fe']);
  });
});
