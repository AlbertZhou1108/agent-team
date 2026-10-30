<script setup lang="ts">
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  computed,
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
  ChevronsLeft,
  ChevronsRight,
  AlertTriangle,
  Bot,
  MessagesSquare,
  PanelRightOpen,
} from '@lucide/vue';
import GroupSidebar from '@/app/layouts/GroupSidebar.vue';
import MemberStrip from '@/features/groups/MemberStrip.vue';
import MemberModelDialog from '@/features/groups/MemberModelDialog.vue';
import CollaborationPanel from '@/features/groups/CollaborationPanel.vue';
import TeamHome from '@/features/groups/TeamHome.vue';
import PanelAgentPanel from '@/features/panel-agent/PanelAgentPanel.vue';
import TelemetryMembersView from '@/features/telemetry/TelemetryMembersView.vue';
import SettingsDialog from '@/features/settings/SettingsDialog.vue';
import ConfirmDialog from '@/components/panel/ConfirmDialog.vue';
import { frameBatch } from '@/features/messages/frame-batch';
import { teamConversationAfterSend } from '@/features/messages/conversation-navigation';
import { useTeamDirectiveStore } from '@/stores/team-directives';
import { notifyInteraction } from '@/features/messages/interaction-notification';
import MessageFeed from '@/features/messages/MessageFeed.vue';
import TeamDirectiveComposer from '@/features/messages/TeamDirectiveComposer.vue';
import ConversationFrame from '@/components/ai-elements/ConversationFrame.vue';
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
  useOverviewQuery,
  useSnapshotQuery,
} from '@/features/queries';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useConnectionStore } from '@/stores/connection';
import {
  usePanelAgentStore,
} from '@/stores/panel-agent';
import { useUiStore } from '@/stores/ui';
import { api } from '@/shared/api/client';
import type { Group, Member, TeamStream } from '@/shared/api/raw-types';

const route = useRoute();
const router = useRouter();
const ui = useUiStore();
const connection = useConnectionStore();
const panelAgentState = usePanelAgentStore();
const overviewQuery = useOverviewQuery();
const snapshotQuery = useSnapshotQuery(() => routeString(route.params.groupId) || undefined);
const panelAgentQuery = usePanelAgentQuery(() => route.name === 'panel-agent');

// 全局数据(团队/成员/策略)来自 overview:它的 key 不含 groupId,切换团队时不会
// 重新加载,侧栏也就不会在截断请求期间退化成空列表。团队相关数据仍看 snapshot。
const overview = computed(() => overviewQuery.data.value);
const snapshot = computed(() => snapshotQuery.data.value);
const allGroups = computed(() => overview.value?.groups ?? []);
const members = computed(() => overview.value?.members ?? []);
const actors = computed(() => overview.value?.actors ?? []);
const endpoints = computed(() => snapshot.value?.endpoints ?? []);
const sessionBindings = computed(() => snapshot.value?.sessionBindings ?? []);
const runningEndpoints = computed(() => snapshot.value?.runningEndpoints ?? []);
const modelPolicyDefaults = computed(() => overview.value?.modelPolicyDefaults);
const modelDialogMember = ref<Member | null>(null);
const modelDialogOpen = ref(false);

function openMemberModelDialog(member: Member) {
  modelDialogMember.value = member;
  modelDialogOpen.value = true;
}

