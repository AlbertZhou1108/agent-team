import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp, defineComponent, ref } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { createPinia } from 'pinia';
import type { PanelAgentState, PanelTeamView } from '@/shared/api/raw-types';
import { usePanelAgentPage } from './use-panel-agent-page';

/**
 * 私人助手页视图状态 composable 单测：纯搬迁后由本文件钉住确认弹窗动作、
 * 面板运行派生状态、表单校验与流式状态；页面 SSR 冒烟测试继续覆盖模板接线。
 */

const routeState = vi.hoisted(() => ({
  route: { name: 'panel-agent', query: {} as Record<string, unknown> },
  router: { push: vi.fn(), replace: vi.fn() },
}));
const holder = vi.hoisted(() => ({
  panelQuery: {} as {
    data: { value: PanelAgentState | null };
    isPending: { value: boolean };
    error: { value: Error | null };
    refetch: ReturnType<typeof vi.fn>;
  },
  interactionsQuery: {} as { data: { value: unknown[] } },
  api: {
    modelCatalog: vi.fn(async () => ({ hosts: [] })),
    updatePanelAgent: vi.fn(async () => {}),
    createPanelAgent: vi.fn(async () => {}),
    takeoverTeam: vi.fn(async () => {}),
    handbackTeam: vi.fn(async () => {}),
    stopPanel: vi.fn(async () => {}),
    dismissWorkbench: vi.fn(async () => {}),
    resolvePanelRuntime: vi.fn(async () => {}),
    attachmentSettings: vi.fn(async () => ({ maxFileBytes: 1, maxFilesPerMessage: 1 })),
  },
  notifyInteraction: vi.fn(),
}));

vi.mock('vue-router', () => ({
  useRoute: () => routeState.route,
  useRouter: () => routeState.router,
}));
vi.mock('vue-sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/features/queries', async () => {
  const { ref } = await import('vue');
  return {
    usePanelAgentQuery: () => holder.panelQuery,
    usePanelInteractionsQuery: () => holder.interactionsQuery,
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
vi.mock('@/shared/api/client', () => ({ api: holder.api }));
vi.mock('@/features/messages/interaction-notification', () => ({
  notifyInteraction: holder.notifyInteraction,
}));

type Page = ReturnType<typeof usePanelAgentPage>;
let page!: Page;

async function mount() {
  const Comp = defineComponent({
    setup() {
      page = usePanelAgentPage();
      return () => null;
    },
  });
  await renderToString(createSSRApp(Comp).use(createPinia()));
  // 让 immediate watch 里启动的 loadCatalog 等微任务落定。
  await Promise.resolve();
  await Promise.resolve();
}

const agent = {
  id: 'panel-1',
  name: 'Panel Agent',
  host: 'codex',
  model_provider: 'openai',
  model: 'gpt-5',
  reasoning_effort: 'medium',
  workspace: '/tmp/panel',
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

function team(revision = 7): PanelTeamView {
  return {
    id: 'g1',
    name: '团队甲',
    workspace: '/tmp/g1',
    lead: 'm1',
    created: '2026-01-01T00:00:00Z',
    relation: 'main',
    controller: { kind: 'member', id: 'm1', name: '甲', assignment: { revision, state: 'active', original_lead_id: null } },
  } as PanelTeamView;
}

beforeEach(() => {
  routeState.route = { name: 'panel-agent', query: {} };
  routeState.router.push.mockReset();
  routeState.router.replace.mockReset();
  holder.panelQuery = {
    data: ref(null),
    isPending: ref(false),
    error: ref(null),
    refetch: vi.fn(async () => {}),
  };
  holder.interactionsQuery = { data: ref([]) };
  for (const mock of Object.values(holder.api)) mock.mockClear();
  holder.notifyInteraction.mockReset();
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
});

describe('panel agent page state', () => {
  it('asks for confirmation before takeover, then runs it once with the team revision', async () => {
    await mount();
    page.takeover(team());
    expect(page.confirmRequest.value?.title).toContain('团队甲');
    expect(page.confirmRequest.value?.confirmText).toBe('接管');
    await page.runConfirm();
    expect(page.confirmRequest.value).toBeNull();
    expect(holder.api.takeoverTeam).toHaveBeenCalledTimes(1);
    expect(holder.api.takeoverTeam).toHaveBeenCalledWith('g1', 7);
    expect(holder.panelQuery.refetch).toHaveBeenCalled();
    expect(page.panelState.activeTeamId).toBe('g1');
  });

  it('cancelling a hand-back confirmation leaves the panel state untouched', async () => {
    await mount();
    page.handback(team(3));
    expect(page.confirmRequest.value?.confirmText).toBe('交还');
    page.cancelConfirm();
    expect(page.confirmRequest.value).toBeNull();
    expect(holder.api.handbackTeam).not.toHaveBeenCalled();
    expect(page.actionError.value).toBe('');
  });

  it('derives sending/running/streaming state from the private panel session', async () => {
    holder.panelQuery.data.value = panelState({
      sessions: [{ id: 'p1', context: 'private', group_id: null, session: null, updated: '' }],
      running: [{ endpoint: 'p1', groupId: null, turnId: 't1', created: '2026-01-01T00:00:10Z' }],
      streaming: [{ agentId: 'panel-1', sessionId: 'private', turnId: 't1', context: 'private', activeTeamId: null, text: '流式中', created: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }],
    });
    await mount();
    expect(page.sending.value).toBe(true);
    expect(page.runningSince.value).toBe('2026-01-01T00:00:10Z');
    expect(page.privateStreaming.value?.text).toBe('流式中');
    expect(page.contextRunning.value).toBe(true);
  });

  it('fills the edit form from the agent and validates workspace before saving', async () => {
    holder.panelQuery.data.value = panelState();
    await mount();
    expect(page.form.value.model).toBe('gpt-5');
    expect(page.form.value.access).toBe('read-only');
    page.beginEdit();
    expect(page.editing.value).toBe(true);
    page.form.value.access = 'full-access';
    page.form.value.workspace = '';
    await page.saveAgent();
    expect(page.actionError.value).toContain('必须填写私人工作区绝对路径');
    expect(holder.api.updatePanelAgent).not.toHaveBeenCalled();
    page.cancelEdit();
    expect(page.editing.value).toBe(false);
    expect(page.actionError.value).toBe('');
  });

  it('ignores model updates that would not change the agent configuration', async () => {
    holder.panelQuery.data.value = panelState();
    await mount();
    await page.updateAgentModel({
      name: 'Panel Agent',
      host: 'codex',
      model_provider: 'openai',
      model: 'gpt-5',
      reasoning_effort: 'medium',
      workspace: '/tmp/panel',
      access: 'read-only',
    });
    expect(holder.api.updatePanelAgent).not.toHaveBeenCalled();
    await page.updateAgentModel({
      name: 'Panel Agent',
      host: 'codex',
      model_provider: 'openai',
      model: 'gpt-5.1',
      reasoning_effort: 'medium',
      workspace: '/tmp/panel',
      access: 'read-only',
    });
    expect(holder.api.updatePanelAgent).toHaveBeenCalledTimes(1);
  });
});
