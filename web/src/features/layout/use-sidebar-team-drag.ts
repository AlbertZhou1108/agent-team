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
  bindTeamRow: (id: string, element: Element | null | undefined) => void;
  bindFolderHeading: (id: string, element: Element | null | undefined) => void;
  bindFolderBlock: (id: string, element: Element | null | undefined) => void;
  bindPinnedZone: (element: Element | null | undefined) => void;
  bindRootZone: (element: Element | null | undefined) => void;
  bindNavigation: (element: Element | null | undefined) => void;
  dragging: Ref<'team' | 'folder' | undefined>;
  draggingIds: Ref<string[]>;
  draggingFolder: Ref<string | undefined>;
  insertion: Ref<{ id: string; kind: 'team' | 'folder'; side: DropSide } | undefined>;
  dropZone: Ref<SidebarDropZone | undefined>;
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

export function useSidebarTeamDrag(options: SidebarTeamDragOptions): SidebarTeamDrag {
  const bindings = usePddBindings();
  const dragging = ref<'team' | 'folder'>();
  const draggingIds = ref<string[]>([]);
  const draggingFolder = ref<string>();
  const insertion = ref<{ id: string; kind: 'team' | 'folder'; side: DropSide }>();
  const dropZone = ref<SidebarDropZone>();

  function clearVisual() {
    insertion.value = undefined;
    dropZone.value = undefined;
  }

  function updateVisual(source: SidebarDragSource, location: DropLocation) {
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

    if (source.type === 'folder') {
      dropZone.value = undefined;
      insertion.value = data.kind === 'folder' && data.id !== source.folderId
        ? { id: data.id, kind: 'folder', side: dropSide(location.input, target.element.getBoundingClientRect(), 'y') }
        : undefined;
      return;
    }

    switch (data.kind) {
      case 'team':
        dropZone.value = undefined;
        insertion.value = source.ids.includes(data.id)
          ? undefined
          : { id: data.id, kind: 'team', side: dropSide(location.input, target.element.getBoundingClientRect(), 'y') };
        return;
      case 'folder':
        insertion.value = undefined;
        dropZone.value = `folder:${data.id}`;
        return;
      case 'pinned':
        insertion.value = undefined;
        dropZone.value = 'pinned';
        return;
      case 'root':
      case 'navigation':
        insertion.value = undefined;
        dropZone.value = 'root';
        return;
    }
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
      const parsed = dragSource(source);
      const target = location.current.dropTargets[0];
      if (parsed && target) {
        const data = targetData(target.data);
        if (data) {
          const action = resolveSidebarDrop(
            parsed,
            data,
            dropSide(location.current.input, target.element.getBoundingClientRect(), 'y'),
          );
          if (action.kind !== 'none') options.applyAction(action);
        }
      }
      clearVisual();
      dragging.value = undefined;
      draggingIds.value = [];
      draggingFolder.value = undefined;
    },
  });

  const bindTeamRow: SidebarTeamDrag['bindTeamRow'] = (id, element) => {
    bindings.bind(`team:${id}`, element, el => combine(
      draggable({
        element: el,
        getInitialData: () => ({ type: TEAM_DRAG_TYPE, ids: options.dragIds(id) }),
      }),
      dropTargetForElements({
        element: el,
        canDrop: ({ source }) => isTeamDrag(source) && !teamIdsFrom(source).includes(id),
        getData: () => ({ kind: 'team', id }),
        getDropEffect: () => 'move',
      }),
    ));
  };

  const bindFolderHeading: SidebarTeamDrag['bindFolderHeading'] = (id, element) => {
    bindings.bind(`folder-heading:${id}`, element, el => combine(
      draggable({
        element: el,
        getInitialData: () => ({ type: TEAM_FOLDER_DRAG_TYPE, folderId: id }),
      }),
      dropTargetForElements({
        element: el,
        canDrop: ({ source }) => isTeamDrag(source)
          || (isTeamFolderDrag(source) && folderIdFrom(source) !== id),
        getData: () => ({ kind: 'folder', id }),
        getDropEffect: () => 'move',
      }),
    ));
  };

  const bindFolderBlock: SidebarTeamDrag['bindFolderBlock'] = (id, element) => {
    bindings.bind(`folder-block:${id}`, element, el => dropTargetForElements({
      element: el,
      canDrop: ({ source }) => isTeamDrag(source),
      getData: () => ({ kind: 'folder', id }),
      getDropEffect: () => 'move',
    }));
  };

  const bindPinnedZone: SidebarTeamDrag['bindPinnedZone'] = element => {
    bindings.bind('pinned', element, el => dropTargetForElements({
      element: el,
      canDrop: ({ source }) => isTeamDrag(source),
      getData: () => ({ kind: 'pinned' }),
      getDropEffect: () => 'move',
    }));
  };

  const bindRootZone: SidebarTeamDrag['bindRootZone'] = element => {
    bindings.bind('root', element, el => dropTargetForElements({
      element: el,
      canDrop: ({ source }) => isTeamDrag(source),
      getData: () => ({ kind: 'root' }),
      getDropEffect: () => 'move',
    }));
  };

  const bindNavigation: SidebarTeamDrag['bindNavigation'] = element => {
    bindings.bind('navigation', element, el => dropTargetForElements({
      element: el,
      canDrop: ({ source }) => isTeamDrag(source),
      getData: () => ({ kind: 'navigation' }),
      getDropEffect: () => 'move',
    }));
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
    dragging,
    draggingIds,
    draggingFolder,
    insertion,
    dropZone,
    dispose,
  };
}
