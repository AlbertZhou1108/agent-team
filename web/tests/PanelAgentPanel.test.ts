import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import PanelAgentPanel from '@/features/panel-agent/PanelAgentPanel.vue';
import { renderPage, stubSsrBrowser } from './support/ssr';
import type { PanelAgentState } from '@/shared/api/raw-types';

/**
 * 私人助手页 SSR 冒烟：按查询状态渲染 读取中 / 错误 / 首次使用 / 聊天工作区
 * 四个分支，并验证聊天区与侧栏拿到正确 props。
 *
 * 取舍：页面依赖 TanStack Query、Pinia、统一 panel 流单例与多个重子组件。
 * 这里 mock 查询层（queries + 单个 useQuery）与三个子页面组件，只保留页面
 * 壳、分支逻辑与接线；SSR 不执行 onMounted，因此统一流层不会建 EventSource。
 */

const holder = vi.hoisted(() => ({
  panelQuery: {} as {
    data: { value: PanelAgentState | null };
    isPending: { value: boolean };
    error: { value: Error | null };
    refetch: ReturnType<typeof vi.fn>;
  },
  interactionsQuery: {} as { data: { value: unknown[] } },
}));

vi.mock('@/features/queries', async () => {
  const { ref } = await import('vue');
  return {
    usePanelAgentQuery: () => holder.panelQuery,
    usePanelInteractionsQuery: () => holder.interactionsQuery,
    // 页面直接消费的其余查询不参与本条冒烟路径。
    useResourceQuery: () => ({ data: ref(undefined), isPending: ref(false), error: ref(null), refetch: vi.fn() }),
  };
});
vi.mock('@tanstack/vue-query', async () => {
  const { ref } = await import('vue');
  return {
    useQuery: () => ({ data: ref(undefined), isPending: ref(false), error: ref(null), refetch: vi.fn() }),
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  };
});
vi.mock('@/shared/api/client', () => ({
  api: {
    modelCatalog: vi.fn(async () => ({ hosts: [] })),
    stopPanel: vi.fn(async () => {}),
    takeoverTeam: vi.fn(async () => {}),
    handbackTeam: vi.fn(async () => {}),
    dismissWorkbench: vi.fn(async () => {}),
    resolvePanelRuntime: vi.fn(async () => {}),
    updatePanelAgent: vi.fn(async () => {}),
    createPanelAgent: vi.fn(async () => {}),
  },
}));
vi.mock('@/features/messages/interaction-notification', () => ({
  notifyInteraction: vi.fn(),
}));
vi.mock('@/components/ui/tooltip', async () => {
  const { defineComponent } = await import('vue');
  return {
    TooltipProvider: defineComponent({
      setup: (_props, { slots }) => () => slots.default?.(),
    }),
  };
});
vi.mock('@/features/panel-agent/PanelAgentChat.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return {
    default: defineComponent({
      props: ['draft', 'activeTeamId', 'form', 'agent', 'bootId', 'messages', 'requests', 'streaming', 'teams', 'interactions', 'sending', 'contextRunning', 'runningSince', 'stopping', 'actionError', 'hosts', 'catalogLoading', 'modelSaving', 'attachments'],
      emits: ['update:draft', 'update:activeTeamId', 'update:form', 'attach', 'remove-attachment', 'send', 'stop', 'edit', 'update-model'],
      setup: (props) => () =>
        h('section', {
          'data-testid': 'panel-chat',
          'data-agent': String(props.agent?.name ?? ''),
          'data-messages': String((props.messages as unknown[] | undefined)?.length ?? 0),
          'data-streaming': String(Boolean(props.streaming)),
          'data-interactions': String((props.interactions as unknown[] | undefined)?.length ?? 0),
        }),
    }),
  };
});
vi.mock('@/features/panel-agent/PanelAgentSidebar.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return {
    default: defineComponent({
      props: ['modelValue', 'teams', 'messages', 'requests', 'notifications', 'clearingNotifications', 'pendingInteractions', 'unknown'],
      emits: ['update:modelValue', 'open-team', 'takeover', 'handback', 'resolve-runtime', 'clear-notifications'],
      setup: (props) => () =>
        h('aside', {
          'data-testid': 'panel-sidebar',
          'data-teams': String((props.teams as unknown[] | undefined)?.length ?? 0),
        }),
    }),
  };
});
vi.mock('@/features/panel-agent/FirstUseSetup.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ setup: () => () => h('section', { 'data-testid': 'first-use-setup' }) }) };
});
vi.mock('@/features/panel-agent/PanelAgentSetup.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ setup: () => () => h('section', { 'data-testid': 'panel-agent-setup' }) }) };
});

