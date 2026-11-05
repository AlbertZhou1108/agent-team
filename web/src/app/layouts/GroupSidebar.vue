<script setup lang="ts">
import { Input } from '@/components/ui/input';
import { Search } from '@lucide/vue';
import { Surface } from '@/components/surface';
import { computed, ref, watch } from 'vue';
import { useMediaQuery } from '@vueuse/core';
import SidebarCollapseButton from './SidebarCollapseButton.vue';
import AgentTeamLogo from './AgentTeamLogo.vue';
import TeamRow from './TeamRow.vue';
import SidebarEntry from './SidebarEntry.vue';
import { Separator } from '@/components/ui/separator';
import TeamMenu from './TeamMenu.vue';
import { useTeamOrganization } from '@/stores/team-organization';
import {
  Bot,
  Folder,
  FolderOpen,
  FolderPlus,
  ChevronDown,
  ChevronRight,
  House,
  Settings2,
} from '@lucide/vue';
import type { Group } from '@/shared/api/raw-types';
import { Button } from '@/components/ui/button';
import { CollapseReveal } from '@/components/ui/collapse-reveal';
import { Badge } from '@/components/ui/badge';
import { useUiStore } from '@/stores/ui';
import { useConnectionStore } from '@/stores/connection';
import { cn } from '@/lib/utils';
import { dropSide, type DropSide } from '@/shared/drag-order';

const props = defineProps<{
  groups: Group[];
  currentGroupId?: string;
  homeActive: boolean;
  /** 工具模块的左导航条目(注册表 + 用户启停推导),跟在主页之后渲染。 */
  toolEntries: Array<{ id: string; label: string; icon?: unknown; current: boolean }>;
  agentActive: boolean;
  agentUnreadCount: number;
  settingsActive: boolean;
}>();

const emit = defineEmits<{
  select: [id: string];
  archive: [id: string];
  activateTool: [id: string];
  openAgent: [];
  openSettings: [];
}>();

const ui = useUiStore();
const connection = useConnectionStore();
const org = useTeamOrganization();
// 窄屏把侧栏压成一条顶部导航:只保留图标入口,团队列表交给主页,避免首屏被侧栏占满。
const compact = useMediaQuery('(max-width: 760px)');
const navCollapsed = computed(() => ui.sidebarCollapsed || compact.value);
const selected = ref<string[]>([]);
const anchor = ref<string>();
const creating = ref(false);
const folderName = ref('');
const dropTarget = ref<string>();
const insertion = ref<{
  id: string;
  kind: 'team' | 'folder';
  side: DropSide;
}>();
const dragging = ref<'team' | 'folder'>();
const draggingFolder = ref<string>();
const agentUnreadLabel = computed(() =>
  props.agentUnreadCount > 99 ? '99+' : String(props.agentUnreadCount),
);
watch(
  () => props.currentGroupId,
  (id) => {
    selected.value = id ? [id] : [];
    anchor.value = id;
  },
  { immediate: true },
);
function clearDrag() {
  dropTarget.value = undefined;
  insertion.value = undefined;
  dragging.value = undefined;
  draggingFolder.value = undefined;
}
function showTeamInsertion(id: string, event: DragEvent) {
  dropTarget.value = undefined;
  if (dragging.value !== 'team' || selected.value.includes(id)) {
    insertion.value = undefined;
    return;
  }
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  insertion.value = {
    id,
    kind: 'team',
    side: dropSide(event, rect, 'y'),
  };
}
function leaveNavigation(event: DragEvent) {
  const element = event.currentTarget as HTMLElement;
  if (!element.contains(event.relatedTarget as Node | null)) {
    dropTarget.value = undefined;
    insertion.value = undefined;
  }
}
function leaveInsertion(event: DragEvent) {
  const element = event.currentTarget as HTMLElement;
  if (!element.contains(event.relatedTarget as Node | null))
    insertion.value = undefined;
}
function overFolder(id: string, event: DragEvent) {
  if (dragging.value === 'folder') {
    dropTarget.value = undefined;
    const element = event.currentTarget as HTMLElement;
    const rect = (
      element.querySelector('.team-folder-heading') ?? element
    ).getBoundingClientRect();
    insertion.value = {
      id,
      kind: 'folder',
      side: dropSide(event, rect, 'y'),
    };
  } else if (dragging.value === 'team') {
    insertion.value = undefined;
    dropTarget.value = id;
  }
}
function insertionSide(id: string, kind: 'team' | 'folder') {
  return insertion.value?.id === id && insertion.value.kind === kind
    ? insertion.value.side
    : undefined;
}
const sortedTeams = computed(() =>
  [...props.groups].sort((a, b) => {
    const index = (id: string) => {
      const value = org.order.indexOf(id);
      return value < 0
        ? org.order.length + props.groups.findIndex((group) => group.id === id)
        : value;
    };
    return index(a.id) - index(b.id);
  }),
);
const pinned = computed(() =>
  sortedTeams.value.filter((group) => org.teams[group.id]?.pinned),
);
const rootTeams = computed(() =>
  sortedTeams.value.filter(
    (group) =>
      !org.teams[group.id]?.pinned &&
      !org.folders.some((folder) => folder.id === org.teams[group.id]?.folder),
  ),
);
const folderTeams = (id: string) =>
  sortedTeams.value.filter(
    (group) =>
      !org.teams[group.id]?.pinned && org.teams[group.id]?.folder === id,
  );
