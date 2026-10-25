<script setup lang="ts">
import { Input } from '@/components/ui/input';
import { computed, ref, watch } from 'vue';
import AgentTeamLogo from './AgentTeamLogo.vue';
import TeamRow from './TeamRow.vue';
import SidebarEntry from './SidebarEntry.vue';
import { Separator } from '@/components/ui/separator';
import TeamMenu from './TeamMenu.vue';
import { useTeamOrganization } from '@/stores/team-organization';
import {
  Bot,
  Folder,
  FolderPlus,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  House,
  Settings2,
} from '@lucide/vue';
import type { Group } from '@/shared/api/raw-types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useUiStore } from '@/stores/ui';
import { useConnectionStore } from '@/stores/connection';
import { cn } from '@/lib/utils';

const props = defineProps<{
  groups: Group[];
  currentGroupId?: string;
  homeActive: boolean;
  agentActive: boolean;
  agentUnreadCount: number;
  settingsActive: boolean;
}>();

const emit = defineEmits<{
  select: [id: string];
  archive: [id: string];
  openAgent: [];
  openSettings: [];
}>();

const ui = useUiStore();
const connection = useConnectionStore();
const org = useTeamOrganization();
const selected = ref<string[]>([]);
const anchor = ref<string>();
const creating = ref(false);
const folderName = ref('');
const dropTarget = ref<string>();
const insertion = ref<{
  id: string;
  kind: 'team' | 'folder';
  after: boolean;
}>();
const dragging = ref<'team' | 'folder'>();
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
    after: event.clientY > rect.top + rect.height / 2,
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
      after: event.clientY > rect.top + rect.height / 2,
    };
  } else if (dragging.value === 'team') {
    insertion.value = undefined;
    dropTarget.value = id;
  }
}
function insertionClass(id: string, kind: 'team' | 'folder') {
  return insertion.value?.id === id && insertion.value.kind === kind
    ? insertion.value.after
      ? 'team-insert-after'
      : 'team-insert-before'
    : '';
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
  if (id === props.currentGroupId) {
    selected.value = [];
    anchor.value = undefined;
    emit('select', '');
    return;
  }
  selected.value = [id];
  anchor.value = id;
  emit('select', id);
}
function startDrag(id: string, event: DragEvent) {
  dragging.value = 'team';
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
      event.clientY > rect.top + rect.height / 2,
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
  org.reorderFolder(id, target, event.clientY > rect.top + rect.height / 2);
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
  }
}
function createFolder() {
  const id = org.createFolder(folderName.value);
  if (!id) return;
  folderName.value = '';
  creating.value = false;
}
</script>

