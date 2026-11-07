import { describe, expect, it } from 'vitest';
import {
  applyTeamClick,
  containerOf,
  resolveSidebarDrop,
  type SidebarDropAction,
  type SidebarDropTarget,
  type SidebarDragSource,
} from './sidebar-drag';

const team = (ids: string[]): SidebarDragSource => ({ type: 'team', ids });
const folder = (folderId: string): SidebarDragSource => ({ type: 'folder', folderId });
const target = (value: SidebarDropTarget) => value;

const NONE: SidebarDropAction = { kind: 'none' };

describe('容器判定', () => {
  it('置顶优先，其次文件夹，最后未分组', () => {
    expect(containerOf('a', { pinned: true, folder: 'f1' })).toBe('pinned');
    expect(containerOf('a', { folder: 'f1' })).toBe('folder:f1');
    expect(containerOf('a', {})).toBe('root');
    expect(containerOf('a', undefined)).toBe('root');
  });
});

describe('点击结果', () => {
  const base = {
    selection: [] as string[],
    selectionContainer: undefined as ReturnType<typeof containerOf> | undefined,
    anchor: undefined as string | undefined,
    visibleIds: ['a', 'b', 'c', 'd'],
    currentGroupId: 'a',
    shiftKey: false,
    toggleKey: false,
  };

  it('普通点击重置为单条，并导航到新团队', () => {
    const result = applyTeamClick({ ...base, id: 'c', container: 'root' });
    expect(result.selected).toEqual(['c']);
    expect(result.anchor).toBe('c');
    expect(result.navigate).toBe(true);
  });

  it('普通点击当前团队只重置选区，不导航', () => {
    const result = applyTeamClick({ ...base, id: 'a', container: 'root' });
    expect(result.selected).toEqual(['a']);
    expect(result.navigate).toBe(false);
  });

  it('同容器 Shift 做区间并集', () => {
    const result = applyTeamClick({
      ...base,
      id: 'd',
      container: 'root',
      selection: ['b'],
      selectionContainer: 'root',
      anchor: 'b',
      shiftKey: true,
    });
    expect(result.selected).toEqual(['b', 'c', 'd']);
    expect(result.navigate).toBe(false);
  });

  it('同容器 Cmd/Ctrl 切换选中态', () => {
    const added = applyTeamClick({
      ...base,
      id: 'c',
      container: 'root',
      selection: ['a'],
      selectionContainer: 'root',
      anchor: 'a',
      toggleKey: true,
    });
    expect(added.selected).toEqual(['a', 'c']);

    const removed = applyTeamClick({
      ...base,
      id: 'a',
      container: 'root',
      selection: ['a', 'c'],
      selectionContainer: 'root',
      anchor: 'a',
      toggleKey: true,
    });
    expect(removed.selected).toEqual(['c']);
  });

  it('跨容器的修饰键点击重新开始选区', () => {
    const shift = applyTeamClick({
      ...base,
      id: 'c',
      container: 'folder:f1',
      selection: ['a', 'b'],
      selectionContainer: 'root',
      anchor: 'a',
      shiftKey: true,
    });
    expect(shift.selected).toEqual(['c']);
    expect(shift.anchor).toBe('c');
    expect(shift.navigate).toBe(false);

    const toggle = applyTeamClick({
      ...base,
      id: 'c',
      container: 'folder:f1',
      selection: ['a', 'b'],
      selectionContainer: 'root',
      anchor: 'a',
      toggleKey: true,
    });
    expect(toggle.selected).toEqual(['c']);
    expect(toggle.anchor).toBe('c');
    expect(toggle.navigate).toBe(false);
  });
});

describe('落点矩阵', () => {
  it('团队投到置顶行：重排，前后两侧都保留', () => {
    expect(resolveSidebarDrop(team(['a']), target({ kind: 'team', id: 'p' }), 'after')).toEqual({
      kind: 'reorder-teams',
      ids: ['a'],
      targetId: 'p',
      after: true,
    });
    expect(resolveSidebarDrop(team(['a']), target({ kind: 'team', id: 'p' }), 'before')).toEqual({
      kind: 'reorder-teams',
      ids: ['a'],
      targetId: 'p',
      after: false,
    });
  });

  it('团队投到文件夹：归入', () => {
    expect(resolveSidebarDrop(team(['a', 'b']), target({ kind: 'folder', id: 'f1' }), 'before')).toEqual({
      kind: 'move-teams',
      ids: ['a', 'b'],
      folderId: 'f1',
    });
  });

  it('团队投到置顶区：置顶', () => {
    expect(resolveSidebarDrop(team(['a']), target({ kind: 'pinned' }), 'before')).toEqual({
      kind: 'pin-teams',
      ids: ['a'],
    });
  });

  it('团队投到未分组或导航：移到根', () => {
    expect(resolveSidebarDrop(team(['a']), target({ kind: 'root' }), 'after')).toEqual({
      kind: 'move-teams',
      ids: ['a'],
    });
    expect(resolveSidebarDrop(team(['a']), target({ kind: 'navigation' }), 'after')).toEqual({
      kind: 'move-teams',
      ids: ['a'],
    });
  });

  it('团队投到自身或选区内的行：无动作', () => {
    expect(resolveSidebarDrop(team(['a', 'b']), target({ kind: 'team', id: 'a' }), 'before')).toEqual(NONE);
    expect(resolveSidebarDrop(team(['a']), target({ kind: 'team', id: 'a' }), 'after')).toEqual(NONE);
  });

  it('空负载无动作', () => {
    expect(resolveSidebarDrop(team([]), target({ kind: 'root' }), 'after')).toEqual(NONE);
  });

  it('文件夹投到其它文件夹标题：重排', () => {
    expect(resolveSidebarDrop(folder('f1'), target({ kind: 'folder', id: 'f2' }), 'after')).toEqual({
      kind: 'reorder-folder',
      folderId: 'f1',
      targetId: 'f2',
      after: true,
    });
  });

  it('文件夹投到自身或无文件夹语义的落点：无动作', () => {
    expect(resolveSidebarDrop(folder('f1'), target({ kind: 'folder', id: 'f1' }), 'before')).toEqual(NONE);
    expect(resolveSidebarDrop(folder('f1'), target({ kind: 'team', id: 'a' }), 'before')).toEqual(NONE);
    expect(resolveSidebarDrop(folder('f1'), target({ kind: 'pinned' }), 'before')).toEqual(NONE);
    expect(resolveSidebarDrop(folder('f1'), target({ kind: 'root' }), 'before')).toEqual(NONE);
    expect(resolveSidebarDrop(folder('f1'), target({ kind: 'navigation' }), 'before')).toEqual(NONE);
  });
});
