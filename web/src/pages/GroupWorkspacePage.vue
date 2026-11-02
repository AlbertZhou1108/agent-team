<script setup lang="ts">
import { Disclosure } from '@/components/ui/disclosure';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  computed,
  provide,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  watchEffect,
} from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { toast } from 'vue-sonner';
import { useMediaQuery } from '@vueuse/core';
import {
  Activity,
  Bot,
  MessagesSquare,
  PanelRightOpen,
} from '@lucide/vue';
import CollapsibleRightSidebar from '@/app/layouts/CollapsibleRightSidebar.vue';
import GroupSidebar from '@/app/layouts/GroupSidebar.vue';
import MemberStrip from '@/features/groups/MemberStrip.vue';
import MemberModelDialog from '@/features/groups/MemberModelDialog.vue';
import CollaborationPanel from '@/features/groups/CollaborationPanel.vue';
import TeamHome from '@/features/groups/TeamHome.vue';
import CreateTeam from '@/features/groups/CreateTeam.vue';
import PanelAgentPanel from '@/features/panel-agent/PanelAgentPanel.vue';
import TelemetryMembersView from '@/features/telemetry/TelemetryMembersView.vue';
import SettingsDialog from '@/features/settings/SettingsDialog.vue';
import ConfirmDialog from '@/components/panel/ConfirmDialog.vue';
import { frameBatch } from '@/features/messages/frame-batch';
import { teamConversationAfterSend, teamConversationSession } from '@/features/messages/conversation-navigation';
import { useTeamDirectiveStore } from '@/stores/team-directives';
import { notifyInteraction } from '@/features/messages/interaction-notification';
import ConversationWorkspace from '@/features/messages/ConversationWorkspace.vue';
import TeamDirectiveComposer from '@/features/messages/TeamDirectiveComposer.vue';

import SessionList from '@/features/sessions/SessionList.vue';
import InspectorPanel from '@/features/sessions/InspectorPanel.vue';
import type { InspectorTab } from '@/features/sessions/types';
import { reuseMessageViews, toMessageViews, toStreamMessageViews } from '@/features/messages/adapters';
import { buildTurns } from '@/features/traces/reducer';
import {
  useTeamDirectivesQuery,
  useInteractionsQuery,
  useHistoryQuery,
  useMessagesQuery,
  useModelsQuery,
  usePanelAgentQuery,
  useResourceQuery,
} from '@/features/queries';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useConnectionStore } from '@/stores/connection';
import {
  usePanelAgentStore,
} from '@/stores/panel-agent';
import { useUiStore } from '@/stores/ui';
import { api, ApiError } from '@/shared/api/client';
import { useQueryClient } from '@tanstack/vue-query';
import { queryKeys, invalidateWorkspaceResources } from '@/features/query-keys';
import type { Group, Member, TeamStream } from '@/shared/api/raw-types';

