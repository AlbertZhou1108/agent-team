<script setup lang="ts">
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
import {
  Activity,
  ChevronsLeft,
  ChevronsRight,
  AlertTriangle,
  Bot,
  MessagesSquare,
  PanelRightOpen,
  Target,
} from '@lucide/vue';
import GroupSidebar from '@/app/layouts/GroupSidebar.vue';
import MemberStrip from '@/features/groups/MemberStrip.vue';
import CollaborationPanel from '@/features/groups/CollaborationPanel.vue';
import GoalLifecyclePanel from '@/features/groups/GoalLifecyclePanel.vue';
import TeamHome from '@/features/groups/TeamHome.vue';
import PanelAgentPanel from '@/features/panel-agent/PanelAgentPanel.vue';
import SettingsDialog from '@/features/settings/SettingsDialog.vue';
import MessageFeed from '@/features/messages/MessageFeed.vue';
import SessionList from '@/features/sessions/SessionList.vue';
import InspectorPanel from '@/features/sessions/InspectorPanel.vue';
import type { InspectorTab } from '@/features/sessions/types';
import { toMessageViews } from '@/features/messages/adapters';
import { buildTurns } from '@/features/traces/reducer';
import {
  useHistoryQuery,
  useMessagesQuery,
  useModelsQuery,
  usePanelAgentQuery,
  useSnapshotQuery,
} from '@/features/queries';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useConnectionStore } from '@/stores/connection';
import {
  countUnreadPanelMessages,
  usePanelAgentStore,
} from '@/stores/panel-agent';
import { useUiStore } from '@/stores/ui';
import { api } from '@/shared/api/client';
import type { Group } from '@/shared/api/raw-types';

const route = useRoute();
const router = useRouter();
const ui = useUiStore();
const connection = useConnectionStore();
const panelAgentState = usePanelAgentStore();
const snapshotQuery = useSnapshotQuery();
const panelAgentQuery = usePanelAgentQuery();

const snapshot = computed(() => snapshotQuery.data.value);
const allGroups = computed(() => snapshot.value?.groups ?? []);
const members = computed(() => snapshot.value?.members ?? []);
const actors = computed(() => snapshot.value?.actors ?? []);
const endpoints = computed(() => snapshot.value?.endpoints ?? []);
const sessionBindings = computed(() => snapshot.value?.sessionBindings ?? []);
const runningEndpoints = computed(() => snapshot.value?.runningEndpoints ?? []);
const modelPolicyDefaults = computed(() => snapshot.value?.modelPolicyDefaults);

function routeString(value: unknown) {
  return Array.isArray(value) ? String(value[0] ?? '') : typeof value === 'string' ? value : '';
}

const groupId = computed(() => routeString(route.params.groupId));
const groups = computed(() => allGroups.value.filter(team => (
  team.state !== 'archived' || team.id === groupId.value
)));
const archivedGroups = computed(() => allGroups.value.filter(team => team.state === 'archived'));
const isPanelAgentRoute = computed(() => route.name === 'panel-agent');
const isSettingsRoute = computed(() => route.name === 'settings');
const group = computed(() => groups.value.find(item => item.id === groupId.value));
const pageVisible = ref(
  typeof document !== 'undefined'
  && document.visibilityState === 'visible'
  && document.hasFocus(),
);
const panelMessages = computed(
  () => panelAgentQuery.data.value?.conversation ?? [],
);
const latestPanelSeq = computed(
  () => panelMessages.value.at(-1)?.seq ?? 0,
);
const agentUnreadCount = computed(() => (
  isPanelAgentRoute.value && pageVisible.value
    ? 0
    : countUnreadPanelMessages(
        panelMessages.value,
        panelAgentState.lastReadSeq,
      )
));

function updatePageVisibility() {
  pageVisible.value = (
    document.visibilityState === 'visible'
    && document.hasFocus()
  );
}

watch(
  [latestPanelSeq, isPanelAgentRoute, pageVisible],
  ([seq, onAgent, visible]) => {
    if (!seq) return;
    if (panelAgentState.lastReadSeq == null || (onAgent && visible)) {
      panelAgentState.markPanelRead(seq);
    }
  },
  { immediate: true },
);

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

