<script setup lang="ts">
import { computed, provide, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useMediaQuery } from '@vueuse/core';
import { toast } from 'vue-sonner';
import { PanelRightOpen, Search } from '@lucide/vue';
import GroupSidebar from '@/app/layouts/GroupSidebar.vue';
import SettingsPage from '@/features/settings/SettingsPage.vue';
import CreateTeam from '@/features/groups/CreateTeam.vue';
import TeamHome from '@/features/groups/TeamHome.vue';
import PanelAgentPanel from '@/features/panel-agent/PanelAgentPanel.vue';
import ConversationWorkspace from '@/features/messages/ConversationWorkspace.vue';
import TeamDirectiveComposer from '@/features/messages/TeamDirectiveComposer.vue';
import SessionSwitcher from '@/features/sessions/SessionSwitcher.vue';
import TeamTraceWorkspace from '@/features/sessions/TeamTraceWorkspace.vue';
import TeamContextPanel from '@/features/team/TeamContextPanel.vue';
import ConfirmDialog from '@/components/panel/ConfirmDialog.vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useUiStore } from '@/stores/ui';
import { usePreferencesStore } from '@/stores/preferences';
import { api } from '@/shared/api/client';
import {
  BUILTIN_PLUGINS,
  builtinPlugin,
  findPluginCommand,
  type MountedPlugin,
} from '@/plugins';
import { toStreamMessageViews } from '@/features/messages/adapters';
import {
  teamConversationAfterSend,
  teamConversationSession,
} from '@/features/messages/conversation-navigation';
import { useSidebarResize } from '@/features/layout/use-sidebar-resize';
import { useReadMarker } from '@/features/messages/read-marker';
import { useUnreadIndex } from '@/features/productivity/use-unread-index';
import { useTeamResources } from '@/features/team/use-team-resources';
import { useTeamStream } from '@/features/team/use-team-stream';
import type { ContextPanel } from '@/features/team/types';
import type { InspectorTab } from '@/features/sessions/types';

/**
 * 团队工作区组合根：只做路由解析、UI 动作与组合。
 * 数据编排在 useTeamResources，团队流在 useTeamStream，右栏模板在 TeamContextPanel，
 * SSE 连接在统一流层（团队流 / panel 单例）。
 */
const route = useRoute();
const router = useRouter();
const ui = useUiStore();
const preferences = usePreferencesStore();
const compactScreen = useMediaQuery('(max-width: 760px)');
const groupId = computed(() => routeString(route.params.groupId));
const secondaryOpen = ref(Boolean(groupId.value) || route.name === 'create-team');
watch(
  [groupId, () => route.name],
  ([id, name], [prevId, prevName]) => {
    const isTeamRoute = Boolean(id) || name === 'create-team';
    const wasTeamRoute = Boolean(prevId) || prevName === 'create-team';
    if (!isTeamRoute) {
      secondaryOpen.value = false;
      return;
    }
    if (!wasTeamRoute) {
      secondaryOpen.value = true;
    }
  },
);
watch(
  () => ui.searchOpen,
  (open) => {
    if (open) secondaryOpen.value = false;
  },
);
const secondaryVisible = computed(() => secondaryOpen.value && !compactScreen.value);
provide('result-scope', computed(() => groupId.value ? { group: groupId.value } : route.name === 'panel-agent' ? { panel: '1' } : null));
watch(() => route.query.interaction, (value) => {
  if (!routeString(value) || (!route.query.session && !route.query.pair)) return;
  const query = { ...route.query };
  delete query.session;
  delete query.pair;
  void router.replace({ query });
}, { immediate: true });
type WorkspaceView = 'chat' | 'trace' | 'events' | `plugin:${string}`;
const workspaceTabs: Array<{ value: 'chat' | 'trace' | 'events'; label: string }> = [
  { value: 'chat', label: '对话' },
  { value: 'trace', label: '轨迹' },
  { value: 'events', label: '原始事件' },
];
const selectedSessionId = computed(() => teamConversationSession(route.query));
const activeTab = computed<InspectorTab>(() => 'trace');
const contextPanel = computed<ContextPanel>(() => {
  const value = routeString(route.query.panel);
  if (value === 'collaboration' || value === 'members' || value === 'tools')
    return value;
  // 兼容 v1 深链(?panel=tool:<id>):工具 tab 已合并为固定的「工具」页,统一归位。
  if (value.startsWith('tool:')) return 'tools';
  return 'collaboration';
});
const wideScreen = useMediaQuery('(min-width: 1280px)');
const contextVisible = computed(() => !ui.contextCollapsed && (wideScreen.value || ui.inspectorOpen));
const detailsVisible = computed(() => {
  const view = routeString(route.query.view);
  if (view === 'trace' || view === 'events') return true;
  if (!view) {
    const legacyPanel = routeString(route.query.panel);
    return legacyPanel === 'details' || legacyPanel === 'sessions';
  }
  return false;
});
const traceSearchQuery = ref('');
watch(groupId, () => { traceSearchQuery.value = ''; });