const route = useRoute();
const router = useRouter();
const ui = useUiStore();
const connection = useConnectionStore();
const panelAgentState = usePanelAgentStore();
const groupId = computed(() => routeString(route.params.groupId));
provide('result-scope', computed(() => groupId.value ? { group: groupId.value } : route.name === 'panel-agent' ? { panel: '1' } : null));
const selectedSessionId = computed(() => teamConversationSession(route.query));
watch(() => route.query.interaction, value => {
  if (!routeString(value) || (!route.query.session && !route.query.pair)) return;
  const query = { ...route.query }; delete query.session; delete query.pair;
  void router.replace({ query });
}, { immediate: true });
const queryClient = useQueryClient();
const archivedQuery = useResourceQuery(['groups', 'archived'], api.archivedGroups, () => route.name === 'settings', 10000);
const groupsQuery = useResourceQuery(queryKeys.groups, api.groups, true, 10000);
const directoryQuery = useResourceQuery(queryKeys.directory, api.directory, true, 10000);
const detailQuery = useResourceQuery(() => queryKeys.resource(groupId.value, 'detail'), signal => api.group(groupId.value, signal), () => Boolean(groupId.value), 3000);
const policyQuery = useResourceQuery(queryKeys.policy, api.modelPolicy, () => Boolean(groupId.value) || route.name === 'settings', 10000);
const defaultsQuery = useResourceQuery(queryKeys.defaults, api.modelDefaults, () => route.name === 'settings', false);
const panelAgentQuery = usePanelAgentQuery(() => route.name === 'panel-agent');
const unreadQuery = useResourceQuery(queryKeys.unread, api.unread, () => route.name !== 'panel-agent');
const runtimeQuery = useResourceQuery(() => queryKeys.resource(groupId.value, 'runtime'), signal => api.runtime(groupId.value, signal), () => Boolean(groupId.value));
const homeQuery = useResourceQuery(queryKeys.home, api.homeSummary, () => !groupId.value && route.name === 'group');
const sessionQuery = useResourceQuery(() => queryKeys.session(groupId.value, selectedSessionId.value), signal => api.session(groupId.value, selectedSessionId.value, signal), () => Boolean(groupId.value && selectedSessionId.value), 3000);
const allGroups = computed(() => groupsQuery.data.value ?? []);
const members = computed(() => directoryQuery.data.value?.members ?? []);
const actors = computed(() => [...(directoryQuery.data.value?.actors ?? []), ...(directoryQuery.data.value?.panelAgent ? [directoryQuery.data.value.panelAgent] : [])]);
const endpoints = computed(() => groupId.value ? [...new Map([...(sessionsQuery.data.value?.endpoints ?? []), ...(sessionQuery.data.value ? [sessionQuery.data.value] : [])].map(row => [row.id, row])).values()] : []);
const sessionBindings = computed(() => sessionsQuery.data.value?.sessionBindings ?? []);
const runningEndpoints = computed(() => (groupId.value ? runtimeQuery.data.value : homeQuery.data.value)?.map(row => row.id) ?? []);
const overview = computed(() => groupsQuery.data.value && directoryQuery.data.value ? { groups: allGroups.value, ...directoryQuery.data.value, panelTeams: detailQuery.data.value ? [detailQuery.data.value] : [], modelPolicy: policyQuery.data.value, modelPolicyDefaults: defaultsQuery.data.value } : undefined);
const snapshot = computed(() => ({ endpoints: endpoints.value, agentTasks: tasksQuery.data.value ?? [] }));
async function refreshResources() { await invalidateWorkspaceResources(queryClient); }
const navigationState = { data: overview, isPending: computed(() => groupsQuery.isPending.value || directoryQuery.isPending.value), error: computed(() => groupsQuery.error.value ?? directoryQuery.error.value), refetch: refreshResources };
const workspaceState = { data: snapshot, isPending: computed(() => Boolean(groupId.value) ? detailQuery.isPending.value || runtimeQuery.isPending.value : route.name === 'group' && homeQuery.isPending.value), error: computed(() => groupId.value ? detailQuery.error.value ?? runtimeQuery.error.value : route.name === 'group' ? homeQuery.error.value : null), refetch: refreshResources };
const modelPolicyDefaults = computed(() => defaultsQuery.data.value);
const homeRunningByGroup = computed(() => Object.fromEntries(allGroups.value.map(group => [group.id, (homeQuery.data.value ?? []).filter(row => row.group_id === group.id).length])));
const modelDialogMember = ref<Member | null>(null);
const modelDialogOpen = ref(false);

function openMemberModelDialog(member: Member) {
  modelDialogMember.value = member;
  modelDialogOpen.value = true;
}

function onMemberModelSaved() {
  void workspaceState.refetch();
}

const archiveConfirm = ref<{
  id: string;
  name: string;
} | null>(null);

function routeString(value: unknown) {
  return Array.isArray(value)
    ? String(value[0] ?? '')
    : typeof value === 'string'
      ? value
      : '';
}


const groups = computed(() =>
  allGroups.value.filter(
    (team) => team.state !== 'archived',
  ),
);
const archivedGroups = computed(() => archivedQuery.data.value ?? []);
const isPanelAgentRoute = computed(() => route.name === 'panel-agent');
const isSettingsRoute = computed(() => route.name === 'settings');
const group = computed(() =>
  groups.value.find((item) => item.id === groupId.value),
);
const pageVisible = ref(
  typeof document !== 'undefined' &&
    document.visibilityState === 'visible' &&
    document.hasFocus(),
);
const panelMessages = computed(
  () => isPanelAgentRoute.value ? panelAgentQuery.data.value?.conversation.map(row => ({ ...row, active_team_id: null })) ?? [] : unreadQuery.data.value?.messages ?? [],
);
const receiptRequests = computed(() => isPanelAgentRoute.value ? panelAgentQuery.data.value?.requests ?? [] : unreadQuery.data.value ? [{ receipts: unreadQuery.data.value.receipts }] : []);
const agentUnreadCount = computed(() =>
  panelAgentState.unreadForContext(panelMessages.value, '') + panelAgentState.unreadReceipts(receiptRequests.value),
);

