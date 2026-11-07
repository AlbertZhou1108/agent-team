import type { ContainerKey } from './sidebar-drag';

export type TeamSortPreview = {
  kind: 'team';
  container: ContainerKey;
  index: number;
  height: number;
};

export type FolderSortPreview = {
  kind: 'folder';
  index: number;
  height: number;
};

export type SortPreview = TeamSortPreview | FolderSortPreview;

export type GapItem<T> = { key: string; item?: T; gap?: boolean; hidden?: boolean };

/** 被拖行原位置：过滤被拖项后，位于第一个被拖行之前的可见项数量。 */
export function gapIndexForSource(visibleIds: string[], draggedIds: string[]): number {
  const dragged = new Set(draggedIds);
  let index = 0;
  for (const id of visibleIds) {
    if (dragged.has(id)) return index;
    index += 1;
  }
  return 0;
}

/** 目标位置：过滤被拖项后找目标，前插取索引，后插加一。 */
export function gapIndexForTarget(
  visibleIds: string[],
  draggedIds: string[],
  targetId: string,
  after: boolean,
): number {
  const dragged = new Set(draggedIds);
  const filtered = visibleIds.filter(id => !dragged.has(id));
  const index = filtered.indexOf(targetId);
  if (index < 0) return 0;
  return index + (after ? 1 : 0);
}

function clamp(index: number, length: number): number {
  return Math.min(Math.max(index, 0), length);
}

/**
 * 被拖项保留在渲染序列里但标记 hidden：PDD 要求拖拽源在拖拽期间保持挂载，
 * 否则取消时拿不到 dragend，会留下无法收尾的预览。hidden 元素用 display:none 退出布局。
 */
export function withTeamGap<T extends { id: string }>(
  items: T[],
  preview: SortPreview | undefined,
  container: ContainerKey,
  draggedIds: string[],
): GapItem<T>[] {
  const dragged = new Set(draggedIds);
  const visibleCount = items.filter(item => !dragged.has(item.id)).length;
  const gapIndex = preview?.kind === 'team' && preview.container === container
    ? clamp(preview.index, visibleCount)
    : -1;

  const rows: GapItem<T>[] = [];
  let visible = 0;
  let placed = false;
  for (const item of items) {
    if (dragged.has(item.id)) {
      rows.push({ key: `team:${item.id}`, item, hidden: true });
      continue;
    }
    if (!placed && visible === gapIndex) {
      rows.push({ key: `gap:${container}`, gap: true });
      placed = true;
    }
    rows.push({ key: `team:${item.id}`, item });
    visible += 1;
  }
  if (!placed && gapIndex >= 0) {
    rows.push({ key: `gap:${container}`, gap: true });
  }
  return rows;
}

export function withFolderGap<T extends { id: string }>(
  folders: T[],
  preview: SortPreview | undefined,
  draggedFolderId: string | undefined,
): GapItem<T>[] {
  const visibleCount = folders.filter(folder => folder.id !== draggedFolderId).length;
  const gapIndex = preview?.kind === 'folder' ? clamp(preview.index, visibleCount) : -1;

  const rows: GapItem<T>[] = [];
  let visible = 0;
  let placed = false;
  for (const folder of folders) {
    if (folder.id === draggedFolderId) {
      rows.push({ key: `folder:${folder.id}`, item: folder, hidden: true });
      continue;
    }
    if (!placed && visible === gapIndex) {
      rows.push({ key: 'gap:folders', gap: true });
      placed = true;
    }
    rows.push({ key: `folder:${folder.id}`, item: folder });
    visible += 1;
  }
  if (!placed && gapIndex >= 0) {
    rows.push({ key: 'gap:folders', gap: true });
  }
  return rows;
}
