import { getCurrentScope, onScopeDispose, ref, type Ref } from 'vue';
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
  type ElementDragPayload,
} from '@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter';
import { combine } from '@atlaskit/pragmatic-drag-and-drop/utils/combine';
import { dropSide, type DropSide } from '@/shared/drag-order';
import {
  TEAM_DRAG_TYPE,
  TEAM_FOLDER_DRAG_TYPE,
  folderIdFrom,
  isTeamDrag,
  isTeamFolderDrag,
  teamIdsFrom,
} from '@/shared/pdd-drag';
import { usePddBindings } from '@/shared/use-pdd-bindings';
import {
  resolveSidebarDrop,
  type SidebarDragSource,
  type SidebarDropAction,
  type SidebarDropTarget,
} from './sidebar-drag';

export type SidebarDropZone = 'pinned' | 'root' | `folder:${string}`;

export interface SidebarTeamDragOptions {
  /** 拖起某行时的最终负载：必要时先收缩选区，并按当前容器可见顺序排序。 */
  dragIds: (id: string) => string[];
  /** 投放结果，由调用方落到 store 并处理展开。 */
  applyAction: (action: SidebarDropAction) => void;
}

export interface SidebarTeamDrag {
  bindTeamRow: (id: string, element: Element | null | undefined, previous?: Element | null) => void;
  bindFolderHeading: (id: string, element: Element | null | undefined, previous?: Element | null) => void;
  bindFolderBlock: (id: string, element: Element | null | undefined, previous?: Element | null) => void;
  bindPinnedZone: (element: Element | null | undefined, previous?: Element | null) => void;
  bindRootZone: (element: Element | null | undefined, previous?: Element | null) => void;
  bindNavigation: (element: Element | null | undefined, previous?: Element | null) => void;
  /** 排序空位：不是业务落点，只用来让 PDD 在悬停空位时仍有可投放目标。 */
  bindSortGap: (key: string, element: Element | null | undefined, previous?: Element | null) => void;
  dragging: Ref<'team' | 'folder' | undefined>;
  draggingIds: Ref<string[]>;
  draggingFolder: Ref<string | undefined>;
  insertion: Ref<{ id: string; kind: 'team' | 'folder'; side: DropSide } | undefined>;
  dropZone: Ref<SidebarDropZone | undefined>;
  gapHeight: Ref<number>;
  dispose: () => void;
}

type TargetData = Record<string | symbol, unknown>;

type DropLocation = {
  input: { clientX: number; clientY: number };
  dropTargets: Array<{ element: Element; data: TargetData }>;
};

function targetData(data: TargetData): SidebarDropTarget | undefined {
  const kind = data.kind;
  if (kind === 'team' || kind === 'folder') {
    const id = data.id;
    return typeof id === 'string' ? { kind, id } : undefined;
  }
  if (kind === 'pinned' || kind === 'root' || kind === 'navigation') return { kind };
  return undefined;
}

function dragSource(source: ElementDragPayload): SidebarDragSource | undefined {
  if (isTeamDrag(source)) {
    const ids = teamIdsFrom(source);
    return ids.length ? { type: 'team', ids } : undefined;
  }
  if (isTeamFolderDrag(source)) {
    const folderId = folderIdFrom(source);
    return folderId ? { type: 'folder', folderId } : undefined;
  }
  return undefined;
}

function overDraggedRow(input: { clientX: number; clientY: number }, ids: string[]): boolean {
  if (typeof document === 'undefined') return false;
  // elementsFromPoint 而非 elementFromPoint：PDD 的 honey pot 会盖住 2px 区域。
  for (const element of document.elementsFromPoint(input.clientX, input.clientY)) {
    const row = element.closest('[data-team-id]');
    const id = row?.getAttribute('data-team-id');
    if (id && ids.includes(id)) return true;
  }
  return false;
}

/** 指针落在空位上时保留上一个候选位置：空位本身不是投放目标。 */
function overGap(input: { clientX: number; clientY: number }): boolean {
  if (typeof document === 'undefined') return false;
  return document
    .elementsFromPoint(input.clientX, input.clientY)
    .some(element => element.closest('.team-sort-gap') !== null);
}

