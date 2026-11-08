import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import type { Group } from '@/shared/api/raw-types';
import GroupWorkspacePage from './GroupWorkspacePage.vue';
import { renderPage, stubSsrBrowser } from '@/test/ssr';

/**
 * 团队页 SSR 冒烟：页面组合根能挂载，并按路由/资源状态渲染关键分支
 * （团队工作区 / 读取中 / 首页 / Panel Agent / 笔记 / 设置）。
 *
 * 取舍：整页依赖 queries、路由、Pinia、右栏 Inspector、消息流等大量子组件。
 * 这里 mock 页面自己的数据组合式函数（useTeamResources/useTeamStream/useReadSync）
 * 与重子组件，只保留页面壳、分支逻辑、aria 结构与插槽接线——这正是
 * "页面能挂载 + 关键区域存在" 的目标，而不是重测子组件。
 */

const holder = vi.hoisted(() => ({
  resources: {} as Record<string, unknown>,
}));

vi.mock('@/features/team/use-team-resources', () => ({
  useTeamResources: () => holder.resources,
}));
vi.mock('@/features/team/use-team-stream', async () => {
  const { ref } = await import('vue');
  return { useTeamStream: () => ({ streaming: ref({}), activeStreams: ref([]) }) };
});
vi.mock('@/features/messages/read-marker', async () => ({
  useReadMarker: () => async () => {},
  provideReachBottom: () => {},
  injectReachBottom: () => null,
  canMarkRead: () => false,
}));
vi.mock('@/features/productivity/use-unread-index', async () => {
  const { ref } = await import('vue');
  return {
    useUnreadIndex: () => ({ panelTotal: ref(2), panelByTeam: ref(new Map()) }),
  };
});

vi.mock('@/app/layouts/GroupSidebar.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return {
    default: defineComponent({
      props: ['groups', 'currentGroupId', 'homeActive', 'toolEntries', 'agentActive', 'agentUnreadCount', 'settingsActive'],
      setup: (props) => () =>
        h('aside', {
          'data-testid': 'group-sidebar',
          'data-groups': String((props.groups as unknown[] | undefined)?.length ?? 0),
          'data-home-active': String(props.homeActive),
          'data-agent-active': String(props.agentActive),
          'data-settings-active': String(props.settingsActive),
          'data-unread': String(props.agentUnreadCount),
        }),
    }),
  };
});
vi.mock('@/features/settings/SettingsDialog.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return {
    default: defineComponent({
      props: { open: Boolean, embedded: Boolean, policy: Object, defaults: Object, archivedTeams: Array },
      setup: (props) => () =>
        h('section', {
          'data-testid': 'settings-dialog',
          'data-open': String(props.open),
          'data-embedded': props.embedded ? 'on' : 'off',
          'data-archived': String(props.archivedTeams?.length ?? 0),
        }),
    }),
  };
});
vi.mock('@/features/groups/CreateTeam.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ setup: () => () => h('section', { 'data-testid': 'create-team' }) }) };
});
vi.mock('@/features/groups/TeamHome.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return {
    default: defineComponent({
      props: ['groups', 'members', 'runningByGroup', 'runningEndpoints', 'loading', 'error'],
      setup: (props) => () =>
        h('section', {
          'data-testid': 'team-home',
          'data-groups': String((props.groups as unknown[] | undefined)?.length ?? 0),
          'data-loading': String(props.loading),
          'data-error': String(props.error ?? ''),
        }),
    }),
  };
});
vi.mock('@/features/panel-agent/PanelAgentPanel.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ setup: () => () => h('section', { 'data-testid': 'panel-agent-page' }) }) };
});
vi.mock('@/features/messages/ConversationWorkspace.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return {
    default: defineComponent({
      props: ['heading', 'description', 'messages', 'streamSource', 'directives', 'interactions', 'title', 'selectedPair', 'hosts', 'groupNames', 'resetKey', 'loading', 'hasNextPage', 'fetchingNextPage', 'error', 'retryable'],
      setup: (props, { slots }) => () =>
        h('section', {
          'data-testid': 'conversation-workspace',
          'data-heading': String(props.heading),
          'data-loading': String(props.loading),
          'data-messages': String((props.messages as unknown[] | undefined)?.length ?? 0),
        }, [
          slots['heading-meta']?.(),
          slots.actions?.(),
          slots.status?.(),
          slots.composer?.(),
        ]),
    }),
  };
});
vi.mock('@/features/messages/TeamDirectiveComposer.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return {
    default: defineComponent({
      props: ['groupId', 'controllerId', 'archived', 'receipts'],
      setup: (props) => () =>
        h('div', {
          'data-testid': 'team-directive-composer',
          'data-group-id': String(props.groupId),
          'data-controller-id': String(props.controllerId),
        }),
    }),
  };
});
vi.mock('@/features/team/TeamContextPanel.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return {
    default: defineComponent({
      props: ['groupId', 'panel', 'visible', 'selectedSessionId', 'activeTab', 'historyRows', 'observations'],
      setup: (props) => () =>
        h('aside', {
          'data-testid': 'team-context-panel',
          'data-group-id': String(props.groupId),
          'data-panel': String(props.panel),
          'data-visible': String(props.visible),
        }),
    }),
  };
});