const currentControllerId = computed(() => (
  snapshot.value?.panelTeams.find(team => team.id === groupId.value)?.controller.id
  ?? group.value?.lead
  ?? undefined
));
const currentController = computed(() => (
  snapshot.value?.panelTeams.find(team => team.id === groupId.value)?.controller
  ?? (() => {
    const lead = members.value.find(member => member.id === group.value?.lead);
    return lead ? { id: lead.id, name: lead.name, kind: 'member' as const } : null;
  })()
));
const sidebarGroupId = computed(() => (
  isPanelAgentRoute.value ? routeString(route.query.team) || undefined : group.value?.id
));
const pausedMemberIds = computed(() => new Set(
  currentController.value?.kind === 'panel_agent'
    ? [snapshot.value?.panelTeams.find(team => team.id === groupId.value)?.controller.assignment?.original_lead_id]
      .filter((id): id is string => Boolean(id))
    : [],
));
const currentMembers = computed(() => members.value.filter(member => member.group_id === groupId.value && !member.removed));
const currentEndpoints = computed(() => endpoints.value.filter(endpoint => endpoint.group_id === groupId.value && endpoint.context !== 'profile'));
const currentSessionBindings = computed(() => {
  const ids = new Set(currentEndpoints.value.map(endpoint => endpoint.id));
  return sessionBindings.value.filter(binding => ids.has(binding.endpoint_id));
});
const currentRunningEndpoints = computed(() => {
  const ids = new Set(currentEndpoints.value.map(endpoint => endpoint.id));
  return runningEndpoints.value.filter(id => ids.has(id));
});
const currentModelPolicy = computed(() => (
  snapshot.value?.modelPolicy
));

const selectedSessionId = computed(() => routeString(route.query.session));
const selectedEndpoint = computed(() => currentEndpoints.value.find(endpoint => endpoint.id === selectedSessionId.value));
const selectedPair = computed(() => {
  const endpoint = selectedEndpoint.value;
  return endpoint?.peer ? [endpoint.member_id, endpoint.peer].sort().join(':') : '';
});
const conversationTitle = computed(() => {
  const endpoint = selectedEndpoint.value;
  if (!endpoint) return '全部群消息';
  const name = (id: string) => members.value.find(member => member.id === id)?.name ?? id;
  return endpoint.peer ? `${name(endpoint.member_id)} ↔ ${name(endpoint.peer)}` : `${name(endpoint.member_id)} · 统一调度`;
});
const activeTab = computed<InspectorTab>(() => {
  const value = routeString(route.query.tab);
  return value === 'events' || value === 'models' ? value : 'trace';
});
type ContextPanel = 'goals' | 'members' | 'sessions' | 'details' | 'collaboration';
const contextPanel = computed<ContextPanel>(() => {
  const value = routeString(route.query.panel);
  if (value === 'goals' || value === 'members' || value === 'sessions' || value === 'details' || value === 'collaboration') return value;
  return selectedSessionId.value ? 'details' : 'goals';
});
const contextTabs: Array<{ value: ContextPanel; label: string; icon: typeof Bot }> = [
  { value: 'goals', label: '任务', icon: Target },
  { value: 'collaboration', label: '协作', icon: Activity },
  { value: 'members', label: '成员', icon: Bot },
  { value: 'sessions', label: '会话', icon: MessagesSquare },
  { value: 'details', label: '详情', icon: Activity },
];

const messagesQuery = useMessagesQuery(() => groupId.value || undefined);
const historyQuery = useHistoryQuery(() => selectedSessionId.value || undefined);
const modelsQuery = useModelsQuery(() => selectedSessionId.value || undefined);

const messageViews = computed(() => {
  const endpoint = selectedEndpoint.value;
  const rows = endpoint && !endpoint.peer
    ? messagesQuery.rows.value.filter(row => row.sender === endpoint.member_id || row.recipient === endpoint.member_id)
    : messagesQuery.rows.value;
  return toMessageViews(rows, members.value, actors.value, currentControllerId.value);
});
const endpointHosts = computed(() => Object.fromEntries(
  currentEndpoints.value.map(endpoint => {
    const member = members.value.find(item => item.id === endpoint.member_id);
    const panelHost = endpoint.member_id === snapshot.value?.panelAgent?.id
      ? snapshot.value?.panelAgent?.host
      : undefined;
    return [endpoint.id, member?.host ?? panelHost ?? 'unknown'];
  }),
) as Record<string, 'codex' | 'claude' | 'dsh' | 'unknown'>);

