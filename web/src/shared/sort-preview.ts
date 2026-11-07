export type SortPreview = { index: number; size: number };

export type SortItem<T> = { key: string; item?: T; gap?: boolean; hidden?: boolean };

export function gapIndexForSource(ids: string[], draggedIds: string[]): number {
  const dragged = new Set(draggedIds);
  let index = 0;
  for (const id of ids) {
    if (dragged.has(id)) return index;
    index += 1;
  }
  return 0;
}

export function gapIndexForTarget(
  ids: string[],
  draggedIds: string[],
  targetId: string,
  after: boolean,
): number {
  const dragged = new Set(draggedIds);
  const filtered = ids.filter(id => !dragged.has(id));
  const index = filtered.indexOf(targetId);
  if (index < 0) return 0;
  return index + (after ? 1 : 0);
}

function clamp(index: number, length: number): number {
  return Math.min(Math.max(index, 0), length);
}

/** 被拖项保留在序列里并标记 hidden（display:none），保证 PDD 的拖拽源不离开文档。 */
export function withGap<T extends { id: string }>(
  items: T[],
  preview: SortPreview | undefined,
  draggedIds: string[],
): SortItem<T>[] {
  const dragged = new Set(draggedIds);
  const visibleCount = items.filter(item => !dragged.has(item.id)).length;
  const gapIndex = preview ? clamp(preview.index, visibleCount) : -1;

  const rows: SortItem<T>[] = [];
  let visible = 0;
  let placed = false;
  for (const item of items) {
    if (dragged.has(item.id)) {
      rows.push({ key: `item:${item.id}`, item, hidden: true });
      continue;
    }
    if (!placed && visible === gapIndex) {
      rows.push({ key: 'sort-gap', gap: true });
      placed = true;
    }
    rows.push({ key: `item:${item.id}`, item });
    visible += 1;
  }
  if (!placed && gapIndex >= 0) rows.push({ key: 'sort-gap', gap: true });
  return rows;
}