const resources = useTeamResources({ groupId, selectedSessionId, activeTab, contextPanel, contextVisible, detailsVisible });
const {
  allGroups, groups, archivedGroups, group, members, actors, overview, agentTasksView,
  navigationState, workspaceState, refreshResources, isPanelAgentRoute,
  isSettingsRoute, activePluginRoute, sidebarGroupId, currentModelPolicy,
  modelPolicyDefaults, homeRunningByGroup, runningEndpoints, currentControllerId,
  currentController, pausedMemberIds, currentMembers, currentEndpoints,
  selectedEndpoint, selectedPair,
  conversationTitle, endpointHosts,
  runningMemberIds,
  messagesQuery, directivesQuery,
  interactionsQuery, messageViews, turnSummaries, unaffiliatedEvents,
  turnsQuery, inspectorHasNextPage, inspectorFetchingNextPage,
  inspectorError, contextError, retryContext, loadInspectorMore,
  navPluginEntries, teamTabMounts, modelPolicySaved,
  restoreArchivedTeam,
} = resources;

const activeTeamTabMount = computed<MountedPlugin | null>(() => {
  const view = routeString(route.query.view);
  if (!view.startsWith('plugin:')) return null;
  const pluginId = view.slice('plugin:'.length);
  return teamTabMounts.value.find((entry) => entry.plugin.id === pluginId) ?? null;
});
const activeTeamTabComponent = computed(() => {
  const mount = activeTeamTabMount.value?.mount;
  return mount && mount.slot === 'team-tabs' ? mount.component : null;
});
const workspaceView = computed<WorkspaceView>(() => {
  const view = routeString(route.query.view);
  if (view === 'trace' || view === 'events' || view === 'chat') return view;
  if (view.startsWith('plugin:')) {
    return activeTeamTabMount.value ? (view as WorkspaceView) : 'chat';
  }
  // 兼容旧深链（?panel=details / ?panel=sessions）：自动映射到主区轨迹标签页。
  const legacyPanel = routeString(route.query.panel);
  if (legacyPanel === 'details' || legacyPanel === 'sessions') return 'trace';
  return 'chat';
});

// 团队流与页面同生命周期切换；消息落库后的清理在组合式函数内部完成。
const { activeStreams: activeTeamStreaming } = useTeamStream({
  groupId,
  rows: () => messagesQuery.rows.value,
  refetch: () => messagesQuery.refetch(),
});
// 左侧团队列表运行指示：聚合全量 homeQuery 与当前团队实时流，当前团队零延迟响应。
const sidebarRunningByGroup = computed<Record<string, number>>(() => {
  const counts: Record<string, number> = { ...homeRunningByGroup.value };
  if (groupId.value) {
    const streamTurns = new Set(activeTeamStreaming.value.map(item => item.turnId || item.id)).size;
    counts[groupId.value] = Math.max(runningEndpoints.value.length, streamTurns);
  }
  return counts;
});
async function stopTeamRun(memberId?: string) {
  if (!groupId.value) return;
  try {
    await api.stopTeam(groupId.value, memberId);
    await refreshResources();
  } catch (error) {
    toast.error('停止运行失败', { description: error instanceof Error ? error.message : String(error) });
  }
}
// 流视图以取值函数交给消息流:token 级更新只重渲染流式子组件,不波及已定稿消息。
const readTeamStreamViews = () => toStreamMessageViews(
  messageViews.value,
  activeTeamStreaming.value,
  selectedPair.value,
  currentControllerId.value,
);

// 最后一条消息进入视口时记「群会话读到第几号」。窗口不可见时记账函数会自己跳过。
const markRead = useReadMarker();
const unreadIndex = useUnreadIndex();
// 侧栏红点只认服务端未读投影，前端不再自己维护已读游标。
const agentUnreadCount = computed(() => unreadIndex.panelTotal.value);
function markGroupRead() {
  if (!groupId.value || !messageViews.value.length) return;
  const seq = Math.max(...messageViews.value.map((message) => message.seq));
  void markRead('group', groupId.value, seq);
}

