import { describe, expect, it, vi } from 'vitest';

/**
 * `useTeamResources` 是页面唯一入口：拆分后返回值名是契约，页面解构路径不能变。
 * 这里用三个层的 mock 钉住「键集合 + 每个键来自哪一层 + 参数透传」。
 */

const mocks = vi.hoisted(() => ({
  queries: {} as Record<string, unknown>,
  derived: {} as Record<string, unknown>,
  actions: {} as Record<string, unknown>,
  calls: [] as Array<{ layer: string; args: unknown[] }>,
}));

vi.mock('./use-team-queries', () => ({
  useTeamQueries: (...args: unknown[]) => {
    mocks.calls.push({ layer: 'queries', args });
    return mocks.queries;
  },
}));
vi.mock('./use-team-derived', () => ({
  useTeamDerived: (...args: unknown[]) => {
    mocks.calls.push({ layer: 'derived', args });
    return mocks.derived;
  },
}));
vi.mock('./use-team-notifications', () => ({
  useTeamNotifications: (...args: unknown[]) => {
    mocks.calls.push({ layer: 'actions', args });
    return mocks.actions;
  },
}));

import { useTeamResources } from './use-team-resources';

// 与拆分前 useTeamResources 的返回块逐项一致（顺序按原返回块的分组）。
const QUERY_KEYS = [
  'allGroups',
  'members',
  'actors',
  'overview',
  'snapshot',
  'navigationState',
  'workspaceState',
  'refreshResources',
  'modelPolicyDefaults',
  'homeRunningByGroup',
  'runningEndpoints',
  'messagesQuery',
  'directivesQuery',
  'interactionsQuery',
  'turnsQuery',
  'archivedQuery',
  'sessionsQuery',
  'tasksQuery',
  'sessionQuery',
] as const;
const DERIVED_KEYS = [
  'groups',
  'archivedGroups',
  'group',
  'isPanelAgentRoute',
  'isSettingsRoute',
  'isNotesRoute',
  'sidebarGroupId',
  'currentModelPolicy',
  'currentControllerId',
  'currentController',
  'pausedMemberIds',
  'currentMembers',
  'currentEndpoints',
  'currentSessionBindings',
  'selectedEndpoint',
  'selectedPair',
  'selectedEndpointIsManagerPair',
  'conversationTitle',
  'endpointHosts',
  'runningMemberIds',
  'panelMessages',
  'receiptRequests',
  'agentUnreadCount',
  'messageViews',
  'turnSummaries',
  'unaffiliatedEvents',
  'inspectorHasNextPage',
  'inspectorFetchingNextPage',
  'inspectorError',
  'contextError',
  'retryContext',
  'loadInspectorMore',
  'notesTool',
  'navToolEntries',
  'notesPageComponent',
  'notesEnabled',
] as const;
const ACTION_KEYS = ['modelPolicySaved', 'restoreArchivedTeam'] as const;

const CONTRACT_KEYS = [...QUERY_KEYS, ...DERIVED_KEYS, ...ACTION_KEYS];

function fill(keys: readonly string[], layer: string) {
  return Object.fromEntries(keys.map((key) => [key, `${layer}.${key}`]));
}

function setupMocks() {
  mocks.calls = [];
  mocks.queries = fill(QUERY_KEYS, 'queries');
  mocks.derived = fill(DERIVED_KEYS, 'derived');
  mocks.actions = fill(ACTION_KEYS, 'actions');
}

describe('team resources composition contract', () => {
  it('exposes exactly the historical return names and maps every name to its layer', () => {
    setupMocks();
    const resources = useTeamResources({} as never);
    expect(Object.keys(resources).sort()).toEqual([...CONTRACT_KEYS].sort());
    expect(Object.keys(resources)).toHaveLength(
      QUERY_KEYS.length + DERIVED_KEYS.length + ACTION_KEYS.length,
    );
    for (const key of QUERY_KEYS) expect(resources[key]).toBe(`queries.${key}`);
    for (const key of DERIVED_KEYS) expect(resources[key]).toBe(`derived.${key}`);
    for (const key of ACTION_KEYS) expect(resources[key]).toBe(`actions.${key}`);
  });

  it('forwards the same options through every layer and chains queries → derived → actions', () => {
    setupMocks();
    const options = { groupId: 'g1' } as never;
    useTeamResources(options);
    const [queriesCall, derivedCall, actionsCall] = mocks.calls;
    expect(queriesCall).toEqual({ layer: 'queries', args: [options] });
    expect(derivedCall).toEqual({ layer: 'derived', args: [options, mocks.queries] });
    expect(actionsCall).toEqual({
      layer: 'actions',
      args: [options, mocks.queries, mocks.derived],
    });
  });
});