export function useSidebarTeamDrag(options: SidebarTeamDragOptions): SidebarTeamDrag {
  const bindings = usePddBindings();
  const dragging = ref<'team' | 'folder'>();
  const draggingIds = ref<string[]>([]);
  const draggingFolder = ref<string>();
  const insertion = ref<{ id: string; kind: 'team' | 'folder'; side: DropSide }>();
  const candidate = ref<{ target: SidebarDropTarget; side: DropSide }>();
  const dropZone = ref<SidebarDropZone>();
  const gapHeight = ref(0);

  function measureTeamBlock(ids: string[]): number {
    if (typeof document === 'undefined') return 0;
    const wanted = new Set(ids);
    let height = 0;
    for (const element of document.querySelectorAll<HTMLElement>('[data-team-id]')) {
      const id = element.dataset.teamId;
      if (id && wanted.has(id)) height += element.getBoundingClientRect().height;
    }
    return height;
  }

  function clearVisual() {
    insertion.value = undefined;
    candidate.value = undefined;
    dropZone.value = undefined;
  }

  function updateVisual(source: SidebarDragSource, location: DropLocation) {
    // 空位会随行让位移动到指针下方；此时保留上一个候选，避免预览在源位与目标位之间来回跳。
    if (overGap(location.input)) return;

    const target = location.dropTargets[0];
    if (!target) {
      clearVisual();
      return;
    }
    const data = targetData(target.data);
    if (!data) {
      clearVisual();
      return;
    }
    const side = dropSide(location.input, target.element.getBoundingClientRect(), 'y');

    if (source.type === 'folder') {
      dropZone.value = undefined;
      if (data.kind === 'folder' && data.id !== source.folderId) {
        insertion.value = { id: data.id, kind: 'folder', side };
        candidate.value = { target: data, side };
      } else {
        insertion.value = undefined;
        candidate.value = undefined;
      }
      return;
    }

    switch (data.kind) {
      case 'team':
        dropZone.value = undefined;
        if (source.ids.includes(data.id)) {
          insertion.value = undefined;
          candidate.value = undefined;
        } else {
          insertion.value = { id: data.id, kind: 'team', side };
          candidate.value = { target: data, side };
        }
        return;
      case 'folder':
        insertion.value = undefined;
        dropZone.value = `folder:${data.id}`;
        candidate.value = { target: data, side };
        return;
      case 'pinned':
        insertion.value = undefined;
        dropZone.value = 'pinned';
        candidate.value = { target: data, side };
        return;
      case 'root':
        insertion.value = undefined;
        dropZone.value = 'root';
        candidate.value = { target: data, side };
        return;
      case 'navigation':
        insertion.value = undefined;
        dropZone.value = undefined;
        candidate.value = { target: data, side };
        return;
    }
  }

  function endDrag() {
    clearVisual();
    dragging.value = undefined;
    draggingIds.value = [];
    draggingFolder.value = undefined;
  }

  const stopMonitor = monitorForElements({
    canMonitor: ({ source }) => isTeamDrag(source) || isTeamFolderDrag(source),
    onDragStart: ({ source }) => {
      const parsed = dragSource(source);
      if (!parsed) return;
      if (parsed.type === 'team') {
        dragging.value = 'team';
        draggingIds.value = parsed.ids;
        draggingFolder.value = undefined;
      } else {
        dragging.value = 'folder';
        draggingFolder.value = parsed.folderId;
        draggingIds.value = [];
      }
    },
    onDrag: ({ source, location }) => {
      const parsed = dragSource(source);
      if (parsed) updateVisual(parsed, location.current);
    },
    onDropTargetChange: ({ source, location }) => {
      const parsed = dragSource(source);
      if (parsed) updateVisual(parsed, location.current);
    },
    onDrop: ({ source, location }) => {
      // 取消（Esc、拖出窗口）时 PDD 会清空 dropTargets；此时不能用上一个候选投放。
      if (!location.current.dropTargets.length) {
        endDrag();
        return;
      }
      const parsed = dragSource(source);
      if (parsed?.type === 'team' && overDraggedRow(location.current.input, parsed.ids)) {
        endDrag();
        return;
      }
      const chosen = candidate.value;
      if (parsed && chosen) {
        const action = resolveSidebarDrop(parsed, chosen.target, chosen.side);
        if (action.kind !== 'none') options.applyAction(action);
      }
      endDrag();
    },
  });

  const bindTeamRow: SidebarTeamDrag['bindTeamRow'] = (id, element, previous) => {
    bindings.bind(`team:${id}`, element, el => combine(
      draggable({
        element: el,
        getInitialData: () => {
          const ids = options.dragIds(id);
          gapHeight.value = measureTeamBlock(ids);
          return { type: TEAM_DRAG_TYPE, ids };
        },
      }),
      dropTargetForElements({
        element: el,
        canDrop: ({ source }) => isTeamDrag(source) && !teamIdsFrom(source).includes(id),
        getData: () => ({ kind: 'team', id }),
        getDropEffect: () => 'move',
      }),
    ), previous);
  };

  const bindFolderHeading: SidebarTeamDrag['bindFolderHeading'] = (id, element, previous) => {
    bindings.bind(`folder-heading:${id}`, element, el => combine(
      draggable({
        element: el,
        getInitialData: () => {
          const section = el.closest('.team-folder');
          gapHeight.value = (section ?? el).getBoundingClientRect().height;
          return { type: TEAM_FOLDER_DRAG_TYPE, folderId: id };
        },
      }),
      dropTargetForElements({
        element: el,
        canDrop: ({ source, input }) => (isTeamDrag(source)
          && !overDraggedRow(input, teamIdsFrom(source)))
          || (isTeamFolderDrag(source) && folderIdFrom(source) !== id),
        getData: () => ({ kind: 'folder', id }),
        getDropEffect: () => 'move',
      }),
    ), previous);
  };

  const bindFolderBlock: SidebarTeamDrag['bindFolderBlock'] = (id, element, previous) => {
    bindings.bind(`folder-block:${id}`, element, el => dropTargetForElements({
      element: el,
      canDrop: ({ source, input }) => isTeamDrag(source)
        && !overDraggedRow(input, teamIdsFrom(source)),
      getData: () => ({ kind: 'folder', id }),
      getDropEffect: () => 'move',
    }), previous);
  };

  const bindPinnedZone: SidebarTeamDrag['bindPinnedZone'] = (element, previous) => {
    bindings.bind('pinned', element, el => dropTargetForElements({
      element: el,
      canDrop: ({ source, input }) => isTeamDrag(source)
        && !overDraggedRow(input, teamIdsFrom(source)),
      getData: () => ({ kind: 'pinned' }),
      getDropEffect: () => 'move',
    }), previous);
  };

  const bindRootZone: SidebarTeamDrag['bindRootZone'] = (element, previous) => {
    bindings.bind('root', element, el => dropTargetForElements({
      element: el,
      canDrop: ({ source, input }) => isTeamDrag(source)
        && !overDraggedRow(input, teamIdsFrom(source)),
      getData: () => ({ kind: 'root' }),
      getDropEffect: () => 'move',
    }), previous);
  };

  const bindNavigation: SidebarTeamDrag['bindNavigation'] = (element, previous) => {
    bindings.bind('navigation', element, el => dropTargetForElements({
      element: el,
      canDrop: ({ source, input }) => isTeamDrag(source)
        && !overDraggedRow(input, teamIdsFrom(source)),
      getData: () => ({ kind: 'navigation' }),
      getDropEffect: () => 'move',
    }), previous);
  };

  const bindSortGap: SidebarTeamDrag['bindSortGap'] = (key, element, previous) => {
    bindings.bind(key, element, el => dropTargetForElements({
      element: el,
      canDrop: ({ source }) => isTeamDrag(source) || isTeamFolderDrag(source),
      getData: () => ({ kind: 'gap' }),
      getDropEffect: () => 'move',
    }), previous);
  };

  function dispose() {
    stopMonitor();
    bindings.dispose();
    clearVisual();
  }

  if (getCurrentScope()) onScopeDispose(dispose);

  return {
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
    dispose,
  };
}
