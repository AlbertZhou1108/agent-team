import type { DropSide } from '@/shared/drag-order';
import { selectRange, toggleSelection } from '@/shared/selection';

/** 团队列表的容器：置顶、未分组、或某个文件夹。 */
export type ContainerKey = 'pinned' | 'root' | `folder:${string}`;

export type SidebarDragSource =
  | { type: 'team'; ids: string[] }
  | { type: 'folder'; folderId: string };

export type SidebarDropTarget =
  | { kind: 'team'; id: string }
  | { kind: 'folder'; id: string }
  | { kind: 'pinned' }
  | { kind: 'root' }
  | { kind: 'navigation' };

export type SidebarDropAction =
  | { kind: 'reorder-teams'; ids: string[]; targetId: string; after: boolean }
  | { kind: 'move-teams'; ids: string[]; folderId?: string }
  | { kind: 'pin-teams'; ids: string[] }
  | { kind: 'reorder-folder'; folderId: string; targetId: string; after: boolean }
  | { kind: 'none' };

const NONE: SidebarDropAction = { kind: 'none' };

/** teamId 目前不参与判定，保留它是为了让调用方按团队查询容器时签名稳定。 */
export function containerOf(
  _teamId: string,
  meta: { pinned?: boolean; folder?: string } | undefined,
): ContainerKey {
  if (meta?.pinned) return 'pinned';
  return meta?.folder ? `folder:${meta.folder}` : 'root';
}

export interface TeamClickInput {
  id: string;
  container: ContainerKey;
  selection: string[];
  selectionContainer: ContainerKey | undefined;
  anchor: string | undefined;
  visibleIds: string[];
  currentGroupId: string | undefined;
  shiftKey: boolean;
  toggleKey: boolean;
}

export interface TeamClickResult {
  selected: string[];
  anchor?: string;
  navigate: boolean;
}

/** 点击团队行后的选区结果：普通点击重置，修饰键只在同一容器内扩展。 */
export function applyTeamClick(input: TeamClickInput): TeamClickResult {
  const { id, container, selection, selectionContainer, anchor, visibleIds } = input;

  if (input.shiftKey) {
    if (selectionContainer && selectionContainer !== container) {
      return { selected: [id], anchor: id, navigate: false };
    }
    const next = selectRange(selection, visibleIds, anchor, id);
    return { selected: next.selected, anchor: next.anchor, navigate: false };
  }

  if (input.toggleKey) {
    if (selectionContainer && selectionContainer !== container) {
      return { selected: [id], anchor: id, navigate: false };
    }
    return {
      selected: toggleSelection(selection, id),
      anchor: id,
      navigate: false,
    };
  }

  return {
    selected: [id],
    anchor: id,
    navigate: id !== input.currentGroupId,
  };
}

export function resolveSidebarDrop(
  source: SidebarDragSource,
  target: SidebarDropTarget,
  side: DropSide,
): SidebarDropAction {
  const after = side === 'after';

  if (source.type === 'folder') {
    if (target.kind !== 'folder' || target.id === source.folderId) return NONE;
    return { kind: 'reorder-folder', folderId: source.folderId, targetId: target.id, after };
  }

  const ids = source.ids;
  if (!ids.length) return NONE;

  switch (target.kind) {
    case 'team':
      if (ids.includes(target.id)) return NONE;
      return { kind: 'reorder-teams', ids, targetId: target.id, after };
    case 'folder':
      // 标题与区块共用同一落点数据：团队拖到两者都算归入，
      // 文件夹拖拽时由区块元素的 canDrop 排除，只有标题参与排序。
      return { kind: 'move-teams', ids, folderId: target.id };
    case 'pinned':
      return { kind: 'pin-teams', ids };
    case 'root':
    case 'navigation':
      return { kind: 'move-teams', ids };
  }
}