const turns = computed(() => buildTurns(historyQuery.rows.value, {
  hosts: endpointHosts.value,
  running: selectedSessionId.value ? runningEndpoints.value.includes(selectedSessionId.value) : false,
}));

const runningMemberIds = computed(() => new Set(
  currentEndpoints.value
    .filter(endpoint => runningEndpoints.value.includes(endpoint.id))
    .map(endpoint => endpoint.member_id),
));

const selectedModelState = computed(() => (
  selectedEndpoint.value?.modelState ?? modelsQuery.state.value ?? null
));

const inspectorHasNextPage = computed(() => (
  activeTab.value === 'models'
    ? modelsQuery.hasNextPage.value
    : historyQuery.hasNextPage.value
));
const inspectorFetchingNextPage = computed(() => (
  activeTab.value === 'models'
    ? modelsQuery.isFetchingNextPage.value
    : historyQuery.isFetchingNextPage.value
));

const inspectorError = computed(() => (
  activeTab.value === 'models' ? modelsQuery.error.value : historyQuery.error.value
));

watchEffect(() => {
  if (snapshotQuery.data.value) connection.online();
  else if (snapshotQuery.error.value) connection.failed(snapshotQuery.error.value);
});

watch(
  [groups, groupId],
  ([items, id]) => {
    if (!id || (items.length && items.some(item => item.id === id))) return;
    router.replace({
      name: 'group',
    });
  },
  { immediate: true },
);

watch(
  [currentEndpoints, selectedSessionId],
  ([items, id]) => {
    if (!id || items.some(endpoint => endpoint.id === id)) return;
    const query = { ...route.query };
    delete query.session;
    delete query.tab;
    router.replace({ query });
  },
);

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
  if (returnTo.startsWith('/') && !returnTo.startsWith('//')) router.push(returnTo);
  else router.push({ name: 'group' });
}

function selectSession(id: string) {
  ui.openInspector();
  replaceQuery({ session: id || undefined, pair: undefined, tab: 'trace', panel: 'sessions' });
}

function openPanelAgentForTeam() {
  router.push({
    name: 'panel-agent',
    query: { team: groupId.value },
  });
}

watch([currentEndpoints, selectedSessionId], () => {
  if (snapshot.value && selectedSessionId.value && !currentEndpoints.value.some(endpoint => endpoint.id === selectedSessionId.value)) {
    replaceQuery({ session: undefined, pair: undefined });
  }
});

function closeContextPanel() {
  ui.closeInspector();
}

async function modelPolicySaved() {
  await snapshotQuery.refetch();
  toast.success('全局模型策略已保存', { description: '将用于新团队初始角色和已有团队新增角色' });
}

async function restoreArchivedTeam(team: Group) {
  try {
    await api.restoreTeamGoals(team.id, {
      revision: team.revision ?? 1,
      operationId: globalThis.crypto?.randomUUID?.()
        ?? `restore-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    });
    await snapshotQuery.refetch();
    toast.success(`已恢复 ${team.name}`);
  } catch (error) {
    toast.error('恢复团队失败', { description: String(error) });
  }
}

async function archiveTeam(teamId: string) {
  const team = allGroups.value.find(item => item.id === teamId);
  if (!team || !window.confirm(`归档“${team.name}”？归档后团队不再接收消息或启动任务。`)) return;
  try {
    await api.archiveTeamGoals(team.id, {
      revision: team.revision ?? 1,
      operationId: globalThis.crypto?.randomUUID?.()
        ?? `archive-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    });
    await snapshotQuery.refetch();
    if (groupId.value === team.id) router.push({ name: 'group' });
    toast.success(`已归档 ${team.name}`);
  } catch (error) {
    toast.error('归档团队失败', { description: String(error) });
  }
}