function onMemberModelSaved() {
  void snapshotQuery.refetch();
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

const groupId = computed(() => routeString(route.params.groupId));
const groups = computed(() =>
  allGroups.value.filter(
    (team) => team.state !== 'archived' || team.id === groupId.value,
  ),
);
const archivedGroups = computed(() =>
  allGroups.value.filter((team) => team.state === 'archived'),
);
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
  () => panelAgentQuery.data.value?.conversation ?? [],
);
const agentUnreadCount = computed(() =>
  panelAgentState.unreadForContext(panelMessages.value, '') + panelAgentState.unreadReceipts(panelAgentQuery.data.value?.requests ?? []),
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

const selectedSessionId = computed(() => routeString(route.query.session));
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
      notifyInteraction(name, item.payload.text, () => router.push({
        name: 'group',
        params: { groupId: item.group_id || groupId.value },
        query: {
          session: item.member_id
            ? endpoints.value.find(endpoint => endpoint.group_id === item.group_id && endpoint.member_id === item.member_id && endpoint.context === (requester?.role === 'lead' ? 'coordination' : 'pair:user'))?.id
            : undefined,
          interaction: item.id,
        },
      }));
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
  [() => panelAgentQuery.data.value?.requests, messageViews, pageVisible, isPanelAgentRoute, () => panelAgentState.historyVisible],
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

const runningMemberIds = computed(
  () =>
    new Set(
      currentEndpoints.value
        .filter((endpoint) => runningEndpoints.value.includes(endpoint.id))
        .map((endpoint) => endpoint.member_id),
    ),
);

const selectedModelState = computed(
  () => selectedEndpoint.value?.modelState ?? modelsQuery.state.value ?? null,
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

const inspectorError = computed(() =>
  activeTab.value === 'usage'
    ? undefined
    : activeTab.value === 'models'
      ? modelsQuery.error.value
      : historyQuery.error.value,
);

watchEffect(() => {
  // 任一路由请求失败都说明连不上本机服务;overview 也参与判断。
  const failure = overviewQuery.error.value ?? snapshotQuery.error.value;
  if (failure) connection.failed(failure);
  else if (overviewQuery.data.value && snapshotQuery.data.value) connection.online();
});

watch(
  [groups, groupId],
  ([items, id]) => {
    // 团队列表来自 overview,判断"该团队是否存在"也要等 overview 就绪。
    if (!overview.value || overviewQuery.isPending.value || !id || items.some((item) => item.id === id)) return;
    router.replace({
      name: 'group',
    });
  },
  { immediate: true },
);

watch([currentEndpoints, selectedSessionId], ([items, id]) => {
  if (!snapshot.value || snapshotQuery.isPending.value || !id || items.some((endpoint) => endpoint.id === id)) return;
  const query = { ...route.query };
  delete query.session;
  delete query.tab;
  router.replace({ query });
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
    tab: 'trace',
    panel: id ? 'details' : 'sessions',
  });
}

watch([currentEndpoints, selectedSessionId], () => {
  if (
    snapshot.value &&
    selectedSessionId.value &&
    !currentEndpoints.value.some(
      (endpoint) => endpoint.id === selectedSessionId.value,
    )
  ) {
    replaceQuery({ session: undefined, pair: undefined });
  }
});

function closeContextPanel() {
  ui.closeInspector();
}

async function modelPolicySaved() {
  await Promise.all([overviewQuery.refetch(), snapshotQuery.refetch()]);
  toast.success('全局模型策略已保存', {
    description: '将用于新团队初始角色和已有团队新增角色',
  });
}

async function restoreArchivedTeam(team: Group) {
  try {
    await api.restoreTeam(team.id);
    // 团队状态属于 overview 的数据,两路都要刷新。
    await Promise.all([overviewQuery.refetch(), snapshotQuery.refetch()]);
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
    await Promise.all([overviewQuery.refetch(), snapshotQuery.refetch()]);
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
    <main class="min-w-0 p-3 sm:p-4">
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
      <TeamHome
        v-else-if="!group && !isPanelAgentRoute"
        :groups="groups"
        :members="members"
        :endpoints="endpoints"
        :running-endpoints="runningEndpoints"
        :loading="overviewQuery.isPending.value || snapshotQuery.isPending.value"
        :error="(overviewQuery.error.value ?? snapshotQuery.error.value)?.message"
        @select="selectGroup"
        @retry="overviewQuery.refetch(); snapshotQuery.refetch()"
      />
      <PanelAgentPanel v-else-if="!group" />
      <div
        v-else
        class="workspace-shell"
        :class="{
          'context-is-collapsed': ui.contextCollapsed,
          'manager-view-open': managerConversationActive,
        }"
      >
        <ConversationFrame class="chat-window" :readonly="false">
            <header class="chat-header">
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <h1 class="truncate text-base font-semibold">
                    {{ group?.name ?? '选择或创建一个群' }}
                  </h1>
                  <Badge v-if="currentController" variant="outline">
                    {{
                      currentController.kind === 'panel_agent'
                        ? 'Panel Agent 主控'
                        : currentController.name === '主 Agent'
                          ? '主 Agent'
                          : `${currentController.name} · 主 Agent`
                    }}
                  </Badge>
                  <span class="text-xs text-muted-foreground"
                    >{{ currentMembers.length }} 名成员</span
                  >
                </div>
                <p
                  class="mt-2 truncate text-xs text-muted-foreground"
                  :title="group?.workspace"
                >
                  {{
                    group?.workspace ??
                    '团队操作面板展示共享记录，并支持向主 Agent 发送指令。'
                  }}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                class="xl:hidden"
                @click="ui.openInspector()"
              >
                <PanelRightOpen />
                群信息
              </Button>
            </header>

            <Alert
              variant="destructive"
              v-if="overviewQuery.error.value || snapshotQuery.error.value"
              class="error-banner mx-3 mb-2"
              role="alert"
              ><AlertDescription class="flex items-center gap-2">
                <AlertTriangle />
                <span class="min-w-0 flex-1">{{
                  connection.error || '无法连接本机面板服务。'
                }}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  @click="overviewQuery.refetch(); snapshotQuery.refetch()"
                  >重试</Button
                >
              </AlertDescription></Alert
            >
            <Alert
              variant="destructive"
              v-if="inspectorError"
              class="error-banner mx-3 mb-2"
              role="alert"
              ><AlertDescription class="flex items-center gap-2">
                <AlertTriangle />
                <span class="min-w-0 flex-1">{{ inspectorError.message }}</span>
              </AlertDescription></Alert
            >

            <div
              v-if="overviewQuery.isPending.value || snapshotQuery.isPending.value"
              class="empty-state m-3 min-h-[60vh]"
            >
              正在连接本机群总线…
            </div>
            <div
              v-else-if="!groups.length"
              class="empty-state m-3 min-h-[60vh]"
            >
              还没有群。请先在 CLI 中创建群，这里会自动显示。
            </div>
            <template v-else>
              <Alert v-if="messagesQuery.isError.value" variant="destructive" class="m-3 w-auto">
                <AlertDescription class="flex items-center justify-between gap-2">
                  <span>消息同步失败，当前显示的是已缓存记录。</span>
                  <Button variant="outline" size="sm" @click="messagesQuery.refetch()">重试同步</Button>
                </AlertDescription>
              </Alert>
              <MessageFeed
                :key="`${groupId}:${selectedSessionId}`"
                class="chat-feed"
                :messages="messageViews"
                :stream-source="readTeamStreamViews"
                :directives="directivesQuery.data.value ?? []"
                :interactions="interactionsQuery.data.value ?? []"
                :title="conversationTitle"
                :selected-pair="selectedPair"
                :hosts="endpointHosts"
                :group-names="Object.fromEntries(groups.map(group => [group.id, group.name]))"
                :loading="messagesQuery.isPending.value"
                :has-next-page="messagesQuery.hasNextPage.value"
                :fetching-next-page="messagesQuery.isFetchingNextPage.value"
                @load-more="messagesQuery.fetchNextPage()"
              />
            </template>
          <template #composer>
            <TeamDirectiveComposer v-if="group" :key="groupId" :group-id="groupId"
              :controller-id="currentControllerId"
              :archived="group.state === 'archived'" :receipts="directivesQuery.data.value ?? []"
              @sent="router.replace({ query: teamConversationAfterSend(route.query) })" />
          </template>
        </ConversationFrame>

        <button
          v-if="ui.inspectorOpen"
          type="button"
          class="inspector-backdrop xl:hidden"
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
        <Card
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
            <div v-else class="context-tabs">
              <Button
                v-for="item in contextTabs"
                :key="item.value"
                :variant="contextPanel === item.value ? 'secondary' : 'ghost'"
                size="icon"
                :aria-label="item.label"
                :title="item.label"
                @click="setContextPanel(item.value)"
                ><component :is="item.icon"
              /></Button>
            </div>
            <TabsContent
              v-if="contextVisible"
              :value="contextPanel"
              class="context-scroll"
            >
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
                <details class="text-sm text-muted-foreground">
                  <summary class="w-fit cursor-pointer">成员资料与模型（{{ currentMembers.length }}）</summary>
                  <div class="mt-3">
                <MemberStrip
                  :members="currentMembers"
                  :running-member-ids="runningMemberIds"
                  :paused-member-ids="pausedMemberIds"
                  @edit-model="openMemberModelDialog"
                />
                      </div>
                    </details>
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
          <Button
            variant="ghost"
            size="sm"
            class="context-collapse-toggle hidden xl:inline-flex"
            :title="ui.contextCollapsed ? '展开右侧栏' : '收起右侧栏'"
            :aria-label="ui.contextCollapsed ? '展开右侧栏' : '收起右侧栏'"
            :aria-expanded="!ui.contextCollapsed"
            @click="ui.toggleContext()"
          >
            <ChevronsLeft v-if="ui.contextCollapsed" />
            <ChevronsRight v-else />
            <span v-if="!ui.contextCollapsed">收起</span>
          </Button>
        </Card>
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
