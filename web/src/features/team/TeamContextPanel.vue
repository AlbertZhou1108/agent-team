<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch, type ComponentPublicInstance } from 'vue';
import { api } from '@/shared/api/client';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
  MoreHorizontal,
  PinOff,
  Wrench,
  X,
} from '@lucide/vue';
import CollapsibleRightSidebar from '@/app/layouts/CollapsibleRightSidebar.vue';
import PanelState from '@/components/panel/PanelState.vue';
import MemberModelDialog from '@/features/groups/MemberModelDialog.vue';
import CollaborationPanel from '@/features/groups/CollaborationPanel.vue';
import TeamMembersPanel from './TeamMembersPanel.vue';
import { mountKey, type MountedTool } from '@/tools';
import { useUiStore } from '@/stores/ui';
import { useToolOrder } from './use-tool-order';
import { contextTabs, type ContextPanel } from './types';
import { withGap, type SortItem } from '@/shared/sort-preview';
import { useSortable } from '@/shared/use-sortable';
import type {
  AgentTasksView,
  Member,
  PanelAgent,
  SessionEndpoint,
} from '@/shared/api/raw-types';

/**
 * 团队工作区右栏（概览 / 成员 / 工具）。
 * 原「会话」与「详情」已迁至中间主区标签页；三栏内容按团队保活（v-show）以保持
 * 跨 tab 切换时的折叠状态，并支持成员页直达协调遥测或主区执行轨迹。
 */
const props = defineProps<{
  groupId: string;
  panel: ContextPanel;
  visible: boolean;
  /** 当前右栏数据加载错误。 */
  contextError: Error | null;
  panelAgent: PanelAgent | null;
  tasksView: AgentTasksView;
  members: Member[];
  currentMembers: Member[];
  runningMemberIds: Set<string>;
  pausedMemberIds: Set<string>;
  actors: Array<{ id: string; name: string; host?: string }>;
  currentEndpoints: SessionEndpoint[];
}>();

const emit = defineEmits<{
  'update:panel': [value: ContextPanel];
  'open-trace': [sessionId: string];
  retry: [];
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
  toolsPanelMounts.value.map((entry) => ({
    id: mountKey(entry.tool.id, 'right-tools'),
    entry,
  })),
);
const sortable = useSortable({
  root: toolsRoot,
  ids: () => toolEntries.value.map((row) => row.id),
  canDrag: () => true,
  canTarget: () => true,
  axis: () => 'y',
  dragElementSelector: () => '[data-slot="disclosure-header"]',
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

// 工具卡片展开态按 mountKey 记忆，跨 tab 切换不重置；点击成员用量摘要时自动展开协调遥测。
const toolOpenMap = ref<Record<string, boolean>>({});
const focusedTelemetryMemberId = ref<string | undefined>(undefined);
function isToolOpen(key: string): boolean {
  return Boolean(toolOpenMap.value[key]);
}
function setToolOpen(key: string, open: boolean) {
  toolOpenMap.value = { ...toolOpenMap.value, [key]: open };
}
function openMemberUsage(memberId: string) {
  focusedTelemetryMemberId.value = memberId;
  setToolOpen(mountKey('builtin.coordination', 'right-tools'), true);
  emit('update:panel', 'tools');
}

// 工具操作菜单受控，确保按 Escape 时立即关闭。
const openMenuId = ref<string | null>(null);
function onDocumentKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && openMenuId.value !== null) {
    openMenuId.value = null;
  }
}
watch(openMenuId, (id) => {
  if (typeof window === 'undefined') return;
  window.removeEventListener('keydown', onDocumentKeydown, true);
  if (id !== null) {
    window.addEventListener('keydown', onDocumentKeydown, true);
  }
});
onBeforeUnmount(() => {
  if (typeof window !== 'undefined') {
    window.removeEventListener('keydown', onDocumentKeydown, true);
  }
});