function setTab(tab: InspectorTab) {
  replaceQuery({ tab, panel: 'details' });
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
  const other = side === 'left'
    ? (ui.contextCollapsed ? 60 : ui.contextWidth)
    : (ui.sidebarCollapsed ? 76 : ui.sidebarWidth);
  const max = Math.max(side === 'left' ? 180 : 280, window.innerWidth - other - 420);
  if (side === 'left') ui.sidebarWidth = Math.round(Math.max(180, Math.min(400, max, width)));
  else ui.contextWidth = Math.round(Math.max(280, Math.min(680, max, width)));
}
function beginResize(event: PointerEvent, side: 'left' | 'right') {
  if (event.button !== 0) return;
  const handle = event.currentTarget as HTMLElement;
  handle.setPointerCapture(event.pointerId);
  drag = { side, x: event.clientX, width: side === 'left' ? ui.sidebarWidth : ui.contextWidth };
  resizing.value = true;
  event.preventDefault();
}
function moveResize(event: PointerEvent) {
  if (!drag) return;
  resizeWidth(drag.side, drag.width + (event.clientX - drag.x) * (drag.side === 'left' ? 1 : -1));
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
  resizeWidth(side, (side === 'left' ? ui.sidebarWidth : ui.contextWidth) + direction * (side === 'left' ? 16 : -16));
  ui.persist();
}

</script>

