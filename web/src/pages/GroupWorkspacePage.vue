<script setup lang="ts">
import { computed, provide, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useMediaQuery } from '@vueuse/core';
import { toast } from 'vue-sonner';
import { PanelRightOpen } from '@lucide/vue';
import GroupSidebar from '@/app/layouts/GroupSidebar.vue';
import SettingsDialog from '@/features/settings/SettingsDialog.vue';
import CreateTeam from '@/features/groups/CreateTeam.vue';
import TeamHome from '@/features/groups/TeamHome.vue';
import PanelAgentPanel from '@/features/panel-agent/PanelAgentPanel.vue';
import ConversationWorkspace from '@/features/messages/ConversationWorkspace.vue';
import TeamDirectiveComposer from '@/features/messages/TeamDirectiveComposer.vue';
import TeamContextPanel from '@/features/team/TeamContextPanel.vue';
import ConfirmDialog from '@/components/panel/ConfirmDialog.vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useUiStore } from '@/stores/ui';
import { api } from '@/shared/api/client';
import { builtinTool } from '@/tools';
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
const groupId = computed(() => routeString(route.params.groupId));
provide('result-scope', computed(() => groupId.value ? { group: groupId.value } : route.name === 'panel-agent' ? { panel: '1' } : null));
watch(() => route.query.interaction, (value) => {
  if (!routeString(value) || (!route.query.session && !route.query.pair)) return;
  const query = { ...route.query };
  delete query.session;
  delete query.pair;
  void router.replace({ query });
}, { immediate: true });
const selectedSessionId = computed(() => teamConversationSession(route.query));
const activeTab = computed<InspectorTab>(() => {
  // 旧深链的 events/models 标签已并入轨迹页(原始事件折叠区/成员页),统一归位。
  return routeString(route.query.tab) === 'usage' ? 'usage' : 'trace';
});
const contextPanel = computed<ContextPanel>(() => {
  const value = routeString(route.query.panel);
  if (value === 'collaboration' || value === 'members' || value === 'sessions' || value === 'details' || value === 'tools')
    return value;
  // 兼容 v1 深链(?panel=tool:<id>):工具 tab 已合并为固定的「工具」页,统一归位。
  if (value.startsWith('tool:')) return 'tools';
  return selectedSessionId.value ? 'details' : 'collaboration';
});
const wideScreen = useMediaQuery('(min-width: 1280px)');
const contextVisible = computed(() => !ui.contextCollapsed && (wideScreen.value || ui.inspectorOpen));
const detailsVisible = computed(() => contextVisible.value && contextPanel.value === 'details');

const resources = useTeamResources({ groupId, selectedSessionId, activeTab, contextPanel, contextVisible, detailsVisible });
const {
  allGroups, groups, archivedGroups, group, members, actors, overview, agentTasksView,
  navigationState, workspaceState, refreshResources, isPanelAgentRoute,
  isSettingsRoute, isNotesRoute, sidebarGroupId, currentModelPolicy,
  modelPolicyDefaults, homeRunningByGroup, runningEndpoints, currentControllerId,
  currentController, pausedMemberIds, currentMembers, currentEndpoints,
  currentSessionBindings, selectedEndpoint, selectedPair,
  conversationTitle, endpointHosts,
  runningMemberIds,
  panelMessages, receiptRequests, messagesQuery, directivesQuery,
  interactionsQuery, messageViews, turnSummaries, unaffiliatedEvents,
  turnsQuery, inspectorHasNextPage, inspectorFetchingNextPage,
  inspectorError, contextError, retryContext, loadInspectorMore, notesTool,
  navToolEntries, notesPageComponent, notesEnabled, modelPolicySaved,
  restoreArchivedTeam,
} = resources;

// 团队流与页面同生命周期切换；消息落库后的清理在组合式函数内部完成。
const { activeStreams: activeTeamStreaming } = useTeamStream({
  groupId,
  rows: () => messagesQuery.rows.value,
  refetch: () => messagesQuery.refetch(),
});
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

// 工具模块:左导航条目与启用状态全部由注册表 + 用户偏好推导。
function openTool(id: string) {
  // 路由属于 left-nav 挂载:工具的其他形态(浮层/内嵌)没有自己的页面。
  const routeName = builtinTool(id)?.mounts.find((mount) => mount.slot === 'left-nav')?.routeName;
  if (!routeName || route.name === routeName) return;
  ui.closeInspector();
  router.push({ name: routeName });
}

function openSettingsPage() {
  router.push({ name: 'settings', query: { returnTo: route.fullPath } });
}

function closeSettingsPage() {
  const returnTo = routeString(route.query.returnTo);
  if (returnTo.startsWith('/') && !returnTo.startsWith('//')) router.push(returnTo);
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

function setTab(tab: InspectorTab) {
  replaceQuery({ tab, panel: 'details' });
}

function setContextPanel(panel: ContextPanel) {
  ui.openInspector();
  replaceQuery({ panel });
}

const archiveConfirm = ref<{ id: string; name: string } | null>(null);

function archiveTeam(teamId: string) {
  const team = allGroups.value.find((item) => item.id === teamId);
  if (!team) return;
  archiveConfirm.value = { id: team.id, name: team.name };
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

function onMemberModelSaved() {
  void workspaceState.refetch();
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
      :home-active="!isPanelAgentRoute && !isSettingsRoute && !isNotesRoute && !group"
      :tool-entries="navToolEntries"
      :agent-active="isPanelAgentRoute"
      :agent-unread-count="agentUnreadCount"
      :settings-active="isSettingsRoute"
      @select="selectGroup"
      @archive="archiveTeam"
      @activate-tool="openTool"
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
      <!-- 工具页面:启用时渲染工具组件,禁用时保留路由但给出占位。 -->
      <template v-else-if="isNotesRoute">
        <component :is="notesPageComponent" v-if="notesEnabled" />
        <Card v-else class="m-4"><CardContent class="p-6 text-sm text-muted-foreground">「{{ notesTool.name }}」已在设置中禁用。</CardContent></Card>
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
          :on-reach-bottom="markGroupRead"
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
          :current-session-bindings="currentSessionBindings"
          :selected-session-id="selectedSessionId"
          :running-endpoints="runningEndpoints"
          :selected-endpoint="selectedEndpoint"
          :current-controller="currentController"
          :turn-summaries="turnSummaries"
          :unaffiliated-events="unaffiliatedEvents"
          :active-tab="activeTab"
          :loading="Boolean(selectedSessionId && turnsQuery.isPending.value)"
          :has-next-page="inspectorHasNextPage"
          :fetching-next-page="inspectorFetchingNextPage"
          @update:panel="setContextPanel"
          @update:tab="setTab"
          @select-session="selectSession"
          @choose-session="setContextPanel('sessions')"
          @retry="retryContext"
          @load-more="loadInspectorMore"
          @close="closeContextPanel"
          @member-model-saved="onMemberModelSaved"
        />
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
  </div>
</template>
