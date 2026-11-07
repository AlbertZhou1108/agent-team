<script setup lang="ts">
import { Input } from '@/components/ui/input';
import { Search } from '@lucide/vue';
import { Surface } from '@/components/surface';
import type { ComponentPublicInstance } from 'vue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useMediaQuery } from '@vueuse/core';
import { dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter';
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
import { NOTE_DRAG_TYPE } from '@/shared/pdd-drag';
import { useNoteHandoffStore } from '@/stores/note-handoff';
import { cn } from '@/lib/utils';
import { prefersReducedMotion } from '@/shared/motion';
import {
  containerOf,
  applyTeamClick,
  type ContainerKey,
  type SidebarDropAction,
} from '@/features/layout/sidebar-drag';
import { useSidebarTeamDrag } from '@/features/layout/use-sidebar-team-drag';
import {
  gapIndexForSource,
  gapIndexForTarget,
  withFolderGap,
  withTeamGap,
  type GapItem,
  type SortPreview,
} from '@/features/layout/sidebar-sort-preview';
import { captureFlipRects, playFlip } from '@/shared/layout-flip';

const props = defineProps<{
  groups: Group[];
  currentGroupId?: string;
  homeActive: boolean;
  /** 工具模块的左导航条目(left-nav 挂载),跟在主页之后渲染。 */
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
const selectionContainer = ref<ContainerKey>();
const creating = ref(false);
const newFolderName = ref('');
const agentUnreadLabel = computed(() =>
  props.agentUnreadCount > 99 ? '99+' : String(props.agentUnreadCount),
);

/* 笔记拖到 Panel Agent:投放目标注册给 PDD,按负载类型分流(canDrop),
   团队拖拽行为不受影响。drop 只把 ids 交给随心记工作区的 handoff 链路,
   不在这里做交互。 */
const noteHandoff = useNoteHandoffStore();
const noteDragOver = ref(false);
const noteDropTargetEl = ref<HTMLElement | null>(null);
let noteDropTargetCleanup: (() => void) | undefined;
onMounted(() => {
  const el = noteDropTargetEl.value;
  if (!el) return;
  noteDropTargetCleanup = dropTargetForElements({
    element: el,
    canDrop: ({ source }) => source.data.type === NOTE_DRAG_TYPE,
    getData: () => ({ type: 'note-handoff-target', tone: 'primary' }),
    getDropEffect: () => 'move',
    onDragEnter: () => { noteDragOver.value = true; },
    onDragLeave: () => { noteDragOver.value = false; },
    onDrop: ({ source }) => {
      noteDragOver.value = false;
      const ids = (source.data.ids as string[] | undefined) ?? [];
      noteHandoff.request(ids);
    },
  });
});
onBeforeUnmount(() => noteDropTargetCleanup?.());
watch(
  () => props.currentGroupId,
  (id) => {
    selected.value = id ? [id] : [];
    anchor.value = id;
    selectionContainer.value = id ? containerOfTeam(id) : undefined;
  },
  { immediate: true },
);
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

function containerOfTeam(id: string): ContainerKey {
  return containerOf(id, org.teams[id]);
}

function visibleIdsOf(container: ContainerKey | undefined): string[] {
  if (!container) return [];
  if (container === 'pinned') {
    return org.sections.pinned ? [] : pinned.value.map(group => group.id);
  }
  if (container === 'root') {
    return org.sections.ungrouped ? [] : rootTeams.value.map(group => group.id);
  }
  const folderId = container.slice('folder:'.length);
  const folder = org.folders.find(item => item.id === folderId);
  return folder && !folder.collapsed
    ? folderTeams(folderId).map(group => group.id)
    : [];
}

function clearSelection() {
  selected.value = [];
  anchor.value = undefined;
  selectionContainer.value = undefined;
}

function selectTeam(id: string, event: MouseEvent) {
  const container = containerOfTeam(id);
  const result = applyTeamClick({
    id,
    container,
    selection: selected.value,
    selectionContainer: selectionContainer.value,
    anchor: anchor.value,
    visibleIds: visibleIdsOf(container),
    currentGroupId: props.currentGroupId,
    shiftKey: event.shiftKey,
    toggleKey: event.metaKey || event.ctrlKey,
  });
  selected.value = result.selected;
  anchor.value = result.anchor;
  selectionContainer.value = result.selected.length ? container : undefined;
  if (result.navigate) emit('select', id);
}

function dragIds(id: string): string[] {
  const container = containerOfTeam(id);
  // 选区可能因菜单置顶等操作过期：被拖行已经不在原容器时，收缩为该行重新开始。
  if (!selected.value.includes(id) || selectionContainer.value !== container) {
    selected.value = [id];
    anchor.value = id;
    selectionContainer.value = container;
  }
  return visibleIdsOf(container).filter(item => selected.value.includes(item));
}

function applyAction(action: SidebarDropAction) {
  switch (action.kind) {
    case 'reorder-teams': {
      org.reorderTeams(action.ids, action.targetId, action.after, props.groups.map(group => group.id));
      selectionContainer.value = containerOfTeam(action.targetId);
      break;
    }
    case 'move-teams': {
      if (action.folderId) {
        org.appendTo(action.ids, { folder: action.folderId, pinned: false });
        org.expandFolder(action.folderId);
        selectionContainer.value = `folder:${action.folderId}`;
      } else {
        org.appendTo(action.ids, { pinned: false });
        org.expandSection('ungrouped');
        selectionContainer.value = 'root';
      }
      break;
    }
    case 'pin-teams': {
      org.appendTo(action.ids, { pinned: true });
      org.expandSection('pinned');
      selectionContainer.value = 'pinned';
      break;
    }
    case 'reorder-folder':
      org.reorderFolder(action.folderId, action.targetId, action.after);
      return;
    case 'none':
      return;
  }
  const first = action.ids.find(id => selected.value.includes(id)) ?? action.ids[0];
  if (first) anchor.value = first;
}

const {
  bindTeamRow,
  bindFolderHeading,
  bindFolderBlock,
  bindPinnedZone,
  bindRootZone,
  bindNavigation,
  bindSortGap,
  dragging,
  draggingIds,
  draggingFolder,
  insertion,
  dropZone,
  gapHeight,
} = useSidebarTeamDrag({
  dragIds,
  applyAction,
});

function visibleTeamIds(container: ContainerKey): string[] {
  if (container === 'pinned') return pinned.value.map(group => group.id);
  if (container === 'root') return rootTeams.value.map(group => group.id);
  return folderTeams(container.slice('folder:'.length)).map(group => group.id);
}

const sortPreview = computed<SortPreview | undefined>(() => {
  if (dragging.value === 'team' && draggingIds.value.length) {
    const first = draggingIds.value[0];
    if (!first) return undefined;
    const sourceContainer = containerOfTeam(first);
    const target = insertion.value;
    if (target?.kind === 'team') {
      const container = containerOfTeam(target.id);
      return {
        kind: 'team',
        container,
        index: gapIndexForTarget(
          visibleTeamIds(container),
          draggingIds.value,
          target.id,
          target.side === 'after',
        ),
        height: gapHeight.value,
      };
    }
    return {
      kind: 'team',
      container: sourceContainer,
      index: gapIndexForSource(visibleTeamIds(sourceContainer), draggingIds.value),
      height: gapHeight.value,
    };
  }
  if (dragging.value === 'folder' && draggingFolder.value) {
    const ids = org.folders.map(folder => folder.id);
    const target = insertion.value;
    return {
      kind: 'folder',
      index: target?.kind === 'folder'
        ? gapIndexForTarget(ids, [draggingFolder.value], target.id, target.side === 'after')
        : gapIndexForSource(ids, [draggingFolder.value]),
      height: gapHeight.value,
    };
  }
  return undefined;
});

const pinnedRows = computed(() => withTeamGap(pinned.value, sortPreview.value, 'pinned', draggingIds.value));
const rootRows = computed(() => withTeamGap(rootTeams.value, sortPreview.value, 'root', draggingIds.value));
function folderRows(id: string) {
  return withTeamGap(folderTeams(id), sortPreview.value, `folder:${id}`, draggingIds.value);
}
const folderItems = computed(() => withFolderGap(org.folders, sortPreview.value, draggingFolder.value));

type FolderEntry = { id: string; name: string; collapsed?: boolean };

function attachTeam(row: GapItem<Group>, element: Element | null, previous?: Element | null) {
  if (row.item) bindTeamRow(row.item.id, element, previous);
}
function selectRow(row: GapItem<Group>, event: MouseEvent) {
  if (row.item) selectTeam(row.item.id, event);
}
function archiveRow(row: GapItem<Group>) {
  if (row.item) emit('archive', row.item.id);
}

function attachFolderBlock(entry: GapItem<FolderEntry>, element: Element | null, previous?: Element | null) {
  if (entry.item) bindFolderBlock(entry.item.id, element, previous);
}
function attachFolderHeading(entry: GapItem<FolderEntry>, element: Element | null, previous?: Element | null) {
  if (entry.item) bindFolderHeading(entry.item.id, element, previous);
}
function folderName(entry: GapItem<FolderEntry>): string {
  return entry.item?.name ?? '';
}
function folderCollapsed(entry: GapItem<FolderEntry>): boolean {
  return entry.item?.collapsed === true;
}
function toggleFolderEntry(entry: GapItem<FolderEntry>) {
  if (entry.item) toggleFolder(entry.item.id);
}
function renameFolderEntry(entry: GapItem<FolderEntry>) {
  if (entry.item) beginRenameFolder(entry.item.id, entry.item.name);
}
function folderGapRef(entry: GapItem<FolderEntry>) {
  const key = `gap:folder:${entry.item?.id ?? ''}`;
  return stableRef(key, (el, prev) => bindSortGap(key, el, prev));
}

function containerDropZone(zone: string) {
  return dropZone.value === zone ? 'true' : undefined;
}

function pruneSelection() {
  if (!selected.value.length) return;
  const visible = visibleIdsOf(selectionContainer.value);
  selected.value = selected.value.filter(id => visible.includes(id));
  if (anchor.value && !selected.value.includes(anchor.value)) {
    anchor.value = selected.value[0];
  }
  if (!selected.value.length) selectionContainer.value = undefined;
}

function toggleSection(section: 'pinned' | 'ungrouped') {
  org.toggleSection(section);
  pruneSelection();
}

function toggleFolder(id: string) {
  org.toggleFolder(id);
  pruneSelection();
}

const refBinders = new Map<string, (element: Element | ComponentPublicInstance | null) => void>();
function stableRef(
  key: string,
  bind: (element: Element | null, previous?: Element | null) => void,
) {
  let fn = refBinders.get(key);
  if (!fn) {
    let current: Element | null = null;
    fn = element => {
      if (element instanceof HTMLElement) {
        current = element;
        bind(element);
        return;
      }
      const previous = current;
      current = null;
      bind(null, previous);
    };
    refBinders.set(key, fn);
  }
  return fn;
}

const pinnedZoneRef = stableRef('pinned', bindPinnedZone);
const rootZoneRef = stableRef('root', bindRootZone);
const navigationRef = stableRef('navigation', bindNavigation);

const navigationEl = ref<HTMLElement | null>(null);
function navigationElement(element: Element | ComponentPublicInstance | null) {
  navigationEl.value = element instanceof HTMLElement ? element : null;
  navigationRef(element);
}

let flipToken = 0;
let lastPreviewKey = '';

function previewKey(preview: SortPreview | undefined): string {
  if (!preview) return '';
  return preview.kind === 'team'
    ? `team:${preview.container}:${preview.index}:${preview.height}`
    : `folder:${preview.index}:${preview.height}`;
}

watch(
  sortPreview,
  async () => {
    const key = previewKey(sortPreview.value);
    if (key === lastPreviewKey) return;
    lastPreviewKey = key;
    if (prefersReducedMotion()) return;
    const token = ++flipToken;
    const before = captureFlipRects(navigationEl.value);
    await nextTick();
    if (token !== flipToken) return;
    playFlip(navigationEl.value, before);
  },
  { flush: 'pre' },
);

function onDocumentPointerDown(event: PointerEvent) {
  if (event.button !== 0 || !selected.value.length) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest('.team-row')) return;
  if (target.closest('[data-slot="dropdown-menu-content"], [data-slot="dropdown-menu-sub-content"]')) return;
  clearSelection();
}

function onDocumentKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && selected.value.length) clearSelection();
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown);
  document.addEventListener('keydown', onDocumentKeydown);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown);
  document.removeEventListener('keydown', onDocumentKeydown);
});
function createFolder() {
  const id = org.createFolder(newFolderName.value);
  if (!id) return;
  newFolderName.value = '';
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
      <div
        ref="noteDropTargetEl"
        class="min-w-0"
        :data-note-drop-target="noteDragOver ? 'hot' : noteHandoff.dragActive ? 'ready' : undefined"
      >
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
      </div>

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
    </nav>
    <Separator class="mt-3" />
    <div
      v-if="!navCollapsed"
      class="mt-3 flex items-center justify-between px-2"
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
        v-model="newFolderName"
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
      :ref="navigationElement"
      class="team-navigation mt-2 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto"
      aria-label="团队列表"
    >
      <div
        v-if="pinned.length"
        :ref="pinnedZoneRef"
        class="flex flex-col"
        data-flip-key="section:pinned"
        :data-drop-container="containerDropZone('pinned')"
      >
        <SidebarEntry title="置顶" controls="sidebar-pinned-content" :expanded="!org.sections.pinned" :active="org.sections.pinned && pinned.some(g => g.id === currentGroupId)" @activate="toggleSection('pinned')">
          置顶
        </SidebarEntry>
        <CollapseReveal id="sidebar-pinned-content" :show="!org.sections.pinned && !!pinned.length">
          <div class="team-pinned-children">
            <template v-for="row in pinnedRows" :key="row.key">
              <TeamRow
                v-if="row.item"
                :group="row.item"
                :active="row.item.id === currentGroupId"
                :selected="selected.includes(row.item.id)"
                :collapsed="ui.sidebarCollapsed"
                :attach="(el, prev) => attachTeam(row, el, prev)"
                :data-sort-hidden="row.hidden ? 'true' : undefined" :data-flip-key="row.hidden ? undefined : `team:${row.item.id}`"
                @select="selectRow(row, $event)"
                @archive="archiveRow(row)"
              />
              <div
                v-else
                :ref="stableRef('gap:pinned', (el, prev) => bindSortGap('gap:pinned', el, prev))"
                class="team-sort-gap"
                aria-hidden="true"
                :style="{ height: `${sortPreview?.height ?? 0}px` }"
              />
            </template>
          </div>
        </CollapseReveal>
      </div>
      <template v-for="entry in folderItems" :key="entry.key">
        <div
          v-if="!entry.item"
          :ref="stableRef('gap:folders', (el, prev) => bindSortGap('gap:folders', el, prev))"
          class="team-folder team-sort-gap"
          aria-hidden="true"
          :style="{ height: `${sortPreview?.height ?? 0}px` }"
        />
        <section
          v-else
          class="team-folder"
          :class="{ 'team-folder-collapsed': folderCollapsed(entry) }"
          :ref="stableRef(`folder-block:${entry.item.id}`, (el, prev) => attachFolderBlock(entry, el, prev))"
          :data-sort-hidden="entry.hidden ? 'true' : undefined" :data-flip-key="entry.hidden ? undefined : `folder:${entry.item.id}`"
          :data-drop-container="containerDropZone(`folder:${entry.item.id}`)"
        >
          <div
            class="team-folder-heading"
            :ref="stableRef(`folder-heading:${entry.item.id}`, (el, prev) => attachFolderHeading(entry, el, prev))"
          >
            <SidebarEntry :title="folderName(entry)" :controls="`sidebar-folder-${entry.item.id}`" :expanded="!folderCollapsed(entry)" @activate="toggleFolderEntry(entry)">
              {{ folderName(entry) }}
              <template #icon><component :is="folderCollapsed(entry) ? Folder : FolderOpen" /></template>
              <template v-if="!ui.sidebarCollapsed" #actions><TeamMenu :id="entry.item.id" :name="folderName(entry)" folder @rename="renameFolderEntry(entry)" /></template>
            </SidebarEntry>
          </div>
          <form
            v-if="renamingFolder?.id === entry.item.id"
            class="mb-1 ml-4 flex flex-col gap-2"
            @submit.prevent="submitRenameFolder"
          >
            <Input
              v-model="renamingFolder.name"
              class="field-select w-full"
              :aria-label="`重命名文件夹 ${folderName(entry)}`"
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
          <CollapseReveal :id="`sidebar-folder-${entry.item.id}`" :show="!folderCollapsed(entry)">
            <div :class="{ 'team-folder-children': !ui.sidebarCollapsed }">
              <template v-for="row in folderRows(entry.item.id)" :key="row.key">
                <TeamRow
                  v-if="row.item"
                  :group="row.item"
                  :active="row.item.id === currentGroupId"
                  :selected="selected.includes(row.item.id)"
                  :collapsed="ui.sidebarCollapsed"
                  :attach="(el, prev) => attachTeam(row, el, prev)"
                  :data-sort-hidden="row.hidden ? 'true' : undefined" :data-flip-key="row.hidden ? undefined : `team:${row.item.id}`"
                  @select="selectRow(row, $event)"
                  @archive="archiveRow(row)"
                />
                <div
                  v-else
                  :ref="folderGapRef(entry)"
                  class="team-sort-gap"
                  aria-hidden="true"
                  :style="{ height: `${sortPreview?.height ?? 0}px` }"
                />
              </template>
              <p
                v-if="dragging === 'team' && !folderTeams(entry.item.id).length && !ui.sidebarCollapsed"
                class="m-2 flex min-h-12 items-center justify-center rounded-md border border-dashed border-border px-3 text-xs text-muted-foreground"
              >
                拖入团队
              </p>
            </div>
          </CollapseReveal>
        </section>
      </template>
      <Separator v-if="org.folders.length && rootTeams.length" class="my-2" />
      <div
        v-if="rootTeams.length"
        :ref="rootZoneRef"
        class="team-root-drop"
        data-flip-key="section:root"
        :data-drop-container="containerDropZone('root')"
      >
        <SidebarEntry
          v-if="rootTeams.length"
          title="未分组"
          controls="sidebar-ungrouped-content"
          :expanded="!org.sections.ungrouped"
          :active="org.sections.ungrouped && rootTeams.some(g => g.id === currentGroupId)"
          @activate="toggleSection('ungrouped')"
        >
          未分组
        </SidebarEntry>
        <CollapseReveal id="sidebar-ungrouped-content" :show="!org.sections.ungrouped && !!rootTeams.length">
          <div class="team-root-children">
            <template v-for="row in rootRows" :key="row.key">
              <TeamRow
                v-if="row.item"
                :group="row.item"
                :active="row.item.id === currentGroupId"
                :selected="selected.includes(row.item.id)"
                :collapsed="ui.sidebarCollapsed"
                :attach="(el, prev) => attachTeam(row, el, prev)"
                :data-sort-hidden="row.hidden ? 'true' : undefined" :data-flip-key="row.hidden ? undefined : `team:${row.item.id}`"
                @select="selectRow(row, $event)"
                @archive="archiveRow(row)"
              />
              <div
                v-else
                :ref="stableRef('gap:root', (el, prev) => bindSortGap('gap:root', el, prev))"
                class="team-sort-gap"
                aria-hidden="true"
                :style="{ height: `${sortPreview?.height ?? 0}px` }"
              />
            </template>
          </div>
        </CollapseReveal>
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