<template>
  <div class="app-shell" :class="{ 'sidebar-is-collapsed': ui.sidebarCollapsed, 'is-resizing': resizing }"
    :style="{ '--sidebar-width': `${ui.sidebarWidth}px`, '--context-width': `${ui.contextWidth}px` }"
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

    <div v-if="!ui.sidebarCollapsed" class="sidebar-resize-handle left-resize-handle"
      role="separator" tabindex="0" aria-label="调整左侧栏宽度" aria-orientation="vertical"
      :aria-valuenow="ui.sidebarWidth" :aria-valuemin="180" :aria-valuemax="400"
      @pointerdown="beginResize($event, 'left')" @pointermove="moveResize" @pointerup="endResize"
      @pointercancel="endResize" @lostpointercapture="endResize" @keydown="keyboardResize($event, 'left')"
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
        :loading="snapshotQuery.isPending.value"
        :error="snapshotQuery.error.value?.message"
        @select="selectGroup"
        @retry="snapshotQuery.refetch()"
      />
      <PanelAgentPanel v-else-if="!group" />
      <div v-else class="workspace-shell" :class="{ 'context-is-collapsed': ui.contextCollapsed }">
        <section class="chat-window panel">
          <header class="chat-header">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <h1 class="truncate text-base font-semibold">
                  {{ group?.name ?? '选择或创建一个群' }}
                </h1>
                <Badge v-if="currentController">
                  {{ currentController.kind === 'panel_agent' ? 'Panel Agent 主控' : `${currentController.name} · 主 Agent` }}
                </Badge>
                <Badge>{{ currentMembers.length }} 名成员</Badge>
                <Badge v-if="currentRunningEndpoints.length" variant="accent">
                  {{ currentRunningEndpoints.length }} 个运行中
                </Badge>
              </div>
              <p class="mt-1 truncate font-mono text-[10px] text-dim">
                {{ group?.workspace ?? '团队观测页只读展示共享记录；私人交互由 Panel Agent 提供。' }}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              class="xl:hidden"
              @click="ui.openInspector()"
            >
              <PanelRightOpen :size="14" />
              群信息
            </Button>
            <Button
              v-if="currentController?.kind === 'panel_agent'"
              variant="outline"
              size="sm"
              @click="openPanelAgentForTeam"
            >
              <Bot :size="14" />
              Panel Agent
            </Button>

          </header>

          <div class="chat-notice">
            <span class="status-dot status-online" />
            <span>{{ messagesQuery.rows.value.length }} 条群消息</span>
          </div>

          <div v-if="snapshotQuery.error.value" class="error-banner mx-3 mb-2" role="alert">
            <AlertTriangle :size="16" />
            <span class="min-w-0 flex-1">{{ connection.error || '无法连接本机面板服务。' }}</span>
            <Button variant="ghost" size="sm" @click="snapshotQuery.refetch()">重试</Button>
          </div>
          <div v-if="inspectorError" class="error-banner mx-3 mb-2" role="alert">
            <AlertTriangle :size="16" />
            <span class="min-w-0 flex-1">{{ inspectorError.message }}</span>
          </div>

          <div v-if="snapshotQuery.isPending.value" class="empty-state m-3 min-h-[60vh]">
            正在连接本机群总线…
          </div>
          <div v-else-if="!groups.length" class="empty-state m-3 min-h-[60vh]">
            还没有群。请先在 CLI 中创建群，这里会自动显示。
          </div>
          <template v-else>
            <MessageFeed
              :key="`${groupId}:${selectedSessionId}`"
              class="chat-feed"
              :messages="messageViews"
              :title="conversationTitle"
              :selected-pair="selectedPair"
              :hosts="endpointHosts"
              :loading="messagesQuery.isPending.value"
              :has-next-page="messagesQuery.hasNextPage.value"
              :fetching-next-page="messagesQuery.isFetchingNextPage.value"
              @load-more="messagesQuery.fetchNextPage()"
            />
            <footer class="chat-footer">
              <span>{{ conversationTitle }}</span>
              <span class="text-dim">·</span>
              <span>{{ connection.lastSyncedAt?.toLocaleTimeString('zh-CN') ?? '等待同步' }}</span>
            </footer>
          </template>
        </section>

        <button
          v-if="ui.inspectorOpen"
          type="button"
          class="inspector-backdrop xl:hidden"
          aria-label="关闭群信息"
          @click="closeContextPanel"
        />

        <div v-if="!ui.contextCollapsed" class="sidebar-resize-handle right-resize-handle"
          role="separator" tabindex="0" aria-label="调整右侧栏宽度" aria-orientation="vertical"
          :aria-valuenow="ui.contextWidth" :aria-valuemin="280" :aria-valuemax="680"
          @pointerdown="beginResize($event, 'right')" @pointermove="moveResize" @pointerup="endResize"
          @pointercancel="endResize" @lostpointercapture="endResize" @keydown="keyboardResize($event, 'right')"
        />
        <aside :class="['context-panel', ui.inspectorOpen && 'context-panel-open', ui.contextCollapsed && 'context-panel-collapsed']">
          <header v-show="!ui.contextCollapsed" class="context-header">
            <div class="min-w-0">
              <h2 class="mt-1 truncate text-sm font-medium">群状态</h2>
            </div>
            <Badge>{{ currentMembers.length }} 人</Badge>
            <Button variant="ghost" size="icon" class="xl:hidden" @click="closeContextPanel">
              <span class="text-lg leading-none">×</span>
            </Button>
          </header>
          <div class="context-tabs">
            <button
              v-for="item in contextTabs"
              :key="item.value"
              :title="item.label"
              :aria-label="item.label"
              :aria-pressed="contextPanel === item.value"
              type="button"
              :class="['context-tab', contextPanel === item.value && 'context-tab-active']"
              @click="setContextPanel(item.value)"
            >
              <component :is="item.icon" :size="13" />
              <span v-if="!ui.contextCollapsed">{{ item.label }}</span>
            </button>
          </div>
          <div v-show="!ui.contextCollapsed" class="context-scroll">
            <GoalLifecyclePanel v-if="contextPanel === 'goals'" :team-id="groupId" />
            <CollaborationPanel v-else-if="contextPanel === 'collaboration'" :group-id="groupId" :members="members" />
            <MemberStrip
              v-else-if="contextPanel === 'members'"
              :members="currentMembers"
              :running-member-ids="runningMemberIds"
              :paused-member-ids="pausedMemberIds"
            />
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
              :endpoint="selectedEndpoint"
              :members="members"
              :actors="actors"
              :turns="turns"
              :history-rows="historyQuery.rows.value"
              :model-state="selectedModelState"
              :observations="modelsQuery.observations.value"
              :tab="activeTab"
              :loading="Boolean(selectedSessionId && historyQuery.isPending.value)"
              :has-next-page="inspectorHasNextPage"
              :fetching-next-page="inspectorFetchingNextPage"
              @update:tab="setTab"
              @load-more="loadInspectorMore"
              @close="closeContextPanel"
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            class="context-collapse-toggle hidden text-dim xl:inline-flex"
            :title="ui.contextCollapsed ? '展开右侧栏' : '收起右侧栏'"
            :aria-label="ui.contextCollapsed ? '展开右侧栏' : '收起右侧栏'"
            :aria-expanded="!ui.contextCollapsed"
            @click="ui.toggleContext()"
          >
            <ChevronsLeft v-if="ui.contextCollapsed" :size="15" />
            <ChevronsRight v-else :size="15" />
            <span v-if="!ui.contextCollapsed">收起</span>
          </Button>
        </aside>
      </div>
    </main>
  </div>
</template>