function updatePageVisibility() {
  pageVisible.value =
    document.visibilityState === 'visible' && document.hasFocus();
}


onMounted(() => {
  window.addEventListener('focus', updatePageVisibility);
  window.addEventListener('blur', updatePageVisibility);
  document.addEventListener('visibilitychange', updatePageVisibility);
});

onBeforeUnmount(() => {
  window.removeEventListener('focus', updatePageVisibility);
  window.removeEventListener('blur', updatePageVisibility);
  document.removeEventListener('visibilitychange', updatePageVisibility);
});

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
            overview.value?.panelTeams.find((team) => team.id === groupId.value)
              ?.controller.assignment?.original_lead_id,
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
watch(
  [panelMessages, isPanelAgentRoute, pageVisible, () => panelAgentState.historyVisible],
  ([messages, onGlobal, visible, history]) => {
    panelAgentState.syncReadContexts(messages, onGlobal && visible && !history ? '' : undefined);
  }, { immediate: true },
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
const activeTab = computed<InspectorTab>(() => {
  const value = routeString(route.query.tab);
  return value === 'events' || value === 'models' || value === 'usage'
    ? value
    : 'trace';
});
type ContextPanel =
  | 'collaboration'
  | 'members'
  | 'sessions'
  | 'details';
const contextPanel = computed<ContextPanel>(() => {
  const value = routeString(route.query.panel);
  if (
    value === 'collaboration' ||
    value === 'members' ||
    value === 'sessions' ||
    value === 'details'
  )
    return value;
  return selectedSessionId.value ? 'details' : 'collaboration';
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
const managerConversationActive = computed(
  () => selectedEndpointIsManagerPair.value && activeTab.value === 'usage',
);
const contextTabs: Array<{
  value: ContextPanel;
  label: string;
  icon: typeof Bot;
}> = [
  { value: 'collaboration', label: '概览', icon: Activity },
  { value: 'members', label: '成员', icon: Bot },
  { value: 'sessions', label: '会话', icon: MessagesSquare },
  { value: 'details', label: '详情', icon: Activity },
];

const wideScreen = useMediaQuery('(min-width: 1280px)');
const contextVisible = computed(() => !ui.contextCollapsed && (wideScreen.value || ui.inspectorOpen));
const detailsVisible = computed(() => contextVisible.value && contextPanel.value === 'details');
const sessionsQuery = useResourceQuery(() => queryKeys.resource(groupId.value, 'sessions'), signal => api.sessions(groupId.value, signal), () => Boolean(groupId.value) && contextVisible.value && contextPanel.value === 'sessions');
const tasksQuery = useResourceQuery(() => queryKeys.resource(groupId.value, 'tasks'), signal => api.tasks(groupId.value, signal), () => Boolean(groupId.value) && contextVisible.value && contextPanel.value === 'collaboration');
const directivesQuery = useTeamDirectivesQuery(() => groupId.value || undefined);
const interactionsQuery = useInteractionsQuery(() => groupId.value || undefined);
const seenPendingInteractions = new Set<string>();
let interactionsPrimed = false;
watch(
  interactionsQuery.data,
  (rows) => {
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
        const target = item.member_id ? await api.sessionTarget(item.group_id || groupId.value, item.member_id, requester?.role === 'lead' ? 'coordination' : 'pair:user') : null;
        return router.push({
        name: 'group',
        params: { groupId: item.group_id || groupId.value },
        query: {
          session: target?.id,
          interaction: item.id,
        },
      }); });
    }
  },
);
const messagesQuery = useMessagesQuery(() => groupId.value || undefined, () => selectedSessionId.value || undefined);
// Load older history until the linked interaction's anchor can render.
watch(
  [() => route.query.interaction, () => route.query.message, messagesQuery.rows, interactionsQuery.data, messagesQuery.isPending, messagesQuery.isFetchingNextPage],
  async () => {
    const id = routeString(route.query.interaction);
    const item = interactionsQuery.data.value?.find(row => row.id === id);
    const anchorId = item?.message_id ?? routeString(route.query.message);
    if (!anchorId || messagesQuery.isPending.value || messagesQuery.isFetchingNextPage.value) return;
    if (messagesQuery.rows.value.some(row => row.id === anchorId)) return;
    if (messagesQuery.hasNextPage.value) await messagesQuery.fetchNextPage();
  },
  { immediate: true },
);
const teamStreaming = ref<Record<string, TeamStream>>({});
let teamStreamSource: EventSource | null = null;

