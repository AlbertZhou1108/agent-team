<script setup lang="ts">
import { computed, ref, type ComponentPublicInstance } from 'vue';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Disclosure } from '@/components/ui/disclosure';
import {
  ArrowUpToLine,
  GripVertical,
  MoreHorizontal,
  PinOff,
  Wrench,
  X,
} from '@lucide/vue';
import CollapsibleRightSidebar from '@/app/layouts/CollapsibleRightSidebar.vue';
import PanelState from '@/components/panel/PanelState.vue';
import MemberStrip from '@/features/groups/MemberStrip.vue';
import MemberModelDialog from '@/features/groups/MemberModelDialog.vue';
import CollaborationPanel from '@/features/groups/CollaborationPanel.vue';
import SessionList from '@/features/sessions/SessionList.vue';
import InspectorPanel from '@/features/sessions/InspectorPanel.vue';
import TelemetryMembersView from '@/features/telemetry/TelemetryMembersView.vue';
import { mountKey, type MountedTool } from '@/tools';
import { useUiStore } from '@/stores/ui';
import { useToolOrder } from './use-tool-order';
import { contextTabs, type ContextPanel } from './types';
import { withGap, type SortItem } from '@/shared/sort-preview';
import { useSortable } from '@/shared/use-sortable';
import type { InspectorTab } from '@/features/sessions/types';
import type {
  AgentTaskEntry,
  HistoryRow,
  Member,
  PanelAgent,
  SessionBinding,
  SessionEndpoint,
  TurnSummary,
} from '@/shared/api/raw-types';

/**
 * 团队工作区右栏（概览/成员/会话/详情/工具）。
 * 模板整体从 GroupWorkspacePage 拆出，工具页排序/置顶/关闭由 useToolOrder 承担；
 * 页面组合根只通过 props/emit 注入数据与路由动作。
 */
const props = defineProps<{
  groupId: string;
  panel: ContextPanel;
  visible: boolean;
  /** 当前右栏数据加载错误（会话/概览/详情）。 */
  contextError: Error | null;
  panelAgent: PanelAgent | null;
  tasks: AgentTaskEntry[];
  members: Member[];
  currentMembers: Member[];
  runningMemberIds: Set<string>;
  pausedMemberIds: Set<string>;
  actors: Array<{ id: string; name: string; host?: string }>;
  currentEndpoints: SessionEndpoint[];
  currentSessionBindings: SessionBinding[];
  selectedSessionId: string;
  runningEndpoints: string[];
  selectedEndpoint?: SessionEndpoint;
  currentController?: {
    kind: 'member' | 'panel_agent';
    id: string;
    name: string;
    assignment?: { revision: number; state: 'active' | 'suspended'; original_lead_id: string | null } | null;
  } | null;
  turnSummaries: TurnSummary[];
  unaffiliatedEvents: HistoryRow[];
  activeTab: InspectorTab;
  loading: boolean;
  hasNextPage: boolean;
  fetchingNextPage: boolean;
}>();

const emit = defineEmits<{
  'update:panel': [value: ContextPanel];
  'update:tab': [tab: InspectorTab];
  'select-session': [id: string];
  'choose-session': [];
  retry: [];
  'load-more': [];
  close: [];
  'member-model-saved': [];
}>();

const ui = useUiStore();
const {
  toolsPanelMounts,
  reorder,
  isPinned,
  togglePin,
  closeTool,
} = useToolOrder(() => props.groupId);

type ToolEntry = { id: string; entry: MountedTool };
type ToolRow = SortItem<ToolEntry>;

const toolsRoot = ref<HTMLElement | null>(null);
const toolEntries = computed<ToolEntry[]>(() =>
  toolsPanelMounts.value.map(entry => ({
    id: mountKey(entry.tool.id, 'right-tools'),
    entry,
  })),
);
const sortable = useSortable({
  root: toolsRoot,
  ids: () => toolEntries.value.map(row => row.id),
  canDrag: () => true,
  canTarget: () => true,
  axis: () => 'y',
  handleSelector: () => '.tools-drag-handle',
  onReorder: (id, targetId, after) => reorder(id, targetId, after),
});
const toolRows = computed(() =>
  withGap(toolEntries.value, sortable.preview.value, sortable.draggingIds.value),
);

function setToolsRoot(element: Element | ComponentPublicInstance | null) {
  toolsRoot.value = element instanceof HTMLElement ? element : null;
}
function attachTool(row: ToolRow, element: Element | ComponentPublicInstance | null) {
  if (row.item) sortable.bindItem(row.item.id, element instanceof HTMLElement ? element : null);
}
function toolName(row: ToolRow): string {
  return row.item?.entry.tool.name ?? '';
}
function toolPinned(row: ToolRow): boolean {
  return row.item ? isPinned(row.item.entry.tool.id) : false;
}
function togglePinRow(row: ToolRow) {
  if (row.item) togglePin(row.item.entry.tool.id);
}
function closeRow(row: ToolRow) {
  if (row.item) closeTool(row.item.entry.tool.id, row.item.entry.tool.name);
}
function toolComponent(row: ToolRow) {
  return row.item ? row.item.entry.mount.component : null;
}
function bindGapRef(element: Element | ComponentPublicInstance | null) {
  sortable.bindGap(element instanceof HTMLElement ? element : null);
}

const modelDialogMember = ref<Member | null>(null);
const modelDialogOpen = ref(false);
function openMemberModelDialog(member: Member) {
  modelDialogMember.value = member;
  modelDialogOpen.value = true;
}

