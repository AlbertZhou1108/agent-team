/** 多选通用辅助：Shift 区间并集与 Cmd/Ctrl 间断切换。 */

export function selectRange(
  selected: string[],
  visibleIds: string[],
  anchorId: string | undefined,
  id: string,
): { selected: string[]; anchor: string } {
  const start = visibleIds.indexOf(anchorId ?? id);
  const end = visibleIds.indexOf(id);
  const range = start >= 0 && end >= 0
    ? visibleIds.slice(Math.min(start, end), Math.max(start, end) + 1)
    : [id];
  return { selected: [...new Set([...selected, ...range])], anchor: anchorId ?? id };
}

export function toggleSelection(selected: string[], id: string): string[] {
  return selected.includes(id)
    ? selected.filter(item => item !== id)
    : [...selected, id];
}
