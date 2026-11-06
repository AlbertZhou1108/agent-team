import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import type { TeamQueries, TeamQueriesOptions } from './use-team-queries';
import type { TeamDerived } from './use-team-derived';
import { useTeamNotifications } from './use-team-notifications';
import { ApiError } from '@/shared/api/client';
import { useConnectionStore } from '@/stores/connection';

const routeState = vi.hoisted(() => ({
  route: { name: 'group' as string | undefined, query: {} as Record<string, unknown> },
  router: { push: vi.fn(), replace: vi.fn() },
}));
const notify = vi.hoisted(() => ({ notifyInteraction: vi.fn() }));
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const apiMock = vi.hoisted(() => ({
  sessionTarget: vi.fn(async (_groupId: string, _memberId: string, _context: string) => ({ id: 'session-1' })),
  restoreTeam: vi.fn(async (_teamId: string) => {}),
}));

vi.mock('vue-router', () => ({
  useRoute: () => routeState.route,
  useRouter: () => routeState.router,
}));
vi.mock('vue-sonner', () => ({ toast: toastMock }));
vi.mock('@/features/messages/interaction-notification', () => notify);
vi.mock('@/shared/api/client', () => {
  class MockApiError extends Error {
    readonly status: number;
    constructor(status: number, message = 'error') {
      super(message);
      this.status = status;
    }
  }
  return { ApiError: MockApiError, api: apiMock };
});

function makeQueries() {
  return {
    navigationState: {
      data: ref<unknown>(undefined),
      isPending: ref(false),
      error: ref<unknown>(null),
      refetch: vi.fn(),
    },
    workspaceState: {
      data: ref<unknown>(undefined),
      isPending: ref(false),
      error: ref<unknown>(null),
      refetch: vi.fn(),
    },
    overview: ref<unknown>({ panelTeams: [] }),
    members: ref<unknown[]>([]),
    interactionsQuery: { data: ref<unknown>(undefined) },
    messagesQuery: {
      rows: ref<unknown[]>([]),
      isPending: ref(false),
      isFetchingNextPage: ref(false),
      hasNextPage: ref(false),
      fetchNextPage: vi.fn(),
    },
    detailQuery: { error: ref<unknown>(null) },
    sessionQuery: { error: ref<unknown>(null) },
    refreshResources: vi.fn(async () => {}),
  };
}

type FakeQueries = ReturnType<typeof makeQueries>;

function makeDerived(groups: Array<{ id: string }> = []) {
  return { groups: ref(groups) } as unknown as TeamDerived;
}

function makeOptions() {
  return {
    groupId: ref('g1'),
    selectedSessionId: ref(''),
    activeTab: ref('trace'),
    contextPanel: ref('collaboration'),
    contextVisible: ref(true),
    detailsVisible: ref(false),
  };
}

type FakeOptions = ReturnType<typeof makeOptions>;

function notificationsOf(
  options: FakeOptions = makeOptions(),
  queries: FakeQueries = makeQueries(),
  derived = makeDerived(),
) {
  return useTeamNotifications(
    options as unknown as TeamQueriesOptions,
    queries as unknown as TeamQueries,
    derived,
  );
}

beforeEach(() => {
  routeState.route = { name: 'group', query: {} };
  routeState.router.push.mockReset();
  routeState.router.replace.mockReset();
  notify.notifyInteraction.mockReset();
  toastMock.success.mockReset();
  toastMock.error.mockReset();
  apiMock.sessionTarget.mockClear();
  apiMock.restoreTeam.mockClear();
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
  setActivePinia(createPinia());
});

