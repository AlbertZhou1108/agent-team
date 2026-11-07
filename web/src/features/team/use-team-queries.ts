import { computed, type ComputedRef } from 'vue';
import { useRoute } from 'vue-router';
import { useQueryClient } from '@tanstack/vue-query';
import { api } from '@/shared/api/client';
import { queryKeys, invalidateWorkspaceResources } from '@/features/query-keys';
import {
  QUERY_POLLING,
  useInteractionsQuery,
  useMessagesQuery,
  usePanelAgentQuery,
  useResourceQuery,
  useTeamDirectivesQuery,
  useTurnsQuery,
} from '@/features/queries';
import type { InspectorTab } from '@/features/sessions/types';
import type { AgentTaskEntry, AgentTasksView } from '@/shared/api/raw-types';
import type { ContextPanel } from './types';

export type TeamQueriesOptions = {
  groupId: ComputedRef<string>;
  selectedSessionId: ComputedRef<string>;
  activeTab: ComputedRef<InspectorTab>;
  contextPanel: ComputedRef<ContextPanel>;
  contextVisible: ComputedRef<boolean>;
  detailsVisible: ComputedRef<boolean>;
};

/**
 * 团队工作区的查询编排层：只负责创建/启用/失效查询，以及查询结果到基础数据
 * （目录、会话端点、导航状态、快照）的直接投影。视图语义放
 * `use-team-derived`，副作用放 `use-team-notifications`。
 *
 * 查询 key、轮询桶、enabled 条件与原实现逐字一致；轮询策略只来自
 * `features/queries` 的 QUERY_POLLING，不在这里另起间隔。
 */