const visibleIds = computed(() =>
  [
    ...(org.sections.pinned ? [] : pinned.value),
    ...org.folders.flatMap((folder) =>
      folder.collapsed ? [] : folderTeams(folder.id),
    ),
    ...rootTeams.value,
  ].map((group) => group.id),
);
function selectTeam(id: string, event: MouseEvent) {
  if (event.shiftKey) {
    const ids = visibleIds.value;
    const start = ids.indexOf(anchor.value ?? id),
      end = ids.indexOf(id);
    selected.value = Array.from(
      new Set([
        ...selected.value,
        ...ids.slice(Math.min(start, end), Math.max(start, end) + 1),
      ]),
    );
    if (!anchor.value) anchor.value = id;
    return;
  }
  if (id === props.currentGroupId) return;
  selected.value = [id];
  anchor.value = id;
  emit('select', id);
}
function startDrag(id: string, event: DragEvent) {
  dragging.value = 'team';
  draggingFolder.value = undefined;
  if (!selected.value.includes(id)) selected.value = [id];
  event.dataTransfer?.setData(
    'application/x-agent-team-ids',
    JSON.stringify(selected.value),
  );
  event.dataTransfer?.setData('text/plain', selected.value.join(', '));
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
}
function reorderTeam(target: string, event: DragEvent) {
  const raw = event.dataTransfer?.getData('application/x-agent-team-ids');
  if (!raw) return;
  event.preventDefault();
  event.stopPropagation();
  try {
    const ids = JSON.parse(raw);
    if (!Array.isArray(ids)) return;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    org.reorderTeams(
      ids.filter((id) => props.groups.some((group) => group.id === id)),
      target,
      dropSide(event, rect, 'y') === 'after',
      props.groups.map((group) => group.id),
    );
  } catch {
    /* Ignore unrelated drag data. */
  }
  dropTarget.value = undefined;
  insertion.value = undefined;
}
function dragFolder(id: string, event: DragEvent) {
  dragging.value = 'folder';
  draggingFolder.value = id;
  event.stopPropagation();
  event.dataTransfer?.setData('application/x-agent-team-folder', id);
  event.dataTransfer?.setData('text/plain', id);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
}
function dropFolder(target: string, event: DragEvent) {
  const id = event.dataTransfer?.getData('application/x-agent-team-folder');
  if (!id) {
    drop(event, target);
    return;
  }
  event.preventDefault();
  const element = event.currentTarget as HTMLElement;
  const rect = (
    element.querySelector('.team-folder-heading') ?? element
  ).getBoundingClientRect();
  org.reorderFolder(id, target, dropSide(event, rect, 'y') === 'after');
  dropTarget.value = undefined;
  insertion.value = undefined;
}
function drop(event: DragEvent, folder?: string) {
  event.preventDefault();
  dropTarget.value = undefined;
  insertion.value = undefined;
  try {
    const ids = JSON.parse(
      event.dataTransfer?.getData('application/x-agent-team-ids') ?? '[]',
    );
    if (Array.isArray(ids))
      org.move(
        ids.filter(
          (id) =>
            typeof id === 'string' &&
            props.groups.some((group) => group.id === id),
        ),
        folder,
      );
  } catch {
    /* Ignore unrelated dragged content. */
  } finally {
    clearDrag();
  }
}
function createFolder() {
  const id = org.createFolder(folderName.value);
  if (!id) return;
  folderName.value = '';
  creating.value = false;
}
const renamingFolder = ref<{ id: string; name: string }>();
function beginRenameFolder(id: string, name: string) {
  renamingFolder.value = { id, name };
}
function submitRenameFolder() {
  if (!renamingFolder.value) return;
  org.renameFolder(renamingFolder.value.id, renamingFolder.value.name);
  renamingFolder.value = undefined;
}
</script>

