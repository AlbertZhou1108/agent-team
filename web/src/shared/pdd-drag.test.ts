import { describe, expect, it } from 'vitest';
import {
  NOTE_DRAG_TYPE,
  TEAM_DRAG_TYPE,
  TEAM_FOLDER_DRAG_TYPE,
  folderIdFrom,
  isNoteDrag,
  isTeamDrag,
  isTeamFolderDrag,
  teamIdsFrom,
  type PddSource,
} from './pdd-drag';

const source = (data: Record<string, unknown>): PddSource => ({ data });

describe('pdd 拖拽协议', () => {
  it('三个标签互不相同', () => {
    expect(new Set([NOTE_DRAG_TYPE, TEAM_DRAG_TYPE, TEAM_FOLDER_DRAG_TYPE]).size).toBe(3);
  });

  it('按 type 识别团队、文件夹与笔记拖拽', () => {
    expect(isTeamDrag(source({ type: TEAM_DRAG_TYPE }))).toBe(true);
    expect(isTeamFolderDrag(source({ type: TEAM_FOLDER_DRAG_TYPE }))).toBe(true);
    expect(isNoteDrag(source({ type: NOTE_DRAG_TYPE }))).toBe(true);
    expect(isTeamDrag(source({ type: NOTE_DRAG_TYPE }))).toBe(false);
    expect(isTeamDrag(source({ type: 42 }))).toBe(false);
    expect(isTeamDrag(source({}))).toBe(false);
    expect(isTeamDrag({ data: undefined } as unknown as PddSource)).toBe(false);
    expect(isTeamDrag({} as PddSource)).toBe(false);
  });

  it('团队 id 去重、过滤非字符串并返回新数组', () => {
    const data = { type: TEAM_DRAG_TYPE, ids: ['a', 'b', 'a', 1, null, 'c'] };
    expect(teamIdsFrom(source(data))).toEqual(['a', 'b', 'c']);
    expect(data.ids).toEqual(['a', 'b', 'a', 1, null, 'c']);

    const input = { type: TEAM_DRAG_TYPE, ids: ['a', 'b'] };
    const ids = teamIdsFrom(source(input));
    expect(ids).toEqual(['a', 'b']);
    expect(ids).not.toBe(input.ids);
  });

  it('非团队负载不产生 id', () => {
    expect(teamIdsFrom(source({ type: NOTE_DRAG_TYPE, ids: ['a'] }))).toEqual([]);
    expect(teamIdsFrom(source({ type: TEAM_DRAG_TYPE }))).toEqual([]);
    expect(teamIdsFrom(source({ type: TEAM_DRAG_TYPE, ids: 'a' }))).toEqual([]);
  });

  it('文件夹 id 只从文件夹负载读取', () => {
    expect(folderIdFrom(source({ type: TEAM_FOLDER_DRAG_TYPE, folderId: 'f1' }))).toBe('f1');
    expect(folderIdFrom(source({ type: TEAM_DRAG_TYPE, folderId: 'f1' }))).toBeUndefined();
    expect(folderIdFrom(source({ type: TEAM_FOLDER_DRAG_TYPE, folderId: 42 }))).toBeUndefined();
    expect(folderIdFrom(source({ type: TEAM_FOLDER_DRAG_TYPE }))).toBeUndefined();
  });
});