function acceptTeamStream(payload: {
  type: 'snapshot' | 'start' | 'delta' | 'reasoning-delta' | 'phase' | 'complete' | 'cancelled' | 'error';
  stream?: TeamStream;
  streams?: TeamStream[];
  delta?: string;
  replace?: boolean;
}) {
  if (payload.type === 'snapshot') {
    teamStreaming.value = Object.fromEntries(
      (payload.streams ?? [])
        .filter(stream => stream.groupId === groupId.value)
        .map(stream => [stream.id, stream]),
    );
    return;
  }
  const stream = payload.stream;
  if (!stream || stream.groupId !== groupId.value) return;
  if (payload.type === 'delta' && typeof payload.delta === 'string') {
    const current = teamStreaming.value[stream.id];
    teamStreaming.value = {
      ...teamStreaming.value,
      [stream.id]: {
        ...stream,
        text: payload.replace
          ? payload.delta
          : (current?.text ?? '') + payload.delta,
      },
    };
    return;
  }
  if (payload.type === 'reasoning-delta' && typeof payload.delta === 'string') {
    const current = teamStreaming.value[stream.id];
    teamStreaming.value = {
      ...teamStreaming.value,
      [stream.id]: {
        ...stream,
        text: current?.text ?? '',
        reasoning: (current?.reasoning ?? '') + payload.delta,
      },
    };
    return;
  }
  // 阶段事件只替换阶段与工具,已累积的正文和思考保持原值。
  if (payload.type === 'phase') {
    const current = teamStreaming.value[stream.id];
    teamStreaming.value = {
      ...teamStreaming.value,
      [stream.id]: {
        ...stream,
        text: current?.text ?? '',
        reasoning: current?.reasoning ?? '',
      },
    };
    return;
  }
  if (payload.type === 'complete') {
    const completed = {
      ...stream,
      phase: 'complete' as const,
    };
    teamStreaming.value = {
      ...teamStreaming.value,
      [stream.id]: completed,
    };
    void messagesQuery.refetch()
      .then(() => {
        if (
          !completed.messageId
          || messagesQuery.rows.value.some(
            message => message.id === completed.messageId,
          )
        ) {
          const next = { ...teamStreaming.value };
          delete next[stream.id];
          teamStreaming.value = next;
        }
      })
      .catch(() => {
        // Keep the completed view visible until a later refetch reaches the
        // durable message, rather than dropping it before it is rendered.
      });
    return;
  }
  if (payload.type === 'cancelled' || payload.type === 'error') {
    const next = { ...teamStreaming.value };
    delete next[stream.id];
    teamStreaming.value = next;
    void messagesQuery.refetch();
    return;
  }
  teamStreaming.value = {
    ...teamStreaming.value,
    [stream.id]: stream,
  };
}

const teamStreamBatch = frameBatch(acceptTeamStream, requestAnimationFrame, cancelAnimationFrame);
watch(
  groupId,
  (id) => {
    teamStreamBatch.dispose();
    teamStreamSource?.close();
    teamStreamSource = null;
    teamStreaming.value = {};
    if (!id) return;
    teamStreamSource = new EventSource(
      `/api/teams/${encodeURIComponent(id)}/events`,
    );
    teamStreamSource.addEventListener('team-stream', (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent<string>).data);
        teamStreamBatch.push(payload);
        if (['complete', 'cancelled', 'error', 'snapshot'].includes(payload.type)) teamStreamBatch.flush();
      } catch {
        // The next state poll or stream event remains authoritative.
      }
    });
  },
  { immediate: true },
);

watch(
  () => messagesQuery.rows.value?.map(message => message.id).join('|'),
  () => {
    const persisted = new Set(
      messagesQuery.rows.value?.map(message => message.id) ?? [],
    );
    const next = { ...teamStreaming.value };
    let changed = false;
    for (const [id, stream] of Object.entries(next)) {
      if (stream.messageId && persisted.has(stream.messageId)) {
        delete next[id];
        changed = true;
      }
    }
    if (changed) teamStreaming.value = next;
  },
);