<template>
  <aside
    :class="
      cn('group-sidebar', ui.sidebarCollapsed && 'group-sidebar-collapsed')
    "
  >
    <div
      class="flex min-w-0 items-center gap-3 px-2"
      :class="{ 'justify-center px-0': ui.sidebarCollapsed }"
    >
      <AgentTeamLogo :collapsed="ui.sidebarCollapsed" />
      <div v-if="!ui.sidebarCollapsed" class="min-w-0">
        <p class="truncate text-sm font-semibold tracking-tight">Agent Team</p>
      </div>
    </div>

    <nav aria-label="主导航" class="mt-6 flex flex-col gap-1">
      <Button
        :variant="homeActive ? 'secondary' : 'ghost'"
        size="sm"
        :class="
          cn(
            'home-nav-button w-full justify-start px-2',
            homeActive && 'home-nav-button-active',
          )
        "
        :aria-current="homeActive ? 'page' : undefined"
        title="主页"
        @click="emit('select', '')"
      >
        <House data-icon="inline-start" />
        <span v-if="!ui.sidebarCollapsed">主页</span>
      </Button>
      <Button
        :variant="agentActive ? 'secondary' : 'ghost'"
        size="sm"
        :class="
          cn(
            'home-nav-button relative w-full justify-start px-2',
            agentActive && 'home-nav-button-active',
          )
        "
        :aria-current="agentActive ? 'page' : undefined"
        :aria-label="
          agentUnreadCount
            ? `Panel Agent，${agentUnreadCount} 条新消息`
            : 'Panel Agent'
        "
        :title="
          agentUnreadCount
            ? `Panel Agent（${agentUnreadCount} 条新消息）`
            : 'Panel Agent'
        "
        @click="emit('openAgent')"
      >
        <Bot data-icon="inline-start" />
        <span v-if="!ui.sidebarCollapsed">Panel Agent</span>
        <Badge
          v-if="agentUnreadCount"
          variant="default"
          class="sidebar-unread-count"
          aria-hidden="true"
        >
          {{ agentUnreadLabel }}
        </Badge>
      </Button>
    </nav>
    <div
      v-if="!ui.sidebarCollapsed"
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
      v-if="creating && !ui.sidebarCollapsed"
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
      v-if="!ui.sidebarCollapsed"
      class="team-navigation mt-2 min-h-0 flex-1 overflow-y-auto"
      aria-label="团队列表"
      @dragover.prevent
      @drop="drop($event)"
      @dragend="clearDrag"
      @dragleave="leaveNavigation"
    >
      <SidebarEntry v-if="pinned.length" title="置顶" :expanded="!org.sections.pinned" :active="org.sections.pinned && pinned.some(g => g.id === currentGroupId)" @activate="org.toggleSection('pinned')">
        置顶
        <template #indicator><component :is="org.sections.pinned ? ChevronRight : ChevronDown" /></template>
      </SidebarEntry>
      <template v-if="!org.sections.pinned">
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
        :class="insertionClass(group.id, 'team')"
      />
      </template>
      <section
        v-for="folder in org.folders"
        :key="folder.id"
        class="team-folder"
        :class="[
          { 'team-drop-target': dropTarget === folder.id },
          insertionClass(folder.id, 'folder'),
        ]"
        @dragover.prevent.stop="overFolder(folder.id, $event)"
        @dragleave.self="dropTarget = undefined"
        @drop.stop="dropFolder(folder.id, $event)"
      >
        <div
          class="team-folder-heading"
          draggable="true"
          @dragstart="dragFolder(folder.id, $event)"
        >
          <SidebarEntry :title="folder.name" :expanded="!folder.collapsed" @activate="org.toggleFolder(folder.id)">
            {{ folder.name }}
            <template #icon><Folder /></template>
            <template #indicator><component :is="folder.collapsed ? ChevronRight : ChevronDown" /></template>
            <template v-if="!ui.sidebarCollapsed" #actions><TeamMenu :id="folder.id" :name="folder.name" folder /></template>
          </SidebarEntry>
        </div>
        <div
          v-if="!folder.collapsed"
          :class="{ 'team-folder-children': !ui.sidebarCollapsed }"
        >
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
            :class="insertionClass(group.id, 'team')"
          />
          <p
            v-if="!folderTeams(folder.id).length && !ui.sidebarCollapsed"
            class="team-section-label"
          >
            拖入团队
          </p>
        </div>
      </section>
      <Separator v-if="org.folders.length && rootTeams.length" class="my-2" />
      <div
        class="team-root-drop"
        @dragover.prevent.stop="
          dropTarget = dragging === 'team' ? 'root' : undefined;
          insertion = undefined;
        "
        @drop.stop="drop($event)"
        :class="{ 'team-drop-target': dropTarget === 'root' }"
      >
        <SidebarEntry
          v-if="rootTeams.length"
          title="未分组"
          :expanded="!org.sections.ungrouped"
          :active="org.sections.ungrouped && rootTeams.some(g => g.id === currentGroupId)"
          @activate="org.toggleSection('ungrouped')"
        >
          未分组
          <template #indicator><component :is="org.sections.ungrouped ? ChevronRight : ChevronDown" /></template>
        </SidebarEntry>
        <template v-if="!org.sections.ungrouped">
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
          :class="insertionClass(group.id, 'team')"
        />
        </template>
      </div>
      <p
        v-if="!groups.length && !ui.sidebarCollapsed"
        class="px-3 py-4 text-xs text-muted-foreground"
      >
        还没有团队。先在 CLI 中创建团队。
      </p>
    </nav>

    <div v-if="!ui.sidebarCollapsed" class="mt-5 space-y-3 pt-4">
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
      <Button
        :variant="settingsActive ? 'secondary' : 'ghost'"
        size="sm"
        :class="
          cn(
            'home-nav-button w-full justify-start px-2',
            settingsActive && 'home-nav-button-active',
          )
        "
        :aria-current="settingsActive ? 'page' : undefined"
        :title="ui.sidebarCollapsed ? '设置' : '打开设置'"
        @click="emit('openSettings')"
      >
        <Settings2 />
        <span v-if="!ui.sidebarCollapsed">设置</span>
      </Button>

      <Button
        variant="ghost"
        size="sm"
        class="w-full justify-start"
        :title="ui.sidebarCollapsed ? '展开侧栏' : '收起侧栏'"
        @click="ui.toggleSidebar()"
      >
        <ChevronsRight v-if="ui.sidebarCollapsed" />
        <ChevronsLeft v-else />
        <span v-if="!ui.sidebarCollapsed">收起</span>
      </Button>
    </div>
  </aside>
</template>