const agent = {
  id: 'panel-1',
  name: 'Panel Agent',
  host: 'codex',
  model_provider: null,
  model: null,
  reasoning_effort: null,
  workspace: null,
  access: 'read-only',
  created: '2026-01-01T00:00:00Z',
  updated: '2026-01-01T00:00:00Z',
} as const;

function panelState(overrides: Partial<PanelAgentState> = {}): PanelAgentState {
  return {
    agent,
    bootId: 'boot-1',
    sessions: [],
    teams: [],
    conversation: [],
    requests: [],
    notifications: [],
    streaming: [],
    running: [],
    unknown: [],
    teamPendingInteractions: {},
    ...overrides,
  } as PanelAgentState;
}

beforeEach(() => {
  stubSsrBrowser();
  holder.panelQuery = {
    data: ref(null),
    isPending: ref(true),
    error: ref(null),
    refetch: vi.fn(),
  };
  holder.interactionsQuery = { data: ref([]) };
});

describe('panel agent page SSR smoke', () => {
  it('renders the loading card while the panel state is pending', async () => {
    const { html } = await renderPage(PanelAgentPanel, '/agent');
    expect(html).toContain('panel-agent-page');
    expect(html).toContain('正在读取 Panel Agent…');
    expect(html).toContain('animate-spin');
    expect(html).not.toContain('data-testid="panel-chat"');
  });

  it('renders the recoverable error banner with a retry action', async () => {
    holder.panelQuery.isPending.value = false;
    holder.panelQuery.error.value = new Error('后端不可用');
    const { html } = await renderPage(PanelAgentPanel, '/agent');
    expect(html).toContain('role="alert"');
    expect(html).toContain('后端不可用');
    expect(html).toContain('重试');
    expect(html).not.toContain('data-testid="panel-chat"');
  });

  it('renders first-use setup when no agent is configured', async () => {
    holder.panelQuery.isPending.value = false;
    holder.panelQuery.data.value = null;
    const { html } = await renderPage(PanelAgentPanel, '/agent');
    expect(html).toContain('data-testid="first-use-setup"');
    expect(html).not.toContain('data-testid="panel-chat"');
    expect(html).not.toContain('role="alert"');
  });

  it('renders the chat workspace and sidebar with agent, conversation and streaming props', async () => {
    holder.panelQuery.isPending.value = false;
    holder.panelQuery.data.value = panelState({
      conversation: [{ seq: 1, id: 'pm1', panel_agent_id: 'panel-1', context: 'private', role: 'assistant', text: '你好', active_team_id: null, created: '2026-01-01T00:00:00Z' }],
      teams: [
        { id: 'g1', name: '团队甲', workspace: '/tmp/g1', lead: 'm1', created: '2026-01-01T00:00:00Z', relation: 'main', controller: { kind: 'member', id: 'm1', name: '甲' } },
      ],
      streaming: [{ agentId: 'panel-1', sessionId: 'private', turnId: 't1', context: 'private', activeTeamId: null, text: '流式中', created: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }],
    });
    holder.interactionsQuery.data.value = [];
    const { html } = await renderPage(PanelAgentPanel, '/agent');
    expect(html).toContain('agent-workspace');
    expect(html).toContain('data-testid="panel-chat"');
    expect(html).toMatch(/data-testid="panel-chat"[^>]*data-agent="Panel Agent"/);
    expect(html).toMatch(/data-testid="panel-chat"[^>]*data-messages="1"/);
    expect(html).toMatch(/data-testid="panel-chat"[^>]*data-streaming="true"/);
    expect(html).toContain('data-testid="panel-sidebar"');
    expect(html).toMatch(/data-testid="panel-sidebar"[^>]*data-teams="1"/);
    expect(html).not.toContain('role="alert"');
  });
});
