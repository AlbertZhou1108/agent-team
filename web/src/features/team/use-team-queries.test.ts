import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

/**
 * 查询编排层单测：钉住拆分时的「查询 key / 轮询间隔 / enabled 语义」不变，
 * 以及查询结果到基础数据投影（endpoints 合并、overview 门控、快照、导航状态）。
 */

const routeState = vi.hoisted(() => ({
  route: { name: 'group' as string | undefined, query: {} as Record<string, unknown> },
}));
const q = vi.hoisted(() => ({
  fixtures: {} as Record<string, unknown>,
  resourceCalls: [] as Array<{ key: string; interval: unknown; enabled: unknown }>,
  client: { invalidateQueries: vi.fn() },
  messagesQuery: {} as Record<string, unknown>,
  panelAgentQuery: {} as Record<string, unknown>,
  directivesQuery: {} as Record<string, unknown>,
  interactionsQuery: {} as Record<string, unknown>,
  turnsQuery: {} as Record<string, unknown>,
}));

vi.mock('vue-router', () => ({ useRoute: () => routeState.route }));
vi.mock('@tanstack/vue-query', () => ({ useQueryClient: () => q.client }));
vi.mock('@/shared/api/client', () => ({ api: {} }));
vi.mock('@/features/queries', async () => {
  const { ref: createRef, toValue } = await import('vue');
  const resolveKey = (key: unknown) =>
    JSON.stringify(typeof key === 'function' ? (key as () => unknown)() : key);
  const fakeQuery = (key: string | undefined) => ({
    data: createRef(q.fixtures[key ?? '']),
    isPending: createRef(false),
    error: createRef(null),
    refetch: vi.fn(),
  });
  return {
    QUERY_POLLING: { fast: 2000, slow: 5000, ambient: 10000, rare: 30000 },
    useResourceQuery: (
      key: unknown,
      _load: unknown,
      enabled: unknown,
      interval: unknown,
    ) => {
      const resolved = resolveKey(key);
      q.resourceCalls.push({
        key: resolved,
        interval,
        enabled: toValue(enabled as never),
      });
      return fakeQuery(resolved);
    },
    usePanelAgentQuery: () => q.panelAgentQuery,
    useTeamDirectivesQuery: () => q.directivesQuery,
    useInteractionsQuery: () => q.interactionsQuery,
    useMessagesQuery: () => q.messagesQuery,
    useTurnsQuery: () => q.turnsQuery,
  };
});

import { useTeamQueries, type TeamQueriesOptions } from './use-team-queries';

const key = (...parts: unknown[]) => JSON.stringify(parts);

const group = (id: string, state: 'active' | 'archived' = 'active') => ({
  id,
  name: `团队 ${id}`,
  workspace: `/tmp/${id}`,
  lead: 'm1',
  created: '2026-01-01T00:00:00Z',
  state,
});
const endpoint = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  group_id: 'g1',
  member_id: 'm1',
  context: 'coordination',
  peer: null,
  session: null,
  ...extra,
});
const queryState = (data: unknown) => ({
  data: ref(data),
  isPending: ref(false),
  error: ref(null),
  refetch: vi.fn(),
});

function options(overrides: Record<string, unknown> = {}) {
  return {
    groupId: ref('g1'),
    selectedSessionId: ref(''),
    activeTab: ref('trace'),
    contextPanel: ref('collaboration'),
    contextVisible: ref(true),
    detailsVisible: ref(false),
    ...overrides,
  } as unknown as TeamQueriesOptions;
}

beforeEach(() => {
  routeState.route = { name: 'group', query: {} };
  q.resourceCalls = [];
  q.client.invalidateQueries.mockReset();
  q.fixtures = {
    [key('groups')]: [group('g1'), group('g2', 'archived')],
    [key('directory')]: { members: [{ id: 'm1', name: '甲' }], actors: [], panelAgent: null },
    [key('groups', 'archived')]: [group('g2', 'archived')],
    [key('group', 'g1', 'detail')]: { ...group('g1'), controller: null },
    [key('group', 'g1', 'sessions')]: {
      endpoints: [endpoint('e1'), endpoint('e2')],
      sessionBindings: [{ endpoint_id: 'e1', session_key: 'k', session: 's', updated: '' }],
    },
    [key('group', 'g1', 'session', 'e2')]: endpoint('e2', { peer: 'm2' }),
    [key('group', 'g1', 'tasks')]: [{ owner_id: 'm1', group_id: 'g1', tasks: [] }],
    [key('group', 'g1', 'runtime')]: [{ id: 'e1', group_id: 'g1', member_id: 'm1' }],
    [key('home-summary')]: [{ id: 'h1', group_id: 'g1', member_id: 'm1' }],
    [key('model-policy')]: { policy: 'safe' },
    [key('model-policy-defaults')]: { policy: 'safe' },
    [key('panel-agent', 'unread')]: { messages: [], receipts: [] },
  };
  q.messagesQuery = {
    rows: ref([]),
    isPending: ref(false),
    isFetchingNextPage: ref(false),
    hasNextPage: ref(false),
    fetchNextPage: vi.fn(),
  };
  q.panelAgentQuery = queryState(undefined);
  q.directivesQuery = queryState(undefined);
  q.interactionsQuery = queryState(undefined);
  q.turnsQuery = { ...queryState(undefined), turns: ref([]), unaffiliated: ref([]), hasNextPage: ref(false), isFetchingNextPage: ref(false), fetchNextPage: vi.fn() };
});

