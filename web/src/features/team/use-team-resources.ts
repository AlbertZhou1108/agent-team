import {
  computed,
  watch,
  watchEffect,
  type ComputedRef,
} from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQueryClient } from '@tanstack/vue-query';
import { toast } from 'vue-sonner';
import { api, ApiError } from '@/shared/api/client';
import { queryKeys, invalidateWorkspaceResources } from '@/features/query-keys';
import {
  QUERY_POLLING,
  useHistoryQuery,
  useInteractionsQuery,
  useMessagesQuery,
  useModelsQuery,
  usePanelAgentQuery,
  useResourceQuery,
  useTeamDirectivesQuery,
} from '@/features/queries';
import { useConnectionStore } from '@/stores/connection';
import { usePanelAgentStore } from '@/stores/panel-agent';
import { usePreferencesStore } from '@/stores/preferences';
import { useTeamDirectiveStore } from '@/stores/team-directives';
import { notifyInteraction } from '@/features/messages/interaction-notification';
import {
  reuseMessageViews,
  toMessageViews,
} from '@/features/messages/adapters';
import { buildTurns } from '@/features/traces/reducer';
import { builtinTool, navToolEntries as navToolEntriesFor } from '@/tools';
import type { Group } from '@/shared/api/raw-types';
import type { InspectorTab } from '@/features/sessions/types';
import type { ContextPanel } from './types';

export type TeamResourcesOptions = {
  groupId: ComputedRef<string>;
  selectedSessionId: ComputedRef<string>;
  activeTab: ComputedRef<InspectorTab>;
  contextPanel: ComputedRef<ContextPanel>;
  contextVisible: ComputedRef<boolean>;
  detailsVisible: ComputedRef<boolean>;
};

/**
 * 团队工作区数据编排：导航/目录/详情/策略/运行时/未读/会话/任务/历史/模型查询，
 * 以及它们的失效、派生投影与副作用（连接状态、互动卡通知、路由纠偏）。
 * 页面组合根只负责路由解析与 UI 动作。
 */
