import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { toast } from 'vue-sonner';
import { usePanelAgentStore } from '@/stores/panel-agent';
import { usePreferencesStore } from '@/stores/preferences';
import { useTeamDirectiveStore } from '@/stores/team-directives';
import {
  reuseMessageViews,
  toMessageViews,
} from '@/features/messages/adapters';
import { buildTurns } from '@/features/traces/reducer';
import { builtinTool, navToolEntries as navToolEntriesFor } from '@/tools';
import type { TeamQueriesOptions } from './use-team-queries';
import type { TeamQueries } from './use-team-queries';

/**
 * 团队工作区的派生视图层：把查询结果投影成侧栏/会话/检查器直接消费的 computed，
 * 以及从用户偏好推导的工具导航条目。这里不做查询、不发请求、不写副作用
 * （唯一例外是 `loadInspectorMore`，它只是检查器分页动作的 toast 包装）。
 */
export function useTeamDerived(
  options: TeamQueriesOptions,
  queries: TeamQueries,
) {
  const route = useRoute();
  const panelAgentState = usePanelAgentStore();
  const preferences = usePreferencesStore();
  const directiveState = useTeamDirectiveStore();
  const { groupId, selectedSessionId, activeTab, contextPanel } = options;

  const isPanelAgentRoute = computed(() => route.name === 'panel-agent');
  const isSettingsRoute = computed(() => route.name === 'settings');
  const isNotesRoute = computed(() => route.name === 'notes');

  const groups = computed(() =>
    queries.allGroups.value.filter((team) => team.state !== 'archived'),
  );
  const archivedGroups = computed(() => queries.archivedQuery.data.value ?? []);
  const group = computed(() =>
    groups.value.find((item) => item.id === groupId.value),
  );
  const panelMessages = computed(() =>
    isPanelAgentRoute.value
      ? (queries.panelAgentQuery.data.value?.conversation.map((row) => ({
          ...row,
          active_team_id: null,
        })) ?? [])
      : (queries.unreadQuery.data.value?.messages ?? []),
  );
  const receiptRequests = computed(() =>
    isPanelAgentRoute.value
      ? (queries.panelAgentQuery.data.value?.requests ?? [])
      : queries.unreadQuery.data.value
        ? [{ receipts: queries.unreadQuery.data.value.receipts }]
        : [],
  );
  const agentUnreadCount = computed(
    () =>
      panelAgentState.unreadForContext(panelMessages.value, '') +
      panelAgentState.unreadReceipts(receiptRequests.value),
  );

  const currentControllerId = computed(
    () =>
      queries.overview.value?.panelTeams.find(
        (team) => team.id === groupId.value,
      )?.controller.id ??
      group.value?.lead ??
      undefined,
  );
  const currentController = computed(
    () =>
      queries.overview.value?.panelTeams.find(
        (team) => team.id === groupId.value,
      )?.controller ??
      (() => {
        const lead = queries.members.value.find(
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
              queries.overview.value?.panelTeams.find(
                (team) => team.id === groupId.value,
              )?.controller.assignment?.original_lead_id,
            ].filter((id): id is string => Boolean(id))
          : [],
      ),
  );
  const currentMembers = computed(() =>
    queries.members.value.filter(
      (member) => member.group_id === groupId.value && !member.removed,
    ),
  );
  const currentEndpoints = computed(() =>
    queries.endpoints.value.filter(
      (endpoint) =>
        endpoint.group_id === groupId.value && endpoint.context !== 'profile',
    ),
  );
  const currentSessionBindings = computed(() => {
    const ids = new Set(currentEndpoints.value.map((endpoint) => endpoint.id));
    return queries.sessionBindings.value.filter((binding) =>
      ids.has(binding.endpoint_id),
    );
  });
  const currentModelPolicy = computed(() => queries.overview.value?.modelPolicy);

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
      queries.members.value.find((member) => member.id === id)?.name ??
      queries.actors.value.find((actor) => actor.id === id)?.name ??
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

  // 2 秒轮询每次都会重建 rows 与视图数组；按内容复用视图对象，让未变化的历史消息
  // 在流式输出或轮询时跳过重渲染（消息 vnode 的 props 比较按引用短路）。
  let cachedMessageViews: ReturnType<typeof toMessageViews> = [];
  const messageViews = computed(() => {
    const endpoint = selectedEndpoint.value;
    const combined = [
      ...new Map(
        [
          ...(directiveState.acceptedMessages[groupId.value] ?? []),
          ...queries.messagesQuery.rows.value,
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
      toMessageViews(
        rows,
        queries.members.value,
        queries.actors.value,
        currentControllerId.value,
      ),
    );
    return cachedMessageViews;
  });

  const endpointHosts = computed(
    () =>
      Object.fromEntries(
        currentEndpoints.value.map((endpoint) => {
          const member = queries.members.value.find(
            (item) => item.id === endpoint.member_id,
          );
          const panelHost =
            endpoint.member_id === queries.overview.value?.panelAgent?.id
              ? queries.overview.value?.panelAgent?.host
              : undefined;
          return [endpoint.id, member?.host ?? panelHost ?? 'unknown'];
        }),
      ) as Record<string, 'codex' | 'claude' | 'dsh' | 'unknown'>,
  );

  const turns = computed(() =>
    options.detailsVisible.value && activeTab.value === 'trace'
      ? buildTurns(queries.historyQuery.rows.value, {
          hosts: endpointHosts.value,
          running: selectedSessionId.value
            ? queries.runningEndpoints.value.includes(selectedSessionId.value)
            : false,
        })
      : [],
  );

  const runningMemberIds = computed(
    () =>
      new Set(
        (queries.runtimeQuery.data.value ?? []).map(
          (endpoint) => endpoint.member_id,
        ),
      ),
  );
  const selectedModelState = computed(() => queries.modelsQuery.state.value ?? null);

  const inspectorHasNextPage = computed(() =>
    activeTab.value === 'usage'
      ? false
      : activeTab.value === 'models'
        ? queries.modelsQuery.hasNextPage.value
        : queries.historyQuery.hasNextPage.value,
  );
  const inspectorFetchingNextPage = computed(() =>
    activeTab.value === 'usage'
      ? false
      : activeTab.value === 'models'
        ? queries.modelsQuery.isFetchingNextPage.value
        : queries.historyQuery.isFetchingNextPage.value,
  );

  const contextError = computed(() =>
    contextPanel.value === 'sessions'
      ? queries.sessionsQuery.error.value
      : contextPanel.value === 'collaboration'
        ? queries.tasksQuery.error.value
        : contextPanel.value === 'details'
          ? queries.sessionQuery.error.value
          : null,
  );
  function retryContext() {
    if (contextPanel.value === 'sessions') void queries.sessionsQuery.refetch();
    else if (contextPanel.value === 'collaboration') void queries.tasksQuery.refetch();
    else void queries.sessionQuery.refetch();
  }

  const inspectorError = computed(() =>
    activeTab.value === 'usage'
      ? undefined
      : activeTab.value === 'models'
        ? queries.modelsQuery.error.value
        : queries.historyQuery.error.value,
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
      if (activeTab.value === 'models') await queries.modelsQuery.fetchNextPage();
      else await queries.historyQuery.fetchNextPage();
    } catch (error) {
      toast.error('加载更多事件失败', { description: String(error) });
    }
  }

  return {
    isPanelAgentRoute,
    isSettingsRoute,
    isNotesRoute,
    groups,
    archivedGroups,
    group,
    panelMessages,
    receiptRequests,
    agentUnreadCount,
    currentControllerId,
    currentController,
    sidebarGroupId,
    pausedMemberIds,
    currentMembers,
    currentEndpoints,
    currentSessionBindings,
    currentModelPolicy,
    selectedEndpoint,
    selectedPair,
    conversationTitle,
    selectedEndpointIsManagerPair,
    messageViews,
    endpointHosts,
    turns,
    runningMemberIds,
    selectedModelState,
    inspectorHasNextPage,
    inspectorFetchingNextPage,
    contextError,
    retryContext,
    inspectorError,
    notesTool,
    navToolEntries,
    notesPageComponent,
    notesEnabled,
    loadInspectorMore,
  };
}

export type TeamDerived = ReturnType<typeof useTeamDerived>;