describe('team query orchestration', () => {
  it('keeps every query key and polling interval on the QUERY_POLLING budget buckets', () => {
    useTeamQueries(options());
    const calls = Object.fromEntries(q.resourceCalls.map((call) => [call.key, call]));
    expect(Object.keys(calls)).toHaveLength(12);
    expect(calls[key('group', 'g1', 'sessions')]?.interval).toBe(5000);
    expect(calls[key('group', 'g1', 'tasks')]?.interval).toBe(10000);
    expect(calls[key('groups', 'archived')]?.interval).toBe(10000);
    expect(calls[key('groups')]?.interval).toBe(30000);
    expect(calls[key('directory')]?.interval).toBe(30000);
    expect(calls[key('group', 'g1', 'detail')]?.interval).toBe(10000);
    expect(calls[key('model-policy')]?.interval).toBe(10000);
    expect(calls[key('model-policy-defaults')]?.interval).toBe(false);
    expect(calls[key('panel-agent', 'unread')]?.interval).toBe(5000);
    expect(calls[key('group', 'g1', 'runtime')]?.interval).toBe(2000);
    expect(calls[key('home-summary')]?.interval).toBe(5000);
    // session query 在选中会话前处于 disabled 且使用 ambient 间隔。
    expect(calls[key('group', 'g1', 'session', '')]?.interval).toBe(10000);
    // tasks 只在概览 tab 可见时启用；会话列表始终启用。
    expect(calls[key('group', 'g1', 'tasks')]?.enabled).toBe(true);
    expect(calls[key('group', 'g1', 'sessions')]?.enabled).toBe(true);
  });

  it('merges session endpoints for the workspace snapshot and dedupes by endpoint id', () => {
    const selectedSessionId = ref('e2');
    const queries = useTeamQueries(options({ selectedSessionId }));
    expect(queries.endpoints.value.map((row) => row.id)).toEqual(['e1', 'e2']);
    expect(queries.snapshot.value.endpoints).toHaveLength(2);
    expect(queries.snapshot.value.agentTasks).toHaveLength(1);
    // 未选团队时不投影端点。
    const empty = useTeamQueries(options({ groupId: ref('') }));
    expect(empty.endpoints.value).toEqual([]);
  });

  it('gates overview on navigation resources and derives navigation/workspace states', () => {
    const queries = useTeamQueries(options());
    expect(queries.allGroups.value.map((team) => team.id)).toEqual(['g1', 'g2']);
    expect(queries.overview.value?.panelTeams).toHaveLength(1);
    expect(queries.overview.value?.modelPolicy).toEqual({ policy: 'safe' });
    expect(queries.navigationState.isPending.value).toBe(false);
    expect(queries.workspaceState.isPending.value).toBe(false);
    expect(queries.homeRunningByGroup.value).toEqual({ g1: 1, g2: 0 });
    // 导航资源未就绪时 overview 不投影。
    q.fixtures[key('groups')] = undefined;
    const pending = useTeamQueries(options());
    expect(pending.overview.value).toBeUndefined();
  });

  it('switches running endpoints between group runtime and home summary and refreshes workspace resources', async () => {
    const groupQueries = useTeamQueries(options());
    expect(groupQueries.runningEndpoints.value).toEqual(['e1']);
    const homeQueries = useTeamQueries(options({ groupId: ref('') }));
    expect(homeQueries.runningEndpoints.value).toEqual(['h1']);
    await groupQueries.refreshResources();
    expect(q.client.invalidateQueries).toHaveBeenCalledTimes(1);
  });
});
