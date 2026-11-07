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

export type GapItem<T> = { key: string; item?: T; gap?: boolean };

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

export function withTeamGap<T extends { id: string }>(
  items: T[],
  preview: SortPreview | undefined,
  container: ContainerKey,
  draggedIds: string[],
): GapItem<T>[] {
  const dragged = new Set(draggedIds);
  const rows: GapItem<T>[] = items
    .filter(item => !dragged.has(item.id))
    .map(item => ({ key: `team:${item.id}`, item }));
  if (preview?.kind === 'team' && preview.container === container) {
    rows.splice(clamp(preview.index, rows.length), 0, { key: `gap:${container}`, gap: true });
  }
  return rows;
}

export function withFolderGap<T extends { id: string }>(
  folders: T[],
  preview: SortPreview | undefined,
  draggedFolderId: string | undefined,
): GapItem<T>[] {
  const rows: GapItem<T>[] = folders
    .filter(folder => folder.id !== draggedFolderId)
    .map(folder => ({ key: `folder:${folder.id}`, item: folder }));
  if (preview?.kind === 'folder') {
    rows.splice(clamp(preview.index, rows.length), 0, { key: 'gap:folders', gap: true });
  }
  return rows;
}