// 主控关系:当前谁持有写入席位、谁已只读。随团队切换刷新。
const controllers = ref<Array<{ binding_name: string | null; surface: string | null; active: number; updated: string }>>([]);
watch(() => props.groupId, async (id) => {
  toolOpenMap.value = {};
  focusedTelemetryMemberId.value = undefined;
  openMenuId.value = null;
  if (!id) { controllers.value = []; return; }
  try { controllers.value = await api.getTeamControllers(id); } catch { controllers.value = []; }
}, { immediate: true });

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
    <div v-if="controllers.length" class="border-b px-3 py-2 text-xs">
      <p class="text-muted-foreground">主控</p>
      <ul class="mt-1 flex flex-col gap-0.5">
        <li v-for="row in controllers" :key="`${row.binding_name}-${row.updated}`" class="flex items-center gap-1.5">
          <span :class="row.active ? 'text-foreground' : 'text-muted-foreground'" class="truncate">{{ row.binding_name ?? '未知连接' }}</span>
          <span v-if="row.active" class="shrink-0 rounded bg-primary/10 px-1 text-[length:var(--component-micro-font-size)] text-primary">当前</span>
          <span v-else class="shrink-0 text-[length:var(--component-micro-font-size)] text-muted-foreground">只读</span>
        </li>
      </ul>
    </div>
    <Tabs
      :model-value="panel"
      class="min-h-0 flex-1"
      @update:model-value="onTab"
    >
      <div v-if="!ui.contextCollapsed" class="mx-4 flex shrink-0 items-center gap-0.5">
        <TabsList
          class="grid min-w-0 flex-1 grid-cols-3"
          aria-label="团队详情"
        >
          <TabsTrigger
            v-for="item in contextTabs"
            :key="item.value"
            :value="item.value"
            class="px-2 text-xs"
            ><component :is="item.icon" class="size-3.5" />{{ item.label }}</TabsTrigger
          >
        </TabsList>
      </div>
      <!-- 保持同一团队内三个视图挂载（v-show），切 tab 不丢失折叠展开状态。 -->
      <div
        v-if="visible"
        :key="groupId"
        class="context-scroll"
      >
        <Alert v-if="contextError" variant="destructive" class="mb-3">
          <AlertDescription class="flex items-center gap-2">
            <span class="flex-1">{{ contextError.message }}</span>
            <Button variant="outline" size="sm" @click="emit('retry')">重试</Button>
          </AlertDescription>
        </Alert>

        <div v-show="panel === 'collaboration'" role="tabpanel" aria-label="概览">
          <CollaborationPanel
            :group-id="groupId"
            :view="tasksView"
            :members="members"
            :panel-agent="panelAgent"
            :actors="actors"
          />
        </div>

        <div v-show="panel === 'members'" role="tabpanel" aria-label="成员">
          <TeamMembersPanel
            :group-id="groupId"
            :members="currentMembers"
            :endpoints="currentEndpoints"
            :running-member-ids="runningMemberIds"
            :paused-member-ids="pausedMemberIds"
            @edit-model="openMemberModelDialog"
            @open-usage="openMemberUsage"
            @open-trace="emit('open-trace', $event)"
          />
        </div>

        <div
          v-show="panel === 'tools'"
          :ref="setToolsRoot"
          role="tabpanel"
          aria-label="工具"
          class="flex min-w-0 flex-col gap-4"
        >
          <PanelState
            v-if="!toolsPanelMounts.length"
            :icon="Wrench"
            title="暂无工具"
          />
          <template v-for="row in toolRows" :key="row.key">
            <div
              v-if="row.item"
              :ref="el => attachTool(row, el)"
              class="tools-panel-section"
              :data-flip-key="row.hidden ? undefined : `tool:${row.item.id}`"
              :data-sort-hidden="row.hidden ? 'true' : undefined"
            >
              <Disclosure
                :open="isToolOpen(row.item.id)"
                persist-actions
                @update:open="setToolOpen(row.item.id, $event)"
              >
                <template #summary>
                  <h3 class="min-w-0 flex-1 truncate text-sm font-semibold">{{ toolName(row) }}</h3>
                </template>
                <template #actions>
                  <DropdownMenu
                    :open="openMenuId === row.item.id"
                    @update:open="openMenuId = $event ? row.item.id : (openMenuId === row.item.id ? null : openMenuId)"
                  >
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
                    <DropdownMenuContent align="end" @escape-key-down="openMenuId = null">
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
                </template>
                <div class="mt-3">
                  <component
                    :is="toolComponent(row)"
                    :group-id="groupId"
                    :selected-member-id="row.item.entry.tool.id === 'builtin.coordination' ? focusedTelemetryMemberId : undefined"
                  />
                </div>
              </Disclosure>
            </div>
            <div
              v-else
              :ref="bindGapRef"
              class="sort-gap"
              aria-hidden="true"
              :style="{ height: `${sortable.preview.value?.height ?? 0}px` }"
            />
          </template>
        </div>
      </div>
    </Tabs>
  </CollapsibleRightSidebar>

  <MemberModelDialog
    v-model:open="modelDialogOpen"
    :member="modelDialogMember"
    @saved="emit('member-model-saved')"
  />
</template>
