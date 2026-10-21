<script setup lang="ts">
import {
  computed,
  watch,
  watchEffect,
} from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { toast } from 'vue-sonner';
import {
  Activity,
  AlertTriangle,
  Bot,
  MessagesSquare,
  PanelRightOpen,
  RefreshCw,
} from '@lucide/vue';
import GroupSidebar from '@/app/layouts/GroupSidebar.vue';
import MemberStrip from '@/features/groups/MemberStrip.vue';
import CollaborationPanel from '@/features/groups/CollaborationPanel.vue';
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
  useSnapshotQuery,
} from '@/features/queries';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useConnectionStore } from '@/stores/connection';
import { useUiStore } from '@/stores/ui';

const route = useRoute();
const router = useRouter();
const ui = useUiStore();
const connection = useConnectionStore();
const snapshotQuery = useSnapshotQuery();

const snapshot = computed(() => snapshotQuery.data.value);
const groups = computed(() => snapshot.value?.groups ?? []);
const members = computed(() => snapshot.value?.members ?? []);
const endpoints = computed(() => snapshot.value?.endpoints ?? []);
const sessionBindings = computed(() => snapshot.value?.sessionBindings ?? []);
const runningEndpoints = computed(() => snapshot.value?.runningEndpoints ?? []);

function routeString(value: unknown) {
  return Array.isArray(value) ? String(value[0] ?? '') : typeof value === 'string' ? value : '';
}

const groupId = computed(() => routeString(route.params.groupId));
const group = computed(() => groups.value.find(item => item.id === groupId.value));
const currentMembers = computed(() => members.value.filter(member => member.group_id === groupId.value && !member.removed));
const currentEndpoints = computed(() => endpoints.value.filter(endpoint => endpoint.group_id === groupId.value));
const currentSessionBindings = computed(() => {
  const ids = new Set(currentEndpoints.value.map(endpoint => endpoint.id));
  return sessionBindings.value.filter(binding => ids.has(binding.endpoint_id));
});
const currentRunningEndpoints = computed(() => {
  const ids = new Set(currentEndpoints.value.map(endpoint => endpoint.id));
  return runningEndpoints.value.filter(id => ids.has(id));
});

const selectedSessionId = computed(() => routeString(route.query.session));
const selectedEndpoint = computed(() => currentEndpoints.value.find(endpoint => endpoint.id === selectedSessionId.value));
const selectedPair = computed(() => routeString(route.query.pair));
const activeTab = computed<InspectorTab>(() => {
  const value = routeString(route.query.tab);
  return value === 'events' || value === 'models' ? value : 'trace';
});
type ContextPanel = 'members' | 'sessions' | 'details' | 'collaboration';
const contextPanel = computed<ContextPanel>(() => {
  const value = routeString(route.query.panel);
  if (value === 'members' || value === 'sessions' || value === 'details' || value === 'collaboration') return value;
  return selectedSessionId.value ? 'details' : 'members';
});
const contextTabs: Array<{ value: ContextPanel; label: string; icon: typeof Bot }> = [
  { value: 'collaboration', label: '协作', icon: Activity },
  { value: 'members', label: '成员', icon: Bot },
  { value: 'sessions', label: '会话', icon: MessagesSquare },
  { value: 'details', label: '详情', icon: Activity },
];

const messagesQuery = useMessagesQuery(() => groupId.value || undefined);
const historyQuery = useHistoryQuery(() => selectedSessionId.value || undefined);
const modelsQuery = useModelsQuery(() => selectedSessionId.value || undefined);