const { resizing, beginResize, moveResize, endResize, keyboardResize } = useSidebarResize();

function routeString(value: unknown) {
  return Array.isArray(value)
    ? String(value[0] ?? '')
    : typeof value === 'string'
      ? value
      : '';
}

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

// 插件模块：左导航条目统一按注册表声明的 route / command 分发。
function openTool(id: string) {
  const plugin = builtinPlugin(id);
  const mount = plugin?.mounts.find((item) => item.slot === 'left-nav');
  if (!plugin || !mount || mount.slot !== 'left-nav') return;
  if ('command' in mount) {
    if (preferences.toolModules.disabled[id]) return;
    findPluginCommand(plugin, mount.command)?.run({ router, ui });
    return;
  }
  if (route.name === mount.route) return;
  ui.closeInspector();
  router.push({ name: mount.route });
}

function teamTabLabel(entry: MountedPlugin): string {
  return entry.mount.slot === 'team-tabs' && entry.mount.label
    ? entry.mount.label
    : entry.plugin.name;
}

function openCreateTeam() {
  ui.closeInspector();
  router.push({ name: 'create-team' });
}

function openSettingsPage() {
  router.push({ name: 'settings', query: { returnTo: route.fullPath } });
}

function closeSettingsPage() {
  const returnTo = routeString(route.query.returnTo);
  if (returnTo.startsWith('/') && !returnTo.startsWith('//')) router.push(returnTo);
  else router.push({ name: 'group' });
}

function defaultTraceSessionId(): string {
  const list = currentEndpoints.value;
  const coordination = list.find(
    (item) => item.context === 'coordination' || item.context === 'panel-coordination',
  );
  if (coordination) return coordination.id;
  return list.find((item) => item.context !== 'profile')?.id ?? '';
}

function setWorkspaceView(view: WorkspaceView) {
  const isFixed = view === 'chat' || view === 'trace' || view === 'events';
  const nextSession = isFixed
    ? (view === 'chat'
        ? selectedSessionId.value || undefined
        : (selectedSessionId.value || defaultTraceSessionId() || undefined))
    : selectedSessionId.value || undefined;
  replaceQuery({
    view: view === 'chat' ? undefined : view,
    session: nextSession,
    member: undefined,
    panel: contextPanel.value,
    tab: undefined,
  });
}

function openMemberUsage(memberId: string) {
  const target = teamTabMounts.value.find(
    (entry) => entry.mount.slot === 'team-tabs' && entry.mount.provides === 'member-usage',
  );
  if (!target) {
    const owner = BUILTIN_PLUGINS.find((plugin) =>
      plugin.mounts.some((mount) => mount.slot === 'team-tabs' && mount.provides === 'member-usage'),
    );
    toast.info(`「${owner?.name ?? '协调遥测'}」已在设置中关闭`);
    return;
  }
  replaceQuery({
    view: `plugin:${target.plugin.id}`,
    member: memberId,
    panel: contextPanel.value,
    tab: undefined,
  });
}

function selectSession(id: string) {
  replaceQuery({
    session: id || undefined,
    pair: undefined,
    interaction: undefined,
    message: undefined,
    tab: undefined,
    view: workspaceView.value === 'chat' ? undefined : workspaceView.value,
  });
}

function openMemberTrace(sessionId: string) {
  replaceQuery({
    session: sessionId || defaultTraceSessionId() || undefined,
    pair: undefined,
    interaction: undefined,
    message: undefined,
    tab: undefined,
    view: 'trace',
  });
}

function closeContextPanel() {
  ui.closeInspector();
}

function setContextPanel(panel: ContextPanel) {
  ui.openInspector();
  replaceQuery({ panel });
}

const archiveConfirm = ref<{ ids: string[]; title: string } | null>(null);

function archiveTeams(teamIds: string[]) {
  const targets = teamIds
    .map(id => allGroups.value.find(item => item.id === id))
    .filter((team): team is NonNullable<typeof team> => Boolean(team));
  if (!targets.length) return;
  archiveConfirm.value = {
    ids: targets.map(team => team.id),
    title: targets.length === 1 ? `归档“${targets[0]!.name}”？` : `归档这 ${targets.length} 个团队？`,
  };
}