onBeforeUnmount(() => {
  teamStreamBatch.dispose();
  teamStreamSource?.close();
  teamStreamSource = null;
});
const activeTeamStreaming = computed(() => Object.values(teamStreaming.value));
// 流视图以取值函数交给消息流:token 级更新只重渲染流式子组件,不波及已定稿消息。
const readTeamStreamViews = () => toStreamMessageViews(
  messageViews.value,
  activeTeamStreaming.value,
  selectedPair.value,
  currentControllerId.value,
);
// 消息过滤只由右侧会话列表驱动(session 查询参数),不设第二套入口。
const historyQuery = useHistoryQuery(
  () => detailsVisible.value && ['trace', 'events'].includes(activeTab.value) ? selectedSessionId.value || undefined : undefined,
);
const modelsQuery = useModelsQuery(() => detailsVisible.value && activeTab.value === 'models' ? selectedSessionId.value || undefined : undefined);

const directiveState = useTeamDirectiveStore();
// 2 秒轮询每次都会重建 rows 与视图数组;按内容复用视图对象,让未变化的历史消息
// 在流式输出或轮询时跳过重渲染(消息 vnode 的 props 比较按引用短路)。
let cachedMessageViews: ReturnType<typeof toMessageViews> = [];
const messageViews = computed(() => {
  const endpoint = selectedEndpoint.value;
  const combined = [...new Map([
    ...(directiveState.acceptedMessages[groupId.value] ?? []),
    ...messagesQuery.rows.value,
  ].map(row => [row.id, row])).values()].sort((a, b) => a.seq - b.seq);
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
watch(
  [() => receiptRequests.value, messageViews, pageVisible, isPanelAgentRoute, () => panelAgentState.historyVisible],
  ([requests, views, visible, onPanel]) => {
    if (!requests) return;
    const pair = selectedPair.value;
    const displayed = !onPanel && visible ? views.filter(message => !pair || message.pairKey === pair).map(message => message.id) : [];
    panelAgentState.syncReceiptReads(requests, visible && onPanel && !panelAgentState.historyVisible, displayed);
  }, { immediate: true },
);
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
  detailsVisible.value && activeTab.value === 'trace' ? buildTurns(historyQuery.rows.value, {
    hosts: endpointHosts.value,
    running: selectedSessionId.value
      ? runningEndpoints.value.includes(selectedSessionId.value)
      : false,
  }) : [],
);

const runningMemberIds = computed(() => new Set((runtimeQuery.data.value ?? []).map(endpoint => endpoint.member_id)));

const selectedModelState = computed(
  () => modelsQuery.state.value ?? null,
);

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

const contextError = computed(() => contextPanel.value === 'sessions' ? sessionsQuery.error.value : contextPanel.value === 'collaboration' ? tasksQuery.error.value : contextPanel.value === 'details' ? sessionQuery.error.value : null);
function retryContext() { if (contextPanel.value === 'sessions') void sessionsQuery.refetch(); else if (contextPanel.value === 'collaboration') void tasksQuery.refetch(); else void sessionQuery.refetch(); }

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
  else if (navigationState.data.value && workspaceState.data.value) connection.online();
});

watch(
  [groups, groupId],
  ([items, id]) => {
    // 等导航数据就绪后再处理不存在的团队。
    if (!overview.value || navigationState.isPending.value || !id || items.some((item) => item.id === id)) return;
    router.replace({
      name: 'group',
    });
  },
  { immediate: true },
);

watch(() => detailQuery.error.value, error => {
  if (error instanceof ApiError && error.status === 410) void router.replace({ name: 'group' });
});
watch(() => sessionQuery.error.value, error => {
  if (!(error instanceof ApiError) || error.status !== 404) return;
  const query = { ...route.query }; delete query.session; delete query.tab;
  void router.replace({ query });
});

function replaceQuery(changes: Record<string, string | undefined>) {
  const query = { ...route.query };
  for (const [key, value] of Object.entries(changes)) {
    if (value) query[key] = value;
    else delete query[key];
  }
  return router.replace({ query });
}

function selectGroup(id: string) {
  ui.closeInspector();
  if (!id) {
    router.push({ name: 'group' });
    return;
  }
  router.push({ name: 'group', params: { groupId: id } });
}

function openPanelAgent() {
  if (isPanelAgentRoute.value) return;
  ui.closeInspector();
  router.push({ name: 'panel-agent' });
}

function openSettingsPage() {
  router.push({
    name: 'settings',
    query: { returnTo: route.fullPath },
  });
}

function closeSettingsPage() {
  const returnTo = routeString(route.query.returnTo);
  if (returnTo.startsWith('/') && !returnTo.startsWith('//'))
    router.push(returnTo);
  else router.push({ name: 'group' });
}

