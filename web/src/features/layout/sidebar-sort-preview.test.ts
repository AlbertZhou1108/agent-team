import { describe, expect, it } from 'vitest';
import {
  gapIndexForSource,
  gapIndexForTarget,
  withFolderGap,
  withTeamGap,
  type SortPreview,
} from './sidebar-sort-preview';

describe('空位索引', () => {
  it('源位置按第一个被拖行之前的可见项计数', () => {
    expect(gapIndexForSource(['a', 'b', 'c'], ['b'])).toBe(1);
    expect(gapIndexForSource(['a', 'b', 'c'], ['a'])).toBe(0);
    expect(gapIndexForSource(['a', 'b', 'c', 'd'], ['b', 'd'])).toBe(1);
    expect(gapIndexForSource(['a', 'b', 'c'], ['x'])).toBe(0);
    expect(gapIndexForSource([], [])).toBe(0);
  });

  it('目标位置区分前后，且在过滤被拖项之后计算', () => {
    expect(gapIndexForTarget(['a', 'b', 'c'], [], 'b', false)).toBe(1);
    expect(gapIndexForTarget(['a', 'b', 'c'], [], 'b', true)).toBe(2);
    expect(gapIndexForTarget(['a', 'b', 'c'], ['b'], 'c', false)).toBe(1);
    expect(gapIndexForTarget(['a', 'b'], [], 'missing', false)).toBe(0);
  });
});

describe('带空位的序列', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('过滤被拖项并在匹配容器插入空位', () => {
    const preview: SortPreview = { kind: 'team', container: 'root', index: 1, height: 40 };
    const rows = withTeamGap(items, preview, 'root', ['b']);
    expect(rows).toEqual([
      { key: 'team:a', item: { id: 'a' } },
      { key: 'gap:root', gap: true },
      { key: 'team:c', item: { id: 'c' } },
    ]);
  });

  it('容器不匹配或没有预览时不插空位', () => {
    const preview: SortPreview = { kind: 'team', container: 'pinned', index: 0, height: 20 };
    expect(withTeamGap(items, preview, 'root', []).some(row => row.gap)).toBe(false);
    expect(withTeamGap(items, undefined, 'root', []).some(row => row.gap)).toBe(false);
  });

  it('索引越界时夹紧到序列两端', () => {
    const preview: SortPreview = { kind: 'team', container: 'root', index: 99, height: 20 };
    const rows = withTeamGap(items, preview, 'root', []);
    expect(rows[rows.length - 1]).toEqual({ key: 'gap:root', gap: true });
  });

  it('文件夹预览过滤被拖文件夹并插入空位', () => {
    const preview: SortPreview = { kind: 'folder', index: 1, height: 60 };
    const rows = withFolderGap(items, preview, 'a');
    expect(rows).toEqual([
      { key: 'folder:b', item: { id: 'b' } },
      { key: 'gap:folders', gap: true },
      { key: 'folder:c', item: { id: 'c' } },
    ]);
  });
});
