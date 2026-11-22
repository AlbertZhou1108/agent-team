/**
 * TeamSecondaryPanel 的状态编排:搜索与分段筛选、置顶/文件夹/未分组派生、多选
 * (点击/Shift/Cmd)、拖拽落点、文件夹对话框与批量动作。
 *
 * 组件只保留 DOM 引用绑定(refBinders/stableRef)与纯展示辅助;渲染结构与交互不变。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Group, Member } from '@/shared/api/raw-types';
import { useTeamOrganization } from '@/stores/team-organization';
import {
  applyTeamClick,
  containerOf,
  type ContainerKey,
  type SidebarDropAction,
} from '@/features/layout/sidebar-drag';
import { useSidebarTeamDrag } from '@/features/layout/use-sidebar-team-drag';
import {
  filterTeamsByQuery,
  formatActiveTime,
  recentTeams,
  sortFoldersByName,
  sortTeamsByActivity,
  teamActiveTimestamp,
} from '@/features/layout/team-activity';

export type TeamSegment = 'all' | 'pinned' | 'folders' | 'ungrouped';

export const SEGMENTS: ReadonlyArray<{ id: TeamSegment; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'pinned', label: '置顶' },
  { id: 'folders', label: '文件夹' },
  { id: 'ungrouped', label: '未分组' },
];

export interface TeamSecondaryPanelProps {
  groups: Group[];
  members: Member[];
  currentGroupId?: string;
  groupUnreadByTeam?: ReadonlyMap<string, number>;
  activityByTeam?: ReadonlyMap<string, number>;
}

export interface TeamSecondaryPanelEmit {
  select: (id: string) => void;
  archive: (ids: string[]) => void;
}

export interface UseTeamSecondaryPanelOptions {
  props: TeamSecondaryPanelProps;
  emit: TeamSecondaryPanelEmit;
}

export function useTeamSecondaryPanel(options: UseTeamSecondaryPanelOptions) {
  const props = options.props;
  const emit = options.emit;
  const org = useTeamOrganization();
  const searchQuery = ref('');
  const segment = ref<TeamSegment>('all');
  const creatingFolder = ref(false);
  const newFolderName = ref('');
  const renamingFolder = ref<{ id: string; name: string }>();

  const selected = ref<string[]>([]);
  const anchor = ref<string>();
  const selectionContainer = ref<ContainerKey>();

  const hasQuery = computed(() => searchQuery.value.trim().length > 0);
  const filteredGroups = computed(() =>
    filterTeamsByQuery(props.groups, props.members, searchQuery.value),
  );

  const memberCounts = computed(() => {
    const counts = new Map<string, number>();
    for (const member of props.members) {
      if (member.removed) continue;
      counts.set(member.group_id, (counts.get(member.group_id) ?? 0) + 1);
    }
    return counts;
  });

  function memberCountFor(groupId: string): number {
    return memberCounts.value.get(groupId) ?? 0;
  }

  function unreadFor(groupId: string): number {
    return props.groupUnreadByTeam?.get(groupId) ?? 0;
  }

  function unreadLabel(count: number): string {
    return count > 99 ? '99+' : String(count);
  }

  function activeLabelFor(group: Group): string {
    return formatActiveTime(teamActiveTimestamp(group, props.activityByTeam));
  }

  const sortedFolders = computed(() => sortFoldersByName(org.folders));

  const pinnedTeams = computed(() =>
    sortTeamsByActivity(
      filteredGroups.value.filter(group => org.teams[group.id]?.pinned),
      props.activityByTeam,
    ),
  );

  const ungroupedTeams = computed(() =>
    sortTeamsByActivity(
      filteredGroups.value.filter(
        group =>
          !org.teams[group.id]?.pinned &&
          !org.folders.some(folder => folder.id === org.teams[group.id]?.folder),
      ),
      props.activityByTeam,
    ),
  );

  function teamsInFolder(folderId: string): Group[] {
    return sortTeamsByActivity(
      filteredGroups.value.filter(
        group => !org.teams[group.id]?.pinned && org.teams[group.id]?.folder === folderId,
      ),
      props.activityByTeam,
    );
  }

  const visibleFolders = computed(() => {
    if (!hasQuery.value) return sortedFolders.value;
    return sortedFolders.value.filter(folder => teamsInFolder(folder.id).length > 0);
  });

  const recentList = computed(() =>
    recentTeams(props.groups, org.recentIds, 9),
  );

  const showPinnedSection = computed(() => {
    if (segment.value !== 'all' && segment.value !== 'pinned') return false;
    return pinnedTeams.value.length > 0;
  });

  const showFoldersSection = computed(() => {
    if (segment.value !== 'all' && segment.value !== 'folders') return false;
    return visibleFolders.value.length > 0;
  });

  const showUngroupedSection = computed(() => {
    if (segment.value !== 'all' && segment.value !== 'ungrouped') return false;
    return ungroupedTeams.value.length > 0 || dragging.value === 'team';
  });

  function isFolderExpanded(folder: { collapsed?: boolean }): boolean {
    return hasQuery.value || folder.collapsed !== true;
  }

  function isSectionExpanded(section: 'pinned' | 'ungrouped'): boolean {
    if (segment.value !== 'all' || hasQuery.value) return true;
    if (section === 'ungrouped' && dragging.value === 'team' && !ungroupedTeams.value.length) {
      return true;
    }
    return !org.sections[section];
  }

  function containerOfTeam(id: string): ContainerKey {
    return containerOf(id, org.teams[id]);
  }

  function visibleIdsOf(container: ContainerKey | undefined): string[] {
    if (!container) return [];
    if (container === 'pinned') {
      return isSectionExpanded('pinned') ? pinnedTeams.value.map(group => group.id) : [];
    }
    if (container === 'root') {
      return isSectionExpanded('ungrouped') ? ungroupedTeams.value.map(group => group.id) : [];
    }
    const folderId = container.slice('folder:'.length);
    const folder = org.folders.find(item => item.id === folderId);
    return folder && isFolderExpanded(folder)
      ? teamsInFolder(folderId).map(group => group.id)
      : [];
  }

  watch(
    () => props.currentGroupId,
    (id) => {
      selected.value = id ? [id] : [];
      anchor.value = id;
      selectionContainer.value = id ? containerOfTeam(id) : undefined;
    },
    { immediate: true },
  );

  function clearSelection() {
    selected.value = [];
    anchor.value = undefined;
    selectionContainer.value = undefined;
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
    if (result.navigate) {
      org.recordVisit(id);
      emit.select(id);
    }
  }

  function selectRecentTeam(id: string) {
    org.recordVisit(id);
    emit.select(id);
  }

  function dragIds(id: string): string[] {
    const container = containerOfTeam(id);
    if (!selected.value.includes(id) || selectionContainer.value !== container) {
      selected.value = [id];
      anchor.value = id;
      selectionContainer.value = container;
    }
    const visible = visibleIdsOf(container);
    const ordered = visible.filter(item => selected.value.includes(item));
    return ordered.length ? ordered : [id];
  }

  function applyAction(action: SidebarDropAction) {
    switch (action.kind) {
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
      default:
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
    dragging,
    draggingIds,
    dropZone,
  } = useSidebarTeamDrag({
    dragIds,
    applyAction,
    allowReorder: false,
  });

  function containerDropZone(zone: string) {
    return dropZone.value === zone ? 'true' : undefined;
  }

  function toggleFolder(id: string) {
    org.toggleFolder(id);
    pruneSelection();
  }

  function toggleSection(section: 'pinned' | 'ungrouped') {
    org.toggleSection(section);
    pruneSelection();
  }

  function submitCreateFolder() {
    const id = org.createFolder(newFolderName.value);
    if (!id) return;
    newFolderName.value = '';
    creatingFolder.value = false;
  }

  function beginRenameFolder(id: string, name: string) {
    renamingFolder.value = { id, name };
  }

  function submitRenameFolder() {
    if (!renamingFolder.value) return;
    org.renameFolder(renamingFolder.value.id, renamingFolder.value.name);
    renamingFolder.value = undefined;
  }

  function requestArchiveFor(teamId: string) {
    const ids =
      selected.value.length > 1 && selected.value.includes(teamId)
        ? [...selected.value]
        : [teamId];
    emit.archive(ids);
  }

  const allSelectedPinned = computed(
    () => selected.value.length > 0 && selected.value.every(id => Boolean(org.teams[id]?.pinned)),
  );

  function togglePinSelected() {
    if (!selected.value.length) return;
    const ids = [...selected.value];
    const nextPinned = !allSelectedPinned.value;
    org.setPinned(ids, nextPinned);
    if (nextPinned) org.expandSection('pinned');
    clearSelection();
  }

  function archiveSelected() {
    if (!selected.value.length) return;
    emit.archive([...selected.value]);
  }

  function onDocumentPointerDown(event: PointerEvent) {
    if (event.button !== 0 || !selected.value.length) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('.team-row')) return;
    if (target.closest('[data-batch-toolbar="true"]')) return;
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

  return {
    org,
    searchQuery,
    segment,
    SEGMENTS,
    creatingFolder,
    newFolderName,
    renamingFolder,
    hasQuery,
    filteredGroups,
    pinnedTeams,
    ungroupedTeams,
    visibleFolders,
    recentList,
    teamsInFolder,
    memberCountFor,
    unreadFor,
    unreadLabel,
    activeLabelFor,
    showPinnedSection,
    showFoldersSection,
    showUngroupedSection,
    isFolderExpanded,
    isSectionExpanded,
    selected,
    clearSelection,
    selectTeam,
    selectRecentTeam,
    requestArchiveFor,
    allSelectedPinned,
    togglePinSelected,
    archiveSelected,
    toggleFolder,
    toggleSection,
    submitCreateFolder,
    beginRenameFolder,
    submitRenameFolder,
    bindTeamRow,
    bindFolderHeading,
    bindFolderBlock,
    bindPinnedZone,
    bindRootZone,
    dragging,
    draggingIds,
    containerDropZone,
  };
}