export function useTeamResources(options: TeamResourcesOptions) {
  const route = useRoute();
  const router = useRouter();
  const queryClient = useQueryClient();
  const connection = useConnectionStore();
  const panelAgentState = usePanelAgentStore();
  const preferences = usePreferencesStore();
  const directiveState = useTeamDirectiveStore();
  const {
    groupId,
    selectedSessionId,
    activeTab,
    contextPanel,
    contextVisible,
    detailsVisible,
  } = options;

  const isPanelAgentRoute = computed(() => route.name === 'panel-agent');
  const isSettingsRoute = computed(() => route.name === 'settings');
  const isNotesRoute = computed(() => route.name === 'notes');

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
  const snapshot = computed(() => ({
    endpoints: endpoints.value,
    agentTasks: tasksQuery.data.value ?? [],
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

  const groups = computed(() =>
    allGroups.value.filter((team) => team.state !== 'archived'),
  );
  const archivedGroups = computed(() => archivedQuery.data.value ?? []);
  const group = computed(() =>
    groups.value.find((item) => item.id === groupId.value),
  );
  const panelMessages = computed(() =>
    isPanelAgentRoute.value
      ? (panelAgentQuery.data.value?.conversation.map((row) => ({
          ...row,
          active_team_id: null,
        })) ?? [])
      : (unreadQuery.data.value?.messages ?? []),
  );
  const receiptRequests = computed(() =>
    isPanelAgentRoute.value
      ? (panelAgentQuery.data.value?.requests ?? [])
      : unreadQuery.data.value
        ? [{ receipts: unreadQuery.data.value.receipts }]
        : [],
  );
  const agentUnreadCount = computed(
    () =>
      panelAgentState.unreadForContext(panelMessages.value, '') +
      panelAgentState.unreadReceipts(receiptRequests.value),
  );

  const currentControllerId = computed(
    () =>
      overview.value?.panelTeams.find((team) => team.id === groupId.value)
        ?.controller.id ??
      group.value?.lead ??
      undefined,
  );
  const currentController = computed(
    () =>
      overview.value?.panelTeams.find((team) => team.id === groupId.value)
        ?.controller ??
      (() => {
        const lead = members.value.find(
          (member) => member.id === group.value?.lead,
        );
        return lead
          ? { id: lead.id, name: lead.name, kind: 'member' as const }
          : null;
      })(),
  );
  const sidebarGroupId = computed(() =>
    isPanelAgentRoute.value ? undefined : group.value?.id,
  );
  const pausedMemberIds = computed(
    () =>
      new Set(
        currentController.value?.kind === 'panel_agent'
          ? [
              overview.value?.panelTeams.find(
                (team) => team.id === groupId.value,
              )?.controller.assignment?.original_lead_id,
            ].filter((id): id is string => Boolean(id))
          : [],
      ),
  );
  const currentMembers = computed(() =>
    members.value.filter(
      (member) => member.group_id === groupId.value && !member.removed,
    ),
  );
  const currentEndpoints = computed(() =>
    endpoints.value.filter(
      (endpoint) =>
        endpoint.group_id === groupId.value && endpoint.context !== 'profile',
    ),
  );
  const currentSessionBindings = computed(() => {
    const ids = new Set(currentEndpoints.value.map((endpoint) => endpoint.id));
    return sessionBindings.value.filter((binding) =>
      ids.has(binding.endpoint_id),
    );
  });
  const currentModelPolicy = computed(() => overview.value?.modelPolicy);

  const selectedEndpoint = computed(() =>
    currentEndpoints.value.find(
      (endpoint) => endpoint.id === selectedSessionId.value,
    ),
  );
  const selectedPair = computed(() => {
    const endpoint = selectedEndpoint.value;
    return endpoint?.peer
      ? [endpoint.member_id, endpoint.peer].sort().join(':')
      : '';
  });
  const conversationTitle = computed(() => {
    const endpoint = selectedEndpoint.value;
    if (!endpoint) return '全部群消息';
    const name = (id: string) =>
      members.value.find((member) => member.id === id)?.name ??
      actors.value.find((actor) => actor.id === id)?.name ??
      id;
    return endpoint.peer
      ? `${name(endpoint.member_id)} ↔ ${name(endpoint.peer)}`
      : `${name(endpoint.member_id)} · 统一调度`;
  });
  const selectedEndpointIsManagerPair = computed(() => {
    const endpoint = selectedEndpoint.value;
    const controller = currentController.value;
    return Boolean(
      endpoint &&
        controller?.kind === 'panel_agent' &&
        (endpoint.context === 'pair' ||
          endpoint.context?.startsWith('pair:')) &&
        endpoint.peer === controller.id,
    );
  });

  // 新互动卡等待答复时提醒；点击跳到卡片所在视图，已在目标页则不跳转。
  const seenPendingInteractions = new Set<string>();
  let interactionsPrimed = false;
  const directivesQuery = useTeamDirectivesQuery(() => groupId.value || undefined);
  const interactionsQuery = useInteractionsQuery(() => groupId.value || undefined);
  watch(interactionsQuery.data, (rows) => {
    const pending = (rows ?? []).filter((item) => item.state === 'pending');
    if (!interactionsPrimed) {
      interactionsPrimed = true;
      for (const item of pending) seenPendingInteractions.add(item.id);
      return;
    }
    for (const item of pending) {
      if (seenPendingInteractions.has(item.id)) continue;
      seenPendingInteractions.add(item.id);
      const requester = item.member_id
        ? members.value.find((member) => member.id === item.member_id)
        : null;
      const name = item.member_id
        ? (requester?.name ?? item.member_id)
        : 'Panel Agent';
      notifyInteraction(name, item.payload.text, async () => {
        const target = item.member_id
          ? await api.sessionTarget(
              item.group_id || groupId.value,
              item.member_id,
              requester?.role === 'lead' ? 'coordination' : 'pair:user',
            )
          : null;
        return router.push({
          name: 'group',
          params: { groupId: item.group_id || groupId.value },
          query: {
            session: target?.id,
            interaction: item.id,
          },
        });
      });
    }
  });

  const messagesQuery = useMessagesQuery(
    () => groupId.value || undefined,
    () => selectedSessionId.value || undefined,
  );
  // Load older history until the linked interaction's anchor can render.
  watch(
    [
      () => route.query.interaction,
      () => route.query.message,
      messagesQuery.rows,
      interactionsQuery.data,
      messagesQuery.isPending,
      messagesQuery.isFetchingNextPage,
    ],
    async () => {
      const id = routeString(route.query.interaction);
      const item = interactionsQuery.data.value?.find((row) => row.id === id);
      const anchorId = item?.message_id ?? routeString(route.query.message);
      if (
        !anchorId ||
        messagesQuery.isPending.value ||
        messagesQuery.isFetchingNextPage.value
      )
        return;
      if (messagesQuery.rows.value.some((row) => row.id === anchorId)) return;
      if (messagesQuery.hasNextPage.value) await messagesQuery.fetchNextPage();
    },
    { immediate: true },
  );

  const historyQuery = useHistoryQuery(() =>
    detailsVisible.value && ['trace', 'events'].includes(activeTab.value)
      ? selectedSessionId.value || undefined
      : undefined,
  );
  const modelsQuery = useModelsQuery(() =>
    detailsVisible.value && activeTab.value === 'models'
      ? selectedSessionId.value || undefined
      : undefined,
  );

  // 2 秒轮询每次都会重建 rows 与视图数组；按内容复用视图对象，让未变化的历史消息
  // 在流式输出或轮询时跳过重渲染（消息 vnode 的 props 比较按引用短路）。
  let cachedMessageViews: ReturnType<typeof toMessageViews> = [];
  const messageViews = computed(() => {
    const endpoint = selectedEndpoint.value;
    const combined = [
      ...new Map(
        [
          ...(directiveState.acceptedMessages[groupId.value] ?? []),
          ...messagesQuery.rows.value,
        ].map((row) => [row.id, row]),
      ).values(),
    ].sort((a, b) => a.seq - b.seq);
    const rows =
      endpoint && !endpoint.peer
        ? combined.filter(
            (row) =>
              row.sender === endpoint.member_id ||
              row.recipient === endpoint.member_id,
          )
        : combined;
    cachedMessageViews = reuseMessageViews(
      cachedMessageViews,
      toMessageViews(rows, members.value, actors.value, currentControllerId.value),
    );
    return cachedMessageViews;
  });

  const endpointHosts = computed(
    () =>
      Object.fromEntries(
        currentEndpoints.value.map((endpoint) => {
          const member = members.value.find(
            (item) => item.id === endpoint.member_id,
          );
          const panelHost =
            endpoint.member_id === overview.value?.panelAgent?.id
              ? overview.value?.panelAgent?.host
              : undefined;
          return [endpoint.id, member?.host ?? panelHost ?? 'unknown'];
        }),
      ) as Record<string, 'codex' | 'claude' | 'dsh' | 'unknown'>,
  );

  const turns = computed(() =>
    detailsVisible.value && activeTab.value === 'trace'
      ? buildTurns(historyQuery.rows.value, {
          hosts: endpointHosts.value,
          running: selectedSessionId.value
            ? runningEndpoints.value.includes(selectedSessionId.value)
            : false,
        })
      : [],
  );

  const runningMemberIds = computed(
    () => new Set((runtimeQuery.data.value ?? []).map((endpoint) => endpoint.member_id)),
  );
  const selectedModelState = computed(() => modelsQuery.state.value ?? null);

  const inspectorHasNextPage = computed(() =>
    activeTab.value === 'usage'
      ? false
      : activeTab.value === 'models'
        ? modelsQuery.hasNextPage.value
        : historyQuery.hasNextPage.value,
  );
  const inspectorFetchingNextPage = computed(() =>
    activeTab.value === 'usage'
      ? false
      : activeTab.value === 'models'
        ? modelsQuery.isFetchingNextPage.value
        : historyQuery.isFetchingNextPage.value,
  );

  const contextError = computed(() =>
    contextPanel.value === 'sessions'
      ? sessionsQuery.error.value
      : contextPanel.value === 'collaboration'
        ? tasksQuery.error.value
        : contextPanel.value === 'details'
          ? sessionQuery.error.value
          : null,
  );
  function retryContext() {
    if (contextPanel.value === 'sessions') void sessionsQuery.refetch();
    else if (contextPanel.value === 'collaboration') void tasksQuery.refetch();
    else void sessionQuery.refetch();
  }

  const inspectorError = computed(() =>
    activeTab.value === 'usage'
      ? undefined
      : activeTab.value === 'models'
        ? modelsQuery.error.value
        : historyQuery.error.value,
  );

  watchEffect(() => {
    // 连接状态只由基础导航和主体资源判断；局部面板失败不阻断页面。
    const failure = navigationState.error.value ?? workspaceState.error.value;
    if (failure) connection.failed(failure);
    else if (navigationState.data.value && workspaceState.data.value)
      connection.online();
  });

  watch(
    [groups, groupId],
    ([items, id]) => {
      // 等导航数据就绪后再处理不存在的团队。
      if (
        !overview.value ||
        navigationState.isPending.value ||
        !id ||
        items.some((item) => item.id === id)
      )
        return;
      router.replace({ name: 'group' });
    },
    { immediate: true },
  );
  watch(
    () => detailQuery.error.value,
    (error) => {
      if (error instanceof ApiError && error.status === 410)
        void router.replace({ name: 'group' });
    },
  );
  watch(
    () => sessionQuery.error.value,
    (error) => {
      if (!(error instanceof ApiError) || error.status !== 404) return;
      const query = { ...route.query };
      delete query.session;
      delete query.tab;
      void router.replace({ query });
    },
  );

  // 工具模块：左导航条目与启用状态全部由注册表 + 用户偏好推导。
  const notesTool = builtinTool('builtin.notes')!;
  const navToolEntries = computed(() =>
    navToolEntriesFor(preferences.toolModules, route.name as string | undefined),
  );
  const notesPageComponent = computed(
    () => notesTool.mounts.find((mount) => mount.slot === 'left-nav')!.component,
  );
  const notesEnabled = computed(
    () => !preferences.toolModules.disabled[notesTool.id],
  );

  async function loadInspectorMore() {
    try {
      if (activeTab.value === 'models') await modelsQuery.fetchNextPage();
      else await historyQuery.fetchNextPage();
    } catch (error) {
      toast.error('加载更多事件失败', { description: String(error) });
    }
  }

  async function modelPolicySaved() {
    await refreshResources();
    toast.success('全局模型策略已保存', {
      description: '将用于新团队初始角色和已有团队新增角色',
    });
  }

  async function restoreArchivedTeam(team: Group) {
    try {
      await api.restoreTeam(team.id);
      // 刷新团队导航、详情和运行状态。
      await refreshResources();
      toast.success(`已恢复 ${team.name}`);
    } catch (error) {
      toast.error('恢复团队失败', { description: String(error) });
    }
  }

  return {
    // 导航/目录
    allGroups,
    groups,
    archivedGroups,
    group,
    members,
    actors,
    overview,
    snapshot,
    navigationState,
    workspaceState,
    refreshResources,
    // 路由投影
    isPanelAgentRoute,
    isSettingsRoute,
    isNotesRoute,
    sidebarGroupId,
    currentModelPolicy,
    modelPolicyDefaults,
    homeRunningByGroup,
    runningEndpoints,
    // 会话/成员
    currentControllerId,
    currentController,
    pausedMemberIds,
    currentMembers,
    currentEndpoints,
    currentSessionBindings,
    selectedEndpoint,
    selectedPair,
    selectedEndpointIsManagerPair,
    conversationTitle,
    endpointHosts,
    runningMemberIds,
    // 消息
    panelMessages,
    receiptRequests,
    agentUnreadCount,
    messagesQuery,
    directivesQuery,
    interactionsQuery,
    messageViews,
    // 检查器
    historyQuery,
    modelsQuery,
    turns,
    selectedModelState,
    inspectorHasNextPage,
    inspectorFetchingNextPage,
    inspectorError,
    contextError,
    retryContext,
    loadInspectorMore,
    // 查询对象（模板/调试用）
    archivedQuery,
    sessionsQuery,
    tasksQuery,
    sessionQuery,
    // 工具导航
    notesTool,
    navToolEntries,
    notesPageComponent,
    notesEnabled,
    // 动作
    modelPolicySaved,
    restoreArchivedTeam,
  };
}

function routeString(value: unknown) {
  return Array.isArray(value)
    ? String(value[0] ?? '')
    : typeof value === 'string'
      ? value
      : '';
}
