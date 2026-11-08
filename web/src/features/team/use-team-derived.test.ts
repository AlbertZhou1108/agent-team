import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import type {
  Group,
  HistoryRow,
  Member,
  MessageRow,
  PanelTeamView,
  SessionEndpoint,
  TurnSummary,
} from '@/shared/api/raw-types';
import type { TeamQueries, TeamQueriesOptions } from './use-team-queries';
import { useTeamDerived } from './use-team-derived';
import { useTeamDirectiveStore } from '@/stores/team-directives';

const routeState = vi.hoisted(() => ({
  route: { name: 'group' as string | undefined, query: {} as Record<string, unknown> },
}));

vi.mock('vue-router', () => ({
  useRoute: () => routeState.route,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const groups: Group[] = [
  { id: 'g1', name: '团队甲', workspace: '/tmp/g1', lead: 'm1', created: '2026-01-01T00:00:00Z' },
  { id: 'g2', name: '归档团队', workspace: '/tmp/g2', lead: null, created: '2026-01-01T00:00:00Z', state: 'archived' },
];
const members = [
  { id: 'm1', group_id: 'g1', name: '甲', host: 'codex', role: 'lead', removed: false },
  { id: 'm2', group_id: 'g1', name: '乙', host: 'claude', role: 'member', removed: false },
  { id: 'm3', group_id: 'g1', name: '已移除', host: 'codex', role: 'member', removed: true },
  { id: 'mx', group_id: 'g2', name: '他队', host: 'codex', role: 'lead', removed: false },
] as unknown as Member[];
const endpoints: SessionEndpoint[] = [
  { id: 'e1', group_id: 'g1', member_id: 'm1', context: 'pair', peer: 'm2', session: null },
  { id: 'e2', group_id: 'g1', member_id: 'm1', context: 'coordination', peer: null, session: null },
  { id: 'e3', group_id: 'g1', member_id: 'm2', context: 'profile', peer: null, session: null },
];
const row = (seq: number, id: string, sender = 'm1', recipient = 'm2'): MessageRow => ({
  seq,
  id,
  group_id: 'g1',
  sender,
  recipient,
  kind: 'send',
  text: `消息 ${id}`,
  reply_to: null,
  created: '2026-01-01T00:00:00Z',
});

function makeQueries() {
  const queryState = (data: unknown) => ({
    data: ref<unknown>(data),
    isPending: ref(false),
    error: ref<unknown>(null),
    refetch: vi.fn(),
  });
  return {
    allGroups: ref(groups),
    members: ref(members),
    actors: ref([]),
    endpoints: ref(endpoints),
    sessionBindings: ref([{ endpoint_id: 'e1', session_key: 'k', session: 's', updated: '' }]),
    runningEndpoints: ref([]),
    overview: ref({
      groups,
      members,
      actors: [],
      panelAgent: null,
      panelTeams: [] as PanelTeamView[],
      modelPolicy: undefined,
      modelPolicyDefaults: undefined,
    }),
    snapshot: ref({ endpoints, agentTasks: [] }),
    navigationState: { data: ref<unknown>({}), isPending: ref(false), error: ref<unknown>(null), refetch: vi.fn() },
    workspaceState: { data: ref<unknown>({}), isPending: ref(false), error: ref<unknown>(null), refetch: vi.fn() },
    modelPolicyDefaults: ref(undefined),
    homeRunningByGroup: ref({}),
    refreshResources: vi.fn(),
    archivedQuery: { data: ref([groups[1]]) },
    sessionsQuery: { error: ref<unknown>(null), refetch: vi.fn() },
    tasksQuery: { error: ref<unknown>(null), refetch: vi.fn() },
    sessionQuery: { error: ref<unknown>(null), refetch: vi.fn() },
    runtimeQuery: { data: ref<unknown[]>([]) },
    detailQuery: { error: ref<unknown>(null) },
    panelAgentQuery: queryState(undefined),
    unreadQuery: queryState(undefined),
    messagesQuery: {
      rows: ref([row(1, 'a'), row(2, 'b')]),
      isPending: ref(false),
      isFetchingNextPage: ref(false),
      hasNextPage: ref(false),
      fetchNextPage: vi.fn(),
    },
    turnsQuery: {
      turns: ref<TurnSummary[]>([]),
      unaffiliated: ref<HistoryRow[]>([]),
      hasNextPage: ref(false),
      isFetchingNextPage: ref(false),
      isPending: ref(false),
      error: ref<unknown>(null),
      fetchNextPage: vi.fn(),
    },
    directivesQuery: {},
    interactionsQuery: { data: ref(undefined) },
  };
}

type FakeQueries = ReturnType<typeof makeQueries>;

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

function derivedOf(options: FakeOptions, queries: FakeQueries = makeQueries()) {
  return useTeamDerived(
    options as unknown as TeamQueriesOptions,
    queries as unknown as TeamQueries,
  );
}

beforeEach(() => {
  routeState.route = { name: 'group', query: {} };
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => {},
  });
  setActivePinia(createPinia());
});

describe('team derived projections', () => {
  it('filters archived teams and derives current members, endpoints, and the controller fallback', () => {
    const derived = derivedOf(makeOptions());
    expect(derived.groups.value.map((team) => team.id)).toEqual(['g1']);
    expect(derived.archivedGroups.value.map((team) => team.id)).toEqual(['g2']);
    expect(derived.group.value?.name).toBe('团队甲');
    expect(derived.currentMembers.value.map((member) => member.name)).toEqual(['甲', '乙']);
    // profile 端点不进团队右栏。
    expect(derived.currentEndpoints.value.map((endpoint) => endpoint.id)).toEqual(['e1', 'e2']);
    expect(derived.currentSessionBindings.value.map((binding) => binding.endpoint_id)).toEqual(['e1']);
    // 没有 Panel 主控时回落到 team.lead 成员。
    expect(derived.currentControllerId.value).toBe('m1');
    expect(derived.currentController.value).toEqual({ id: 'm1', name: '甲', kind: 'member' });
    expect(derived.pausedMemberIds.value.size).toBe(0);
    expect(derived.sidebarGroupId.value).toBe('g1');
  });

  it('uses an external principal as the team controller without a Panel Agent', () => {
    const queries = makeQueries();
    queries.overview.value.panelTeams = [{
      ...groups[0],
      relation: null,
      controller: { kind: 'external_agent', id: 'principal-1', name: '外部主控' },
    }];
    const derived = derivedOf(makeOptions(), queries);
    expect(derived.currentControllerId.value).toBe('principal-1');
    expect(derived.currentController.value).toEqual({
      kind: 'external_agent',
      id: 'principal-1',
      name: '外部主控',
    });
  });

  it('switches to the Panel route projection for conversation, receipts and sidebar', () => {
    routeState.route = { name: 'panel-agent', query: {} };
    const queries = makeQueries();
    queries.panelAgentQuery.data.value = {
      conversation: [{ seq: 3, role: 'assistant', active_team_id: 'g1', text: 'hi' }],
      requests: [{ receipts: [{ id: 'r1' }] }],
    };
    const derived = derivedOf(makeOptions(), queries);
    expect(derived.isPanelAgentRoute.value).toBe(true);
    expect(derived.sidebarGroupId.value).toBeUndefined();
    expect(derived.panelMessages.value[0]?.active_team_id).toBeNull();
    expect(derived.receiptRequests.value).toHaveLength(1);
  });

  it('merges accepted directive rows into sorted message views and reuses unchanged views', () => {
    const options = makeOptions();
    const queries = makeQueries();
    const directiveState = useTeamDirectiveStore();
    const derived = derivedOf(options, queries);
    directiveState.acceptedMessages['g1'] = [row(3, 'c', 'user', 'm1')];
    expect(derived.messageViews.value.map((view) => view.id)).toEqual(['a', 'b', 'c']);
    const before = derived.messageViews.value;
    // content 未变时重新计算仍复用同一数组（避免轮询触发消息重渲染）。
    queries.messagesQuery.rows.value = [row(1, 'a'), row(2, 'b')];
    expect(derived.messageViews.value).toBe(before);
    // 新增行后产生新数组。
    directiveState.acceptedMessages['g1'] = [row(3, 'c', 'user', 'm1'), row(4, 'd')];
    expect(derived.messageViews.value.map((view) => view.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('selects the active endpoint and only applies the member filter for 统一调度 views', () => {
    const options = makeOptions();
    options.selectedSessionId.value = 'e1';
    const derived = derivedOf(options);
    expect(derived.selectedEndpoint.value?.id).toBe('e1');
    expect(derived.selectedPair.value).toBe('m1:m2');
    // 与成员的 pair 会话：视图不做成员过滤（保留整段 pair 记录）。
    expect(derived.messageViews.value).toHaveLength(2);
    options.selectedSessionId.value = 'e2';
    expect(derived.selectedPair.value).toBe('');
    expect(derived.messageViews.value).toHaveLength(2);
  });

  it('switches inspector pagination/error and context retry by active tab and panel', async () => {
    const queries = makeQueries();
    const options = makeOptions();
    queries.turnsQuery.hasNextPage.value = true;
    queries.turnsQuery.isFetchingNextPage.value = true;
    const turnsError = new Error('turns failed');
    queries.turnsQuery.error.value = turnsError;
    const derived = derivedOf(options, queries);
    // 用量页自带数据源,不消费回合分页。
    options.activeTab.value = 'usage';
    expect(derived.inspectorHasNextPage.value).toBe(false);
    expect(derived.inspectorFetchingNextPage.value).toBe(false);
    expect(derived.inspectorError.value).toBeUndefined();
    options.activeTab.value = 'trace';
    expect(derived.inspectorHasNextPage.value).toBe(true);
    expect(derived.inspectorFetchingNextPage.value).toBe(true);
    expect(derived.inspectorError.value).toBe(turnsError);
    await derived.loadInspectorMore();
    expect(queries.turnsQuery.fetchNextPage).toHaveBeenCalledTimes(1);

    const sessionsError = new Error('sessions failed');
    queries.sessionsQuery.error.value = sessionsError;
    options.contextPanel.value = 'sessions';
    expect(derived.contextError.value).toBe(sessionsError);
    derived.retryContext();
    expect(queries.sessionsQuery.refetch).toHaveBeenCalledTimes(1);
    options.contextPanel.value = 'details';
    derived.retryContext();
    expect(queries.sessionQuery.refetch).toHaveBeenCalledTimes(1);
    queries.tasksQuery.error.value = new Error('tasks failed');
    options.contextPanel.value = 'collaboration';
    derived.retryContext();
    expect(queries.tasksQuery.refetch).toHaveBeenCalledTimes(1);
  });

  it('exposes turn summaries and unaffiliated events only while the trace tab is visible', () => {
    const options = makeOptions();
    const queries = makeQueries();
    const summary = { id: 't1', state: 'completed', created: '2026-01-01T00:00:00Z', ended: null, ordinal: 1, eventCount: 2, firstSeq: 1, lastSeq: 2 };
    queries.turnsQuery.turns.value = [summary];
    queries.turnsQuery.unaffiliated.value = [{ seq: 9, conversation_id: 'e1', event: '{}', created: '', turn_id: null }];
    const derived = derivedOf(options, queries);
    expect(derived.turnSummaries.value).toEqual([]);
    expect(derived.unaffiliatedEvents.value).toEqual([]);
    options.detailsVisible.value = true;
    options.activeTab.value = 'trace';
    expect(derived.turnSummaries.value).toEqual([summary]);
    expect(derived.unaffiliatedEvents.value).toHaveLength(1);
    options.activeTab.value = 'usage';
    expect(derived.turnSummaries.value).toEqual([]);
    expect(derived.unaffiliatedEvents.value).toEqual([]);
  });
});