describe('team notifications and recovery side effects', () => {
  it('redirects a removed team once navigation is ready', () => {
    const queries = makeQueries();
    queries.overview.value = { panelTeams: [] };
    const options = makeOptions();
    options.groupId.value = 'missing';
    notificationsOf(options, queries, makeDerived([{ id: 'g1' }]));
    expect(routeState.router.replace).toHaveBeenCalledWith({ name: 'group' });
  });

  it('redirects home on 410 detail and strips session/tab on 404 session', async () => {
    const queries = makeQueries();
    notificationsOf(makeOptions(), queries, makeDerived([{ id: 'g1' }]));
    routeState.router.replace.mockClear();
    queries.detailQuery.error.value = new ApiError(410, 'gone');
    await nextTick();
    expect(routeState.router.replace).toHaveBeenCalledWith({ name: 'group' });
    routeState.router.replace.mockClear();
    routeState.route.query = { session: 'e1', tab: 'trace', panel: 'details' };
    queries.sessionQuery.error.value = new ApiError(404, 'missing');
    await nextTick();
    expect(routeState.router.replace).toHaveBeenCalledWith({
      query: { panel: 'details' },
    });
    // 其它状态码不触发纠偏。
    routeState.router.replace.mockClear();
    queries.sessionQuery.error.value = new ApiError(500, 'boom');
    await nextTick();
    expect(routeState.router.replace).not.toHaveBeenCalled();
  });

  it('reports connection state from navigation/workspace resource failures', async () => {
    const queries = makeQueries();
    const connection = useConnectionStore();
    notificationsOf(makeOptions(), queries, makeDerived());
    expect(connection.status).toBe('connecting');
    queries.navigationState.data.value = { groups: [] };
    queries.workspaceState.data.value = { endpoints: [], agentTasks: [] };
    await nextTick();
    expect(connection.status).toBe('online');
    queries.navigationState.error.value = new Error('导航失败');
    await nextTick();
    expect(connection.status).toBe('error');
    expect(connection.error).toBe('导航失败');
  });

  it('notifies only newly pending interactions and routes to the request target', async () => {
    const queries = makeQueries();
    notificationsOf(makeOptions(), queries, makeDerived());
    // 首次快照只做基线，不打扰用户。
    queries.interactionsQuery.data.value = [
      { id: 'i1', state: 'pending', member_id: 'm1', payload: { text: '确认部署？' } },
    ];
    await nextTick();
    expect(notify.notifyInteraction).not.toHaveBeenCalled();
    queries.interactionsQuery.data.value = [
      { id: 'i1', state: 'pending', member_id: 'm1', payload: { text: '确认部署？' } },
      { id: 'i2', state: 'pending', member_id: 'm2', payload: { text: '确认回滚？' } },
    ];
    await nextTick();
    expect(notify.notifyInteraction).toHaveBeenCalledTimes(1);
    const [name, text, onClick] = notify.notifyInteraction.mock.calls[0] as unknown as [
      string,
      string,
      () => Promise<unknown>,
    ];
    expect(name).toBe('m2');
    expect(text).toBe('确认回滚？');
    await onClick();
    expect(apiMock.sessionTarget).toHaveBeenCalledWith('g1', 'm2', 'pair:user');
    expect(routeState.router.push).toHaveBeenCalledWith({
      name: 'group',
      params: { groupId: 'g1' },
      query: { session: 'session-1', interaction: 'i2' },
    });
  });

  it('refreshes workspace resources for policy saves and archive restore actions', async () => {
    const queries = makeQueries();
    const actions = notificationsOf(makeOptions(), queries, makeDerived());
    await actions.modelPolicySaved();
    expect(queries.refreshResources).toHaveBeenCalledTimes(1);
    expect(toastMock.success).toHaveBeenCalledTimes(1);
    await actions.restoreArchivedTeam({ id: 'g2', name: '归档团队' } as never);
    expect(apiMock.restoreTeam).toHaveBeenCalledWith('g2');
    expect(queries.refreshResources).toHaveBeenCalledTimes(2);
    expect(toastMock.success).toHaveBeenCalledTimes(2);
    apiMock.restoreTeam.mockRejectedValueOnce(new Error('boom'));
    await actions.restoreArchivedTeam({ id: 'g3', name: '失败团队' } as never);
    expect(toastMock.error).toHaveBeenCalledTimes(1);
  });
});