export function useTeamQueries(options: TeamQueriesOptions) {
  const route = useRoute();
  const queryClient = useQueryClient();
  const {
    groupId,
    selectedSessionId,
    activeTab,
    contextPanel,
    contextVisible,
    detailsVisible,
  } = options;

  // 会话列表不只服务右侧栏：endpoints → 宿主映射是执行轨迹解释事件的前提，
  // 只在「会话 tab 打开时」才取会让轨迹在默认视图下全部降级成未识别事件。
  const sessionsQuery = useResourceQuery(
    () => queryKeys.resource(groupId.value, 'sessions'),
    (signal) => api.sessions(groupId.value, signal),
    () => Boolean(groupId.value),
    QUERY_POLLING.slow,
  );
  const tasksQuery = useResourceQuery(
    () => queryKeys.resource(groupId.value, 'tasks'),
    (signal) => api.tasks(groupId.value, signal),
    () =>
      Boolean(groupId.value) &&
      contextVisible.value &&
      contextPanel.value === 'collaboration',
    QUERY_POLLING.ambient,
  );
  const archivedQuery = useResourceQuery(
    ['groups', 'archived'],
    api.archivedGroups,
    () => route.name === 'settings',
    QUERY_POLLING.ambient,
  );
  const groupsQuery = useResourceQuery(queryKeys.groups, api.groups, true, QUERY_POLLING.rare);
  const directoryQuery = useResourceQuery(
    queryKeys.directory,
    api.directory,
    true,
    QUERY_POLLING.rare,
  );
  const detailQuery = useResourceQuery(
    () => queryKeys.resource(groupId.value, 'detail'),
    (signal) => api.group(groupId.value, signal),
    () => Boolean(groupId.value),
    QUERY_POLLING.ambient,
  );
  const policyQuery = useResourceQuery(
    queryKeys.policy,
    api.modelPolicy,
    () => Boolean(groupId.value) || route.name === 'settings',
    QUERY_POLLING.ambient,
  );
  const defaultsQuery = useResourceQuery(
    queryKeys.defaults,
    api.modelDefaults,
    () => route.name === 'settings',
    false,
  );
  const panelAgentQuery = usePanelAgentQuery(() => route.name === 'panel-agent');
  const unreadQuery = useResourceQuery(
    queryKeys.unread,
    api.unread,
    () => route.name !== 'panel-agent',
    QUERY_POLLING.slow,
  );
  const runtimeQuery = useResourceQuery(
    () => queryKeys.resource(groupId.value, 'runtime'),
    (signal) => api.runtime(groupId.value, signal),
    () => Boolean(groupId.value),
    QUERY_POLLING.fast,
  );
  const homeQuery = useResourceQuery(
    queryKeys.home,
    api.homeSummary,
    () => !groupId.value && route.name === 'group',
    QUERY_POLLING.slow,
  );
  const sessionQuery = useResourceQuery(
    () => queryKeys.session(groupId.value, selectedSessionId.value),
    (signal) =>
      api.session(groupId.value, selectedSessionId.value, signal),
    () => Boolean(groupId.value && selectedSessionId.value),
    QUERY_POLLING.ambient,
  );

  const allGroups = computed(() => groupsQuery.data.value ?? []);
  const members = computed(() => directoryQuery.data.value?.members ?? []);
  const actors = computed(() => [
    ...(directoryQuery.data.value?.actors ?? []),
    ...(directoryQuery.data.value?.panelAgent
      ? [directoryQuery.data.value.panelAgent]
      : []),
  ]);
  const endpoints = computed(() =>
    groupId.value
      ? [
          ...new Map(
            [
              ...(sessionsQuery.data.value?.endpoints ?? []),
              ...(sessionQuery.data.value ? [sessionQuery.data.value] : []),
            ].map((row) => [row.id, row]),
          ).values(),
        ]
      : [],
  );
  const sessionBindings = computed(
    () => sessionsQuery.data.value?.sessionBindings ?? [],
  );
  const runningEndpoints = computed(
    () =>
      (groupId.value ? runtimeQuery.data.value : homeQuery.data.value)?.map(
        (row) => row.id,
      ) ?? [],
  );
  const overview = computed(() =>
    groupsQuery.data.value && directoryQuery.data.value
      ? {
          groups: allGroups.value,
          ...directoryQuery.data.value,
          panelTeams: detailQuery.data.value ? [detailQuery.data.value] : [],
          modelPolicy: policyQuery.data.value,
          modelPolicyDefaults: defaultsQuery.data.value,
        }
      : undefined,
  );
  const agentTasksView = computed<AgentTasksView>(() =>
    tasksQuery.data.value ?? { currentPlan: null, historicalPlans: [], memberTasks: [], cancelledSteps: [] },
  );
  // 面板主体在第 4 阶段切换到三段结构;这里先保留平铺投影,避免本次 API 改造让面板失效。
  const agentTasks = computed<AgentTaskEntry[]>(() => {
    const view = agentTasksView.value;
    return [
      ...(view.currentPlan
        ? [{
            owner_id: view.currentPlan.owner_id,
            group_id: view.currentPlan.group_id,
            owner_kind: view.currentPlan.owner_kind,
            tasks: view.currentPlan.steps,
            updated: view.currentPlan.updated ?? view.currentPlan.frozen_at ?? '',
          }]
        : []),
      ...view.memberTasks,
    ];
  });
  const snapshot = computed(() => ({
    endpoints: endpoints.value,
    agentTasks: agentTasks.value,
  }));
  async function refreshResources() {
    await invalidateWorkspaceResources(queryClient);
  }
  const navigationState = {
    data: overview,
    isPending: computed(
      () => groupsQuery.isPending.value || directoryQuery.isPending.value,
    ),
    error: computed(
      () => groupsQuery.error.value ?? directoryQuery.error.value,
    ),
    refetch: refreshResources,
  };
  const workspaceState = {
    data: snapshot,
    isPending: computed(() =>
      Boolean(groupId.value)
        ? detailQuery.isPending.value || runtimeQuery.isPending.value
        : route.name === 'group' && homeQuery.isPending.value,
    ),
    error: computed(() =>
      groupId.value
        ? detailQuery.error.value ?? runtimeQuery.error.value
        : route.name === 'group'
          ? homeQuery.error.value
          : null,
    ),
    refetch: refreshResources,
  };
  const modelPolicyDefaults = computed(() => defaultsQuery.data.value);
  const homeRunningByGroup = computed(() =>
    Object.fromEntries(
      allGroups.value.map((group) => [
        group.id,
        (homeQuery.data.value ?? []).filter(
          (row) => row.group_id === group.id,
        ).length,
      ]),
    ),
  );

  const messagesQuery = useMessagesQuery(
    () => groupId.value || undefined,
    () => selectedSessionId.value || undefined,
  );
  // 回合摘要只在详情-轨迹可见时取:head 5s 轮询跟新回合与运行中计数,更早页按需翻。
  const turnsQuery = useTurnsQuery(
    () =>
      detailsVisible.value && activeTab.value === 'trace'
        ? selectedSessionId.value || undefined
        : undefined,
  );
  const directivesQuery = useTeamDirectivesQuery(() => groupId.value || undefined);
  const interactionsQuery = useInteractionsQuery(() => groupId.value || undefined);

  return {
    allGroups,
    members,
    actors,
    endpoints,
    sessionBindings,
    runningEndpoints,
    overview,
    snapshot,
    navigationState,
    workspaceState,
    modelPolicyDefaults,
    homeRunningByGroup,
    refreshResources,
    // 查询对象：派生/副作用层与模板各自按需消费。
    archivedQuery,
    sessionsQuery,
    tasksQuery,
    agentTasksView,
    sessionQuery,
    runtimeQuery,
    detailQuery,
    panelAgentQuery,
    unreadQuery,
    messagesQuery,
    turnsQuery,
    directivesQuery,
    interactionsQuery,
  };
}

export type TeamQueries = ReturnType<typeof useTeamQueries>;