const messageViews = computed(() => toMessageViews(messagesQuery.rows.value, members.value));
const endpointHosts = computed(() => Object.fromEntries(
  currentEndpoints.value.map(endpoint => {
    const member = members.value.find(item => item.id === endpoint.member_id);
    return [endpoint.id, member?.host ?? 'unknown'];
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
    if (!items.length || (id && items.some(item => item.id === id))) return;
    router.replace({
      name: 'group',
      params: { groupId: items[0].id },
      query: route.query,
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
  router.push({ name: 'group', params: { groupId: id } });
}

function selectSession(id: string) {
  ui.openInspector();
  replaceQuery({ session: id, tab: 'trace', panel: 'details' });
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

async function loadInspectorMore() {
  try {
    if (activeTab.value === 'models') await modelsQuery.fetchNextPage();
    else await historyQuery.fetchNextPage();
  } catch (error) {
    toast.error('加载更多事件失败', { description: String(error) });
  }
}

async function refreshAll() {
  try {
    await Promise.all([
      snapshotQuery.refetch(),
      messagesQuery.refetch(),
      selectedSessionId.value ? historyQuery.refetch() : undefined,
      selectedSessionId.value ? modelsQuery.refetch() : undefined,
    ]);
    toast.success('观测数据已刷新');
  } catch (error) {
    toast.error('刷新失败', { description: String(error) });
  }
}
</script>

<template>
  <div class="app-shell" :class="{ 'sidebar-is-collapsed': ui.sidebarCollapsed }">
    <GroupSidebar
      :groups="groups"
      :current-group-id="group?.id"
      @select="selectGroup"
    />

    <main class="min-w-0 p-3 sm:p-4">
      <div class="workspace-shell">
        <section class="chat-window panel">
          <header class="chat-header">
            <span class="chat-avatar">◈</span>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <h1 class="truncate text-base font-semibold">
                  {{ group?.name ?? '选择或创建一个群' }}
                </h1>
                <Badge>{{ currentMembers.length }} 名成员</Badge>
                <Badge v-if="currentRunningEndpoints.length" variant="accent">
                  {{ currentRunningEndpoints.length }} 个运行中
                </Badge>
              </div>
              <p class="mt-1 truncate font-mono text-[10px] text-dim">
                {{ group?.workspace ?? '用户与主 Agent 在 CLI 聊天，面板只读展示群内记录。' }}
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
            <Button variant="outline" size="sm" :disabled="snapshotQuery.isFetching.value" @click="refreshAll">
              <RefreshCw :size="14" :class="{ 'animate-spin': snapshotQuery.isFetching.value }" />
              刷新
            </Button>
          </header>

          <div class="chat-notice">
            <span class="status-dot status-online" />
            <span>只读观测</span>
            <span class="text-dim">·</span>
            <span>每 2 秒同步</span>
            <span class="text-dim">·</span>
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
              class="chat-feed"
              :messages="messageViews"
              :members="members"
              :selected-pair="selectedPair"
              :hosts="endpointHosts"
              :loading="messagesQuery.isPending.value"
              :has-next-page="messagesQuery.hasNextPage.value"
              :fetching-next-page="messagesQuery.isFetchingNextPage.value"
              @update:selected-pair="replaceQuery({ pair: $event || undefined })"
              @load-more="messagesQuery.fetchNextPage()"
            />
            <footer class="chat-footer">
              <span class="rounded-full bg-[var(--primary-muted)] px-2 py-1 text-[10px] font-medium text-[var(--primary)]">只读模式</span>
              <span>{{ selectedPair ? '已筛选双人会话' : '全部对话' }}</span>
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

        <aside :class="['context-panel', ui.inspectorOpen && 'context-panel-open']">
          <header class="context-header">
            <div class="min-w-0">
              <p class="eyebrow">GROUP DETAILS</p>
              <h2 class="mt-1 truncate text-sm font-medium">群信息与宿主状态</h2>
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
              type="button"
              :class="['context-tab', contextPanel === item.value && 'context-tab-active']"
              @click="setContextPanel(item.value)"
            >
              <component :is="item.icon" :size="13" />
              {{ item.label }}
            </button>
          </div>
          <div class="context-scroll">
            <CollaborationPanel v-if="contextPanel === 'collaboration'" :group-id="groupId" :members="members" />
            <MemberStrip
              v-else-if="contextPanel === 'members'"
              :members="currentMembers"
              :running-member-ids="runningMemberIds"
            />
            <SessionList
              v-else-if="contextPanel === 'sessions'"
              :endpoints="currentEndpoints"
              :session-bindings="currentSessionBindings"
              :members="members"
              :selected-id="selectedSessionId"
              :running-endpoints="runningEndpoints"
              @select="selectSession"
            />
            <InspectorPanel
              v-else
              class="inspector-embedded"
              :endpoint="selectedEndpoint"
              :members="members"
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
        </aside>
      </div>
    </main>
  </div>
</template>