async function runArchiveTeam() {
  const request = archiveConfirm.value;
  if (!request) return;
  archiveConfirm.value = null;
  const archivedIds: string[] = [];
  let lastError: unknown;
  for (const id of request.ids) {
    try {
      await api.archiveTeam(id);
      archivedIds.push(id);
    } catch (error) {
      lastError = error;
    }
  }
  if (archivedIds.length) {
    await refreshResources();
    if (groupId.value && archivedIds.includes(groupId.value)) router.push({ name: 'group' });
    if (archivedIds.length === 1) {
      const name = allGroups.value.find(item => item.id === archivedIds[0])?.name ?? archivedIds[0];
      toast.success(`已归档 ${name}`);
    } else {
      toast.success(`已归档 ${archivedIds.length} 个团队`);
    }
  }
  if (lastError) {
    toast.error('归档团队失败', { description: String(lastError) });
  }
}

function onMemberModelSaved() {
  void workspaceState.refetch();
}

/** 权限调整成功后刷新资源，让成员能力徽标与上限摘要立即反映服务端结果。 */
function onMemberPolicySaved() {
  void workspaceState.refetch();
}
</script>

<template>
  <div
    class="app-shell"
    :class="{
      'secondary-is-open': secondaryVisible,
      'is-resizing': resizing,
    }"
    :style="{
      '--sidebar-width': `${ui.sidebarWidth}px`,
      '--context-width': `${ui.contextWidth}px`,
    }"
  >
    <GroupSidebar
      v-model:secondary-open="secondaryOpen"
      :groups="groups"
      :members="members"
      :current-group-id="sidebarGroupId"
      :home-active="!isPanelAgentRoute && !isSettingsRoute && !activePluginRoute && !group"
      :tool-entries="navPluginEntries"
      :agent-active="isPanelAgentRoute"
      :agent-unread-count="agentUnreadCount"
      :settings-active="isSettingsRoute"
      :group-unread-by-team="unreadIndex.groupByTeam?.value"
      :activity-by-team="unreadIndex.activityByTeam?.value"
      :running-by-group="sidebarRunningByGroup"
      @select="selectGroup"
      @create-team="openCreateTeam"
      @archive="archiveTeams"
      @activate-tool="openTool"
      @open-agent="openPanelAgent"
      @open-settings="openSettingsPage"
    />

    <div
      v-if="secondaryVisible"
      class="sidebar-resize-handle left-resize-handle"
      role="separator"
      tabindex="0"
      aria-label="调整二级面板宽度（从右侧拖动）"
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
      <SettingsPage
        v-if="isSettingsRoute"
        :policy="currentModelPolicy"
        :defaults="modelPolicyDefaults"
        :archived-teams="archivedGroups"
        @close="closeSettingsPage"
        @saved="modelPolicySaved"
        @restore-team="restoreArchivedTeam"
      />
      <Card v-else-if="groupId && !group" class="m-4"><CardContent class="p-6 text-sm text-muted-foreground">正在读取团队…</CardContent></Card>
      <CreateTeam v-else-if="route.name === 'create-team'" />
      <!-- 插件页面：启用时渲染插件路由组件，禁用时保留路由并展示统一占位。 -->
      <template v-else-if="activePluginRoute">
        <component :is="activePluginRoute.route.component" v-if="activePluginRoute.enabled" />
        <Card v-else class="m-4"><CardContent class="p-6 text-sm text-muted-foreground">「{{ activePluginRoute.plugin.name }}」已在设置中禁用。</CardContent></Card>
      </template>
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
            'is-resizing': resizing,
          }"
        >
        <ConversationWorkspace
          :group-id="groupId"
          :heading="group.name"
          :description="group.workspace"
          :custom-body="workspaceView !== 'chat'"
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
          :on-reach-bottom="markGroupRead"
          :on-stop-run="stopTeamRun"
        >
          <template #heading-meta>
            <Badge v-if="currentController" variant="outline">{{ currentController.kind === 'panel_agent' ? 'Panel Agent 主控' : currentController.name === '主 Agent' ? '主 Agent' : currentController.name + ' · 主 Agent' }}</Badge>
            <span class="text-xs text-muted-foreground">{{ currentMembers.length }} 名成员</span>
          </template>
          <template #actions>
            <Button variant="outline" size="sm" class="xl:hidden" @click="ui.openInspector()"><PanelRightOpen />群信息</Button>
          </template>
          <template #status>
            <Alert v-if="inspectorError && (workspaceView === 'trace' || workspaceView === 'events')" variant="destructive" class="mx-4 mb-2 w-auto"><AlertDescription>{{ inspectorError.message }}</AlertDescription></Alert>
          </template>
          <template #context>
            <div
              class="flex flex-wrap items-center justify-between gap-2 px-4 pb-2"
              data-testid="workspace-view-bar"
            >
              <Tabs
                :model-value="workspaceView"
                class="gap-0"
                @update:model-value="setWorkspaceView(String($event) as WorkspaceView)"
              >
                <TabsList variant="underline" aria-label="工作区视图">
                  <TabsTrigger
                    v-for="tab in workspaceTabs"
                    :key="tab.value"
                    :value="tab.value"
                  >
                    {{ tab.label }}
                  </TabsTrigger>
                  <template v-if="teamTabMounts.length">
                    <Separator
                      orientation="vertical"
                      size="inline"
                      class="mx-1 self-center"
                      data-testid="team-tabs-separator"
                    />
                    <TabsTrigger
                      v-for="entry in teamTabMounts"
                      :key="entry.plugin.id"
                      :value="`plugin:${entry.plugin.id}`"
                      :data-team-tab-plugin="entry.plugin.id"
                    >
                      {{ teamTabLabel(entry) }}
                    </TabsTrigger>
                  </template>
                </TabsList>
              </Tabs>
              <div v-if="!activeTeamTabMount" class="flex flex-wrap items-center gap-2">
                <SessionSwitcher
                  :endpoints="currentEndpoints"
                  :members="members"
                  :actors="actors"
                  :selected-id="selectedSessionId"
                  :running-endpoints="runningEndpoints"
                  :allow-all="workspaceView === 'chat'"
                  @select="selectSession"
                />
                <div v-if="workspaceView === 'events'" class="relative w-44 sm:w-52">
                  <Search class="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                  <Input
                    v-model="traceSearchQuery"
                    type="search"
                    class="h-6 pl-7 text-xs"
                    placeholder="搜索事件名、seq 或内容…"
                    aria-label="搜索原始事件"
                  />
                </div>
              </div>
            </div>
          </template>
          <template #body>
            <component
              :is="activeTeamTabComponent"
              v-if="activeTeamTabComponent"
              :group-id="group.id"
              :selected-member-id="routeString(route.query.member) || undefined"
            />
            <TeamTraceWorkspace
              v-else-if="workspaceView === 'trace' || workspaceView === 'events'"
              :mode="workspaceView"
              :endpoints="currentEndpoints"
              :endpoint="selectedEndpoint"
              :members="members"
              :actors="actors"
              :turn-summaries="turnSummaries"
              :unaffiliated-events="unaffiliatedEvents"
              :loading="Boolean(selectedSessionId && turnsQuery.isPending.value)"
              :has-next-page="inspectorHasNextPage"
              :fetching-next-page="inspectorFetchingNextPage"
              :search-query="traceSearchQuery"
              @select-session="selectSession"
              @load-more="loadInspectorMore"
            />
          </template>
          <template #composer>
            <TeamDirectiveComposer v-if="group" :key="groupId" :group-id="groupId"
              :controller-id="currentControllerId"
              :archived="group.state === 'archived'"
              :in-coordination="Boolean(selectedPair) || Boolean(selectedEndpoint && selectedEndpoint.context !== 'coordination' && selectedEndpoint.context !== 'panel-coordination')"
              :active-session-label="conversationTitle"
              :mentions="currentMembers"
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

        <TeamContextPanel
          :group-id="groupId"
          :panel="contextPanel"
          :visible="contextVisible"
          :context-error="contextError"
          :panel-agent="overview?.panelAgent ?? null"
          :tasks-view="agentTasksView"
          :members="members"
          :current-members="currentMembers"
          :running-member-ids="runningMemberIds"
          :paused-member-ids="pausedMemberIds"
          :actors="actors"
          :current-endpoints="currentEndpoints"
          :group-policy="group?.policy ?? null"
          :group-allow-shell="group?.allow_shell ?? null"
          @update:panel="setContextPanel"
          @open-trace="openMemberTrace"
          @open-usage="openMemberUsage"
          @retry="retryContext"
          @close="closeContextPanel"
          @member-model-saved="onMemberModelSaved"
          @member-policy-saved="onMemberPolicySaved"
        />
      </div>
    </main>
    <ConfirmDialog
      :open="archiveConfirm !== null"
      :title="archiveConfirm?.title ?? ''"
      description="归档后团队不再接收消息或启动任务。"
      confirm-text="归档"
      destructive
      @confirm="runArchiveTeam"
      @cancel="archiveConfirm = null"
    />
  </div>
</template>