function selectSession(id: string) {
  ui.openInspector();
  replaceQuery({
    session: id || undefined,
    pair: undefined,
    interaction: undefined,
    message: undefined,
    tab: 'trace',
    panel: id ? 'details' : 'sessions',
  });
}


function closeContextPanel() {
  ui.closeInspector();
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

function archiveTeam(teamId: string) {
  const team = allGroups.value.find((item) => item.id === teamId);
  if (!team) return;
  archiveConfirm.value = {
    id: team.id,
    name: team.name,
  };
}

async function runArchiveTeam() {
  const request = archiveConfirm.value;
  if (!request) return;
  archiveConfirm.value = null;
  try {
    await api.archiveTeam(request.id);
    await refreshResources();
    if (groupId.value === request.id) router.push({ name: 'group' });
    toast.success(`已归档 ${request.name}`);
  } catch (error) {
    toast.error('归档团队失败', { description: String(error) });
  }
}

function setTab(tab: InspectorTab) {
  replaceQuery({ tab, panel: 'details' });
}

function selectContextTab(value: string | number) {
  const tab = contextTabs.find((item) => item.value === value);
  if (tab) setContextPanel(tab.value);
}

function setContextPanel(panel: ContextPanel) {
  ui.openInspector();
  replaceQuery({ panel });
}

async function loadInspectorMore() {
  try {
    if (activeTab.value === 'models') await modelsQuery.fetchNextPage();
    else await historyQuery.fetchNextPage();
  } catch (error) {
    toast.error('加载更多事件失败', { description: String(error) });
  }
}

const resizing = ref(false);
let drag: { side: 'left' | 'right'; x: number; width: number } | undefined;

function resizeWidth(side: 'left' | 'right', width: number) {
  const other =
    side === 'left'
      ? ui.contextCollapsed
        ? 60
        : ui.contextWidth
      : ui.sidebarCollapsed
        ? 76
        : ui.sidebarWidth;
  const max = Math.max(
    side === 'left' ? 180 : 280,
    window.innerWidth - other - 420,
  );
  if (side === 'left')
    ui.sidebarWidth = Math.round(Math.max(180, Math.min(400, max, width)));
  else ui.contextWidth = Math.round(Math.max(280, Math.min(680, max, width)));
}
function beginResize(event: PointerEvent, side: 'left' | 'right') {
  if (event.button !== 0) return;
  const handle = event.currentTarget as HTMLElement;
  handle.setPointerCapture(event.pointerId);
  drag = {
    side,
    x: event.clientX,
    width: side === 'left' ? ui.sidebarWidth : ui.contextWidth,
  };
  resizing.value = true;
  event.preventDefault();
}
function moveResize(event: PointerEvent) {
  if (!drag) return;
  resizeWidth(
    drag.side,
    drag.width + (event.clientX - drag.x) * (drag.side === 'left' ? 1 : -1),
  );
}
function endResize() {
  if (!drag) return;
  drag = undefined;
  resizing.value = false;
  ui.persist();
}
function keyboardResize(event: KeyboardEvent, side: 'left' | 'right') {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  const direction = event.key === 'ArrowRight' ? 1 : -1;
  resizeWidth(
    side,
    (side === 'left' ? ui.sidebarWidth : ui.contextWidth) +
      direction * (side === 'left' ? 16 : -16),
  );
  ui.persist();
}
</script>

<template>
  <div
    class="app-shell"
    :class="{
      'sidebar-is-collapsed': ui.sidebarCollapsed,
      'is-resizing': resizing,
    }"
    :style="{
      '--sidebar-width': `${ui.sidebarWidth}px`,
      '--context-width': `${ui.contextWidth}px`,
    }"
  >
    <GroupSidebar
      :groups="groups"
      :current-group-id="sidebarGroupId"
      :home-active="!isPanelAgentRoute && !isSettingsRoute && !group"
      :agent-active="isPanelAgentRoute"
      :agent-unread-count="agentUnreadCount"
      :settings-active="isSettingsRoute"
      @select="selectGroup"
      @archive="archiveTeam"
      @open-agent="openPanelAgent"
      @open-settings="openSettingsPage"
    />

    <div
      v-if="!ui.sidebarCollapsed"
      class="sidebar-resize-handle left-resize-handle"
      role="separator"
      tabindex="0"
      aria-label="调整左侧栏宽度"
      aria-orientation="vertical"
      :aria-valuenow="ui.sidebarWidth"
      :aria-valuemin="180"
      :aria-valuemax="400"
      @pointerdown="beginResize($event, 'left')"
      @pointermove="moveResize"
      @pointerup="endResize"
      @pointercancel="endResize"
      @lostpointercapture="endResize"
      @keydown="keyboardResize($event, 'left')"
    />
    <main class="min-w-0 p-3 sm:p-4 xl:pl-0">
      <SettingsDialog
        v-if="isSettingsRoute"
        :open="true"
        embedded
        :policy="currentModelPolicy"
        :defaults="modelPolicyDefaults"
        :archived-teams="archivedGroups"
        @close="closeSettingsPage"
        @saved="modelPolicySaved"
        @restore-team="restoreArchivedTeam"
      />
      <Card v-else-if="groupId && !group" class="m-4"><CardContent class="p-6 text-sm text-muted-foreground">正在读取团队…</CardContent></Card>
      <CreateTeam v-else-if="route.name === 'create-team'" />
      <TeamHome
        v-else-if="!group && !isPanelAgentRoute"
        :groups="groups"
        :members="members"
        :running-by-group="homeRunningByGroup"
        :running-endpoints="runningEndpoints"
        :loading="navigationState.isPending.value || workspaceState.isPending.value"
        :error="(navigationState.error.value ?? workspaceState.error.value)?.message"
        @select="selectGroup"
        @retry="refreshResources()"
      />
      <PanelAgentPanel v-else-if="!group" />
      <div
        v-else
        class="workspace-shell"
        :class="{
          'context-is-collapsed': ui.contextCollapsed,
          'manager-view-open': managerConversationActive,
          'is-resizing': resizing,
        }"
      >
        <ConversationWorkspace
          :heading="group.name"
          :description="group.workspace"
          :messages="messageViews"
          :stream-source="readTeamStreamViews"
          :directives="directivesQuery.data.value ?? []"
          :interactions="interactionsQuery.data.value ?? []"
          :title="conversationTitle"
          :selected-pair="selectedPair"
          :hosts="endpointHosts"
          :group-names="Object.fromEntries(groups.map(group => [group.id, group.name]))"
          :reset-key="groupId + ':' + selectedSessionId"
          :loading="navigationState.isPending.value || workspaceState.isPending.value || messagesQuery.isPending.value"
          :has-next-page="messagesQuery.hasNextPage.value"
          :fetching-next-page="messagesQuery.isFetchingNextPage.value"
          :error="navigationState.error.value?.message ?? workspaceState.error.value?.message ?? (messagesQuery.isError.value ? '消息同步失败，当前显示的是已缓存记录。' : '')"
          retryable
          @retry="refreshResources(); messagesQuery.refetch()"
          @load-more="messagesQuery.fetchNextPage()"
        >
          <template #heading-meta>
            <Badge v-if="currentController" variant="outline">{{ currentController.kind === 'panel_agent' ? 'Panel Agent 主控' : currentController.name === '主 Agent' ? '主 Agent' : currentController.name + ' · 主 Agent' }}</Badge>
            <span class="text-xs text-muted-foreground">{{ currentMembers.length }} 名成员</span>
          </template>
          <template #actions>
            <Button variant="outline" size="sm" class="xl:hidden" @click="ui.openInspector()"><PanelRightOpen />群信息</Button>
          </template>
          <template #status>
            <Alert v-if="inspectorError" variant="destructive" class="mx-4 mb-2 w-auto"><AlertDescription>{{ inspectorError.message }}</AlertDescription></Alert>
          </template>
          <template #composer>
            <TeamDirectiveComposer v-if="group" :key="groupId" :group-id="groupId"
              :controller-id="currentControllerId"
              :archived="group.state === 'archived'" :receipts="directivesQuery.data.value ?? []"
              @sent="router.replace({ query: teamConversationAfterSend(route.query) })" />
          </template>
        </ConversationWorkspace>

        <button
          v-if="ui.inspectorOpen"
          type="button"
          class="inspector-backdrop xl:hidden animate-in fade-in-0"
          aria-label="关闭群信息"
          @click="closeContextPanel"
        />

        <div
          v-if="!ui.contextCollapsed"
          class="sidebar-resize-handle right-resize-handle"
          role="separator"
          tabindex="0"
          aria-label="调整右侧栏宽度"
          aria-orientation="vertical"
          :aria-valuenow="ui.contextWidth"
          :aria-valuemin="280"
          :aria-valuemax="680"
          @pointerdown="beginResize($event, 'right')"
          @pointermove="moveResize"
          @pointerup="endResize"
          @pointercancel="endResize"
          @lostpointercapture="endResize"
          @keydown="keyboardResize($event, 'right')"
        />
        <CollapsibleRightSidebar
          v-model:collapsed="ui.contextCollapsed"
          :collapsed-actions="contextTabs"
          :active-action="contextPanel"
          desktop-only-toggle
          @update:collapsed="ui.persist()"
          @action="setContextPanel"
          :class="[
            'context-panel',
            ui.inspectorOpen && 'context-panel-open',
            ui.contextCollapsed && 'context-panel-collapsed',
          ]"
        >
          <div v-show="!ui.contextCollapsed" class="flex justify-end xl:hidden">
            <Button
              variant="ghost"
              size="icon"
              aria-label="关闭群信息"
              @click="closeContextPanel"
              ><span aria-hidden="true">×</span></Button
            >
          </div>
          <Tabs
            :model-value="contextPanel"
            class="min-h-0 flex-1"
            @update:model-value="selectContextTab"
          >
            <TabsList
              v-if="!ui.contextCollapsed"
              class="mx-4 w-auto shrink-0"
              aria-label="团队详情"
            >
              <TabsTrigger
                v-for="item in contextTabs"
                :key="item.value"
                :value="item.value"
                ><component :is="item.icon" />{{ item.label }}</TabsTrigger
              >
            </TabsList>
            <TabsContent
              v-if="contextVisible"
              :value="contextPanel"
              class="context-scroll"
            >
              <Alert v-if="contextError" variant="destructive"><AlertDescription class="flex items-center gap-2"><span class="flex-1">{{ contextError.message }}</span><Button variant="outline" size="sm" @click="retryContext">重试</Button></AlertDescription></Alert>
              <CollaborationPanel
                v-if="contextPanel === 'collaboration'"
                :group-id="groupId"
                :tasks="snapshot?.agentTasks ?? []"
                :members="members"
                :panel-agent="overview?.panelAgent ?? null"
              />
              <div
                v-else-if="contextPanel === 'members'"
                class="flex flex-col gap-5"
              >
                <TelemetryMembersView :group-id="groupId" />
                <Disclosure>
                  <template #summary>成员资料与模型（{{ currentMembers.length }}）</template>
                  <div class="mt-3">
                <MemberStrip
                  :members="currentMembers"
                  :running-member-ids="runningMemberIds"
                  :paused-member-ids="pausedMemberIds"
                  @edit-model="openMemberModelDialog"
                />
                      </div>
                    </Disclosure>
                  </div>
              <SessionList
                v-else-if="contextPanel === 'sessions'"
                :endpoints="currentEndpoints"
                :session-bindings="currentSessionBindings"
                :members="members"
                :actors="actors"
                :selected-id="selectedSessionId"
                :running-endpoints="runningEndpoints"
                @select="selectSession"
              />
              <InspectorPanel
                v-else
                class="inspector-embedded"
                :group-id="groupId"
                :endpoints="currentEndpoints"
                :endpoint="selectedEndpoint"
                :members="members"
                :controller="currentController"
                :actors="actors"
                :turns="turns"
                :history-rows="historyQuery.rows.value"
                :model-state="selectedModelState"
                :observations="modelsQuery.observations.value"
                :tab="activeTab"
                :loading="
                  Boolean(selectedSessionId && (activeTab === 'models' ? modelsQuery.isPending.value : historyQuery.isPending.value))
                "
                :has-next-page="inspectorHasNextPage"
                :fetching-next-page="inspectorFetchingNextPage"
                @choose-session="setContextPanel('sessions')"
                @update:tab="setTab"
                @load-more="loadInspectorMore"
                @close="closeContextPanel"
              />
            </TabsContent>
          </Tabs>
        </CollapsibleRightSidebar>
      </div>
    </main>
    <ConfirmDialog
      :open="archiveConfirm !== null"
      :title="`归档“${archiveConfirm?.name ?? ''}”？`"
      description="归档后团队不再接收消息或启动任务。"
      confirm-text="归档"
      destructive
      @confirm="runArchiveTeam"
      @cancel="archiveConfirm = null"
    />
    <MemberModelDialog
      v-model:open="modelDialogOpen"
      :member="modelDialogMember"
      @saved="onMemberModelSaved"
    />
  </div>
</template>