const group: Group = {
  id: 'g1',
  name: '团队甲',
  workspace: '/tmp/g1',
  lead: 'm1',
  created: '2026-01-01T00:00:00Z',
};
const members = [
  { id: 'm1', group_id: 'g1', name: '甲', host: 'codex', role: 'lead', removed: null },
  { id: 'm2', group_id: 'g1', name: '乙', host: 'claude', role: 'member', removed: null },
];

function makeResources(overrides: Record<string, unknown> = {}) {
  const base = {
    allGroups: ref([group]),
    groups: ref([group]),
    archivedGroups: ref([]),
    group: ref<Group | undefined>(group),
    members: ref(members),
    actors: ref([]),
    overview: ref({ panelAgent: null, panelTeams: [] }),
    agentTasksView: ref({ currentPlan: null, historicalPlans: [], memberTasks: [], cancelledSteps: [] }),
    navigationState: { data: ref({}), isPending: ref(false), error: ref(null), refetch: vi.fn() },
    workspaceState: { data: ref({}), isPending: ref(false), error: ref(null), refetch: vi.fn() },
    refreshResources: vi.fn(),
    isPanelAgentRoute: ref(false),
    isSettingsRoute: ref(false),
    isNotesRoute: ref(false),
    sidebarGroupId: ref('g1'),
    currentModelPolicy: ref(undefined),
    modelPolicyDefaults: ref(undefined),
    homeRunningByGroup: ref({}),
    runningEndpoints: ref([]),
    currentControllerId: ref('m1'),
    currentController: ref({ id: 'm1', name: '甲', kind: 'panel_agent' }),
    pausedMemberIds: ref(new Set<string>()),
    currentMembers: ref(members),
    currentEndpoints: ref([]),
    currentSessionBindings: ref([]),
    selectedEndpoint: ref(undefined),
    selectedPair: ref(''),
    selectedEndpointIsManagerPair: ref(false),
    conversationTitle: ref('全部群消息'),
    endpointHosts: ref({}),
    runningMemberIds: ref(new Set<string>()),
    agentUnreadCount: ref(2),
    panelMessages: ref([]),
    receiptRequests: ref([]),
    messagesQuery: {
      rows: ref([]),
      isPending: ref(false),
      isFetchingNextPage: ref(false),
      hasNextPage: ref(false),
      isError: ref(false),
      refetch: vi.fn(),
      fetchNextPage: vi.fn(),
    },
    directivesQuery: { data: ref([]) },
    interactionsQuery: { data: ref([]) },
    messageViews: ref([]),
    historyQuery: {
      rows: ref([]),
      isPending: ref(false),
      hasNextPage: ref(false),
      isFetchingNextPage: ref(false),
      fetchNextPage: vi.fn(),
    },
    modelsQuery: {
      observations: ref([]),
      isPending: ref(false),
      hasNextPage: ref(false),
      isFetchingNextPage: ref(false),
      fetchNextPage: vi.fn(),
    },
    turns: ref([]),
    selectedModelState: ref(null),
    inspectorHasNextPage: ref(false),
    inspectorFetchingNextPage: ref(false),
    inspectorError: ref(null),
    contextError: ref(null),
    retryContext: vi.fn(),
    loadInspectorMore: vi.fn(),
    notesTool: { name: '随心记', mounts: [] },
    navToolEntries: ref([]),
    notesPageComponent: defineComponent(() => () => h('div', { 'data-testid': 'notes-page' })),
    notesEnabled: ref(true),
    modelPolicySaved: vi.fn(),
    restoreArchivedTeam: vi.fn(),
  };
  return { ...base, ...overrides };
}

