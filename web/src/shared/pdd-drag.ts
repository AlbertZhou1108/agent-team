/**
 * PDD 拖拽负载的统一标签与守卫。
 * 本模块刻意不 import PDD：source.data 就是普通对象，只依赖结构即可在 node 环境直接测试。
 */

export const NOTE_DRAG_TYPE = 'note-drags';
export const TEAM_DRAG_TYPE = 'team-drags';
export const TEAM_FOLDER_DRAG_TYPE = 'team-folder-drags';

/** PDD 事件里 source 的最小结构。 */
export type PddSource = { data: Record<string, unknown> };

export type TeamDragData = { type: typeof TEAM_DRAG_TYPE; ids: string[] };
export type TeamFolderDragData = { type: typeof TEAM_FOLDER_DRAG_TYPE; folderId: string };

function dataOf(source: PddSource | null | undefined): Record<string, unknown> | undefined {
  const data = source?.data;
  return data && typeof data === 'object' ? data : undefined;
}

export function isNoteDrag(source: PddSource): boolean {
  return dataOf(source)?.type === NOTE_DRAG_TYPE;
}

export function isTeamDrag(source: PddSource): boolean {
  return dataOf(source)?.type === TEAM_DRAG_TYPE;
}

export function isTeamFolderDrag(source: PddSource): boolean {
  return dataOf(source)?.type === TEAM_FOLDER_DRAG_TYPE;
}

/** 去重、过滤非字符串；非团队负载或非法 ids 返回空数组。不修改入参。 */
export function teamIdsFrom(source: PddSource): string[] {
  if (!isTeamDrag(source)) return [];
  const ids = dataOf(source)?.ids;
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.filter((id): id is string => typeof id === 'string'))];
}

export function folderIdFrom(source: PddSource): string | undefined {
  if (!isTeamFolderDrag(source)) return undefined;
  const folderId = dataOf(source)?.folderId;
  return typeof folderId === 'string' ? folderId : undefined;
}