function onCollapsed(value: boolean) {
  ui.contextCollapsed = value;
  ui.persist();
}
function onAction(value: string | number) {
  const tab = contextTabs.find((item) => item.value === value);
  if (tab) emit('update:panel', tab.value);
}
function onTab(value: string | number) {
  const tab = contextTabs.find((item) => item.value === value);
  if (tab) emit('update:panel', tab.value);
}
</script>

<template>
  <CollapsibleRightSidebar
    :collapsed="ui.contextCollapsed"
    :collapsed-actions="contextTabs"
    :active-action="panel"
    desktop-only-toggle
    @update:collapsed="onCollapsed"
    @action="onAction"
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
        @click="emit('close')"
        ><span aria-hidden="true">×</span></Button
      >
    </div>
    <Tabs
      :model-value="panel"
      class="min-h-0 flex-1"
      @update:model-value="onTab"
    >
      <!-- tab 行:标签组 + 右栏快捷按钮(right-popover 挂载,点击弹出内容浮层)。 -->
      <div v-if="!ui.contextCollapsed" class="mx-4 flex shrink-0 items-center gap-0.5">
        <TabsList
          class="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          aria-label="团队详情"
        >
          <TabsTrigger
            v-for="item in contextTabs"
            :key="item.value"
            :value="item.value"
            class="shrink-0 px-1.5 text-xs"
            ><component :is="item.icon" class="size-3.5" />{{ item.label }}</TabsTrigger
          >
        </TabsList>
      </div>
      <TabsContent
        v-if="visible"
        :value="panel"
        class="context-scroll"
      >
        <Alert v-if="contextError" variant="destructive"><AlertDescription class="flex items-center gap-2"><span class="flex-1">{{ contextError.message }}</span><Button variant="outline" size="sm" @click="emit('retry')">重试</Button></AlertDescription></Alert>
        <CollaborationPanel
          v-if="panel === 'collaboration'"
          :group-id="groupId"
          :tasks="tasks"
          :members="members"
          :panel-agent="panelAgent"
        />
        <div
          v-else-if="panel === 'members'"
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
          v-else-if="panel === 'sessions'"
          :endpoints="currentEndpoints"
          :session-bindings="currentSessionBindings"
          :members="members"
          :actors="actors"
          :selected-id="selectedSessionId"
          :running-endpoints="runningEndpoints"
          @select="emit('select-session', $event)"
        />
        <!-- 工具页:每个挂载一个可折叠区块,标题区分工具,默认收起。
             头部动作作用于这一节本身(与展开状态无关):置顶把挂载提到最前,
             关闭只隐藏右栏这一处挂载(设置里可恢复),抓手拖拽排序。
             顺序与显隐都记在工具偏好里。 -->
        <div
          v-else-if="panel === 'tools'"
          :ref="setToolsRoot"
          class="flex min-w-0 flex-col gap-4"
        >
          <PanelState
            v-if="!toolsPanelMounts.length"
            :icon="Wrench"
            title="没有启用的工具"
            description="在设置 → 工具里启用并勾选「右栏工具页」。"
          />
          <template v-for="row in toolRows" :key="row.key">
            <div
              v-if="row.item"
              :ref="el => attachTool(row, el)"
              class="tools-panel-section"
              :data-flip-key="`tool:${row.item.id}`"
              :data-sort-hidden="row.hidden ? 'true' : undefined"
            >
              <Disclosure persist-actions>
                <template #summary>
                  <h3 class="min-w-0 flex-1 truncate text-sm font-semibold">{{ toolName(row) }}</h3>
                </template>
                <template #actions>
                  <DropdownMenu>
                    <DropdownMenuTrigger as-child>
                      <Button
                        variant="ghost"
                        size="icon"
                        :aria-label="`${toolName(row)} 的工具操作`"
                        title="工具操作"
                      >
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuGroup>
                        <DropdownMenuItem @select="togglePinRow(row)">
                          <component
                            :is="toolPinned(row) ? PinOff : ArrowUpToLine"
                          />
                          {{ toolPinned(row) ? '取消置顶' : '置顶' }}
                        </DropdownMenuItem>
                        <DropdownMenuItem @select="closeRow(row)">
                          <X />
                          关闭
                        </DropdownMenuItem>
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <span
                    class="tools-drag-handle inline-flex size-(--component-control-height) cursor-grab items-center justify-center rounded-(--component-control-radius) text-muted-foreground/60 active:cursor-grabbing"
                    title="拖拽排序"
                  ><GripVertical class="size-4" /></span>
                </template>
                <div class="mt-3">
                  <component :is="toolComponent(row)" :group-id="groupId" />
                </div>
              </Disclosure>
            </div>
            <div
              v-else
              :ref="bindGapRef"
              class="sort-gap"
              aria-hidden="true"
              :style="{ height: `${sortable.preview.value?.size ?? 0}px` }"
            />
          </template>
        </div>
        <InspectorPanel
          v-else
          class="inspector-embedded"
          :group-id="groupId"
          :endpoints="currentEndpoints"
          :endpoint="selectedEndpoint"
          :members="members"
          :controller="currentController"
          :actors="actors"
          :turn-summaries="turnSummaries"
          :unaffiliated-events="unaffiliatedEvents"
          :tab="activeTab"
          :loading="loading"
          :has-next-page="hasNextPage"
          :fetching-next-page="fetchingNextPage"
          @choose-session="emit('choose-session')"
          @update:tab="emit('update:tab', $event)"
          @load-more="emit('load-more')"
          @close="emit('close')"
        />
      </TabsContent>
    </Tabs>
  </CollapsibleRightSidebar>

  <MemberModelDialog
    v-model:open="modelDialogOpen"
    :member="modelDialogMember"
    @saved="emit('member-model-saved')"
  />
</template>