function render(path: string, overrides: Record<string, unknown> = {}) {
  holder.resources = makeResources(overrides);
  return renderPage(GroupWorkspacePage, path);
}

beforeEach(() => {
  stubSsrBrowser();
  holder.resources = makeResources();
});

describe('group workspace page SSR smoke', () => {
  it('mounts the team workspace shell with sidebar, conversation, context panel and resize handles', async () => {
    const { html } = await render('/groups/g1');
    expect(html).toContain('app-shell');
    expect(html).toContain('workspace-shell');
    expect(html).toContain('data-testid="group-sidebar"');
    expect(html).toMatch(/data-testid="group-sidebar"[^>]*data-home-active="false"[^>]*data-agent-active="false"/);
    expect(html).toContain('data-testid="conversation-workspace"');
    expect(html).toContain('data-heading="团队甲"');
    expect(html).toContain('data-testid="team-directive-composer"');
    expect(html).toContain('data-group-id="g1"');
    expect(html).toContain('data-testid="team-context-panel"');
    expect(html).toContain('data-panel="collaboration"');
    expect(html).toContain('aria-label="调整左侧栏宽度"');
    expect(html).toContain('aria-label="调整右侧栏宽度"');
    // 右侧栏未弹出时没有移动端遮罩。
    expect(html).not.toContain('inspector-backdrop');
  });

  it('renders the heading meta and controller badge from derived resources', async () => {
    const { html } = await render('/groups/g1');
    expect(html).toContain('Panel Agent 主控');
    expect(html).toContain('2 名成员');
    expect(html).not.toContain('正在读取团队…');
  });

  it('shows the loading card when a team id is present but the team is not resolved', async () => {
    const { html } = await render('/groups/g1', { group: ref(undefined) });
    expect(html).toContain('正在读取团队…');
    expect(html).not.toContain('workspace-shell');
  });

  it('renders the home directory (TeamHome) when no team is selected', async () => {
    const { html } = await render('/groups', { group: ref(undefined), sidebarGroupId: ref(undefined) });
    expect(html).toContain('data-testid="team-home"');
    expect(html).toContain('data-groups="1"');
    expect(html).toContain('data-loading="false"');
    expect(html).toMatch(/data-testid="group-sidebar"[^>]*data-home-active="true"/);
    expect(html).not.toContain('workspace-shell');
  });

  it('routes the panel-agent page to PanelAgentPanel with the agent sidebar active', async () => {
    const { html } = await render('/agent', {
      group: ref(undefined),
      isPanelAgentRoute: ref(true),
    });
    expect(html).toContain('data-testid="panel-agent-page"');
    expect(html).toMatch(/data-testid="group-sidebar"[^>]*data-agent-active="true"/);
    expect(html).toMatch(/data-testid="group-sidebar"[^>]*data-unread="2"/);
    expect(html).not.toContain('data-testid="team-home"');
  });

  it('renders the disabled-tool placeholder for notes when the tool is off', async () => {
    const { html } = await render('/notes', {
      isNotesRoute: ref(true),
      notesEnabled: ref(false),
    });
    expect(html).toContain('「随心记」已在设置中禁用。');
    expect(html).not.toContain('data-testid="notes-page"');
  });

  it('renders the embedded settings dialog on the settings route', async () => {
    const { html } = await render('/settings', { isSettingsRoute: ref(true) });
    expect(html).toContain('data-testid="settings-dialog"');
    expect(html).toContain('data-embedded="on"');
    expect(html).toMatch(/data-testid="group-sidebar"[^>]*data-settings-active="true"/);
  });
});