<template>
  <Surface role="nav-panel" as="aside"
    :class="
      cn('group-sidebar', ui.sidebarCollapsed && 'group-sidebar-collapsed')
    "
  >
    <div
      class="flex min-w-0 items-center gap-3 px-2"
      :class="{ 'justify-center px-0': ui.sidebarCollapsed }"
    >
      <AgentTeamLogo :collapsed="navCollapsed" />
      <div v-if="!navCollapsed" class="min-w-0">
        <p class="truncate text-sm font-semibold tracking-tight">Agent Team</p>
      </div>
    </div>

    <nav aria-label="主导航" class="mt-6 flex flex-col gap-1">
      <SidebarEntry :collapsed="navCollapsed" title="全局搜索 · ⌘K / Ctrl+K" @activate="ui.searchOpen=true"><template #icon><Search /></template>全局搜索</SidebarEntry>
      <SidebarEntry :current="homeActive" :collapsed="navCollapsed" title="主页" @activate="emit('select', '')">
        <template #icon><House /></template>
        主页
      </SidebarEntry>
      <SidebarEntry
        v-for="entry in toolEntries"
        :key="entry.id"
        :current="entry.current"
        :collapsed="navCollapsed"
        :title="entry.label"
        @activate="emit('activateTool', entry.id)"
      >
        <template #icon><component :is="entry.icon" v-if="entry.icon" /></template>
        {{ entry.label }}
      </SidebarEntry>
      <SidebarEntry
        :current="agentActive"
        :collapsed="navCollapsed"
        :label="agentUnreadCount ? `Panel Agent，${agentUnreadCount} 条新消息` : 'Panel Agent'"
        :title="agentUnreadCount ? `Panel Agent（${agentUnreadCount} 条新消息）` : 'Panel Agent'"
        @activate="emit('openAgent')"
      >
        <template #icon><Bot /></template>
        Panel Agent
        <template v-if="agentUnreadCount" #indicator>
          <Badge variant="default" class="sidebar-unread-count" aria-hidden="true">{{ agentUnreadLabel }}</Badge>
        </template>
      </SidebarEntry>
    </nav>
    <div
      v-if="!navCollapsed"
      class="mt-7 flex items-center justify-between px-2"
    >
      <span class="flex items-center gap-2"
        ><span class="eyebrow">团队</span></span
      >
      <Button
        variant="ghost"
        size="icon"
        class="ml-auto"
        aria-label="新建团队文件夹"
        title="新建文件夹"
        @click="creating = !creating"
        ><FolderPlus
      /></Button>
    </div>

    <form
      v-if="creating && !navCollapsed"
      class="mt-2 flex flex-col gap-2"
      @submit.prevent="createFolder"
    >
      <Input
        v-model="folderName"
        class="field-select w-full"
        aria-label="文件夹名称"
        placeholder="文件夹名称"
        maxlength="60"
        @keydown.esc="creating = false"
      />
      <div class="flex gap-2">
        <Button size="sm" type="submit">创建</Button
        ><Button size="sm" variant="ghost" @click="creating = false"
          >取消</Button
        >
      </div>
    </form>
    <nav
      v-if="!navCollapsed"
      class="team-navigation mt-2 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto"
      aria-label="团队列表"
      @dragover.prevent
      @drop="drop($event)"
      @dragend="clearDrag"
      @dragleave="leaveNavigation"
    >
      <SidebarEntry v-if="pinned.length" title="置顶" controls="sidebar-pinned-content" :expanded="!org.sections.pinned" :active="org.sections.pinned && pinned.some(g => g.id === currentGroupId)" @activate="org.toggleSection('pinned')">
        置顶
      </SidebarEntry>
      <CollapseReveal id="sidebar-pinned-content" :show="!org.sections.pinned && !!pinned.length"><div class="team-pinned-children">
      <TeamRow
        v-for="group in pinned"
        :key="group.id"
        :group="group"
        :active="group.id === currentGroupId"
        :selected="selected.includes(group.id)"
        :collapsed="ui.sidebarCollapsed"
        @select="selectTeam(group.id, $event)"
        @drag="startDrag(group.id, $event)"
        @reorder="reorderTeam(group.id, $event)"
        @over="showTeamInsertion(group.id, $event)"
        @leave="leaveInsertion"
        @archive="emit('archive', group.id)"
        data-drop-axis="y"
        :data-drop-side="insertionSide(group.id, 'team')"
        :data-dragging="dragging === 'team' && selected.includes(group.id) ? 'true' : undefined"
      />
      </div></CollapseReveal>
      <section
        v-for="folder in org.folders"
        :key="folder.id"
        class="team-folder"
        :class="{ 'team-folder-collapsed': folder.collapsed }"
        data-drop-axis="y"
        :data-drop-side="insertionSide(folder.id, 'folder')"
        :data-drop-container="dropTarget === folder.id ? 'true' : undefined"
        @dragover.prevent.stop="overFolder(folder.id, $event)"
        @dragleave.self="dropTarget = undefined"
        @drop.stop="dropFolder(folder.id, $event)"
      >
        <div
          class="team-folder-heading"
          draggable="true"
          :data-dragging="draggingFolder === folder.id ? 'true' : undefined"
          @dragstart="dragFolder(folder.id, $event)"
        >
          <SidebarEntry :title="folder.name" :controls="`sidebar-folder-${folder.id}`" :expanded="!folder.collapsed" @activate="org.toggleFolder(folder.id)">
            {{ folder.name }}
            <template #icon><component :is="folder.collapsed ? Folder : FolderOpen" /></template>
            <template v-if="!ui.sidebarCollapsed" #actions><TeamMenu :id="folder.id" :name="folder.name" folder @rename="beginRenameFolder(folder.id, folder.name)" /></template>
          </SidebarEntry>
        </div>
        <form
          v-if="renamingFolder?.id === folder.id"
          class="mb-1 ml-4 flex flex-col gap-2"
          @submit.prevent="submitRenameFolder"
        >
          <Input
            v-model="renamingFolder.name"
            class="field-select w-full"
            :aria-label="`重命名文件夹 ${folder.name}`"
            maxlength="60"
            @keydown.esc="renamingFolder = undefined"
          />
          <div class="flex gap-2">
            <Button size="sm" type="submit">保存</Button
            ><Button size="sm" variant="ghost" @click="renamingFolder = undefined"
              >取消</Button
            >
          </div>
        </form>
        <CollapseReveal :id="`sidebar-folder-${folder.id}`" :show="!folder.collapsed">
          <div :class="{ 'team-folder-children': !ui.sidebarCollapsed }">
            <TeamRow
              v-for="group in folderTeams(folder.id)"
              :key="group.id"
              :group="group"
              :active="group.id === currentGroupId"
              :selected="selected.includes(group.id)"
              :collapsed="ui.sidebarCollapsed"
              @select="selectTeam(group.id, $event)"
              @drag="startDrag(group.id, $event)"
              @reorder="reorderTeam(group.id, $event)"
              @over="showTeamInsertion(group.id, $event)"
              @leave="leaveInsertion"
              @archive="emit('archive', group.id)"
              data-drop-axis="y"
              :data-drop-side="insertionSide(group.id, 'team')"
              :data-dragging="dragging === 'team' && selected.includes(group.id) ? 'true' : undefined"
            />
            <p
              v-if="dragging === 'team' && !folderTeams(folder.id).length && !ui.sidebarCollapsed"
              class="m-2 flex min-h-12 items-center justify-center rounded-md border border-dashed border-border px-3 text-xs text-muted-foreground"
            >
              拖入团队
            </p>
          </div>
        </CollapseReveal>
      </section>
      <Separator v-if="org.folders.length && rootTeams.length" class="my-2" />
      <div
        v-if="rootTeams.length"
        class="team-root-drop"
        @dragover.prevent.stop="
          dropTarget = dragging === 'team' ? 'root' : undefined;
          insertion = undefined;
        "
        @drop.stop="drop($event)"
        :data-drop-container="dropTarget === 'root' ? 'true' : undefined"
      >
        <SidebarEntry
          v-if="rootTeams.length"
          title="未分组"
          controls="sidebar-ungrouped-content"
          :expanded="!org.sections.ungrouped"
          :active="org.sections.ungrouped && rootTeams.some(g => g.id === currentGroupId)"
          @activate="org.toggleSection('ungrouped')"
        >
          未分组
        </SidebarEntry>
        <CollapseReveal id="sidebar-ungrouped-content" :show="!org.sections.ungrouped && !!rootTeams.length"><div class="team-root-children">
        <TeamRow
          v-for="group in rootTeams"
          :key="group.id"
          :group="group"
          :active="group.id === currentGroupId"
          :selected="selected.includes(group.id)"
          :collapsed="ui.sidebarCollapsed"
          @select="selectTeam(group.id, $event)"
          @drag="startDrag(group.id, $event)"
          @reorder="reorderTeam(group.id, $event)"
          @over="showTeamInsertion(group.id, $event)"
          @leave="leaveInsertion"
          @archive="emit('archive', group.id)"
          data-drop-axis="y"
          :data-drop-side="insertionSide(group.id, 'team')"
          :data-dragging="dragging === 'team' && selected.includes(group.id) ? 'true' : undefined"
        />
        </div></CollapseReveal>
      </div>
      <p
        v-if="!groups.length && !ui.sidebarCollapsed"
        class="px-3 py-4 text-xs text-muted-foreground"
      >
        还没有团队。可从主页创建。
      </p>
    </nav>

    <div v-if="!navCollapsed" class="mt-5 flex flex-col gap-3 pt-4">
      <div class="flex items-center gap-2 px-2 text-muted-foreground">
        <span
          :class="[
            'status-dot',
            connection.status === 'online'
              ? 'status-online'
              : connection.status === 'error'
                ? 'status-error'
                : 'status-connecting',
          ]"
        />
        <span class="min-w-0 flex-1 truncate text-muted-foreground">
          {{
            connection.status === 'online'
              ? '本机已连接'
              : connection.status === 'error'
                ? '连接异常'
                : '正在连接'
          }}
        </span>
        <span
          v-if="connection.lastSyncedAt"
          class="font-mono text-muted-foreground"
        >
          {{
            connection.lastSyncedAt.toLocaleTimeString('zh-CN', {
              hour: '2-digit',
              minute: '2-digit',
            })
          }}
        </span>
      </div>
    </div>

    <div class="sidebar-actions">
      <SidebarEntry :current="settingsActive" :collapsed="navCollapsed" label="设置" :title="navCollapsed ? '设置' : '打开设置'" @activate="emit('openSettings')">
        <template #icon><Settings2 /></template>
        设置
      </SidebarEntry>

      <SidebarCollapseButton v-if="!compact" side="left" :collapsed="ui.sidebarCollapsed" @toggle="ui.toggleSidebar()" />
    </div>
  </Surface>
</template>
