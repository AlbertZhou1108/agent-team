import { describe, expect, it } from 'vitest';
import { gapIndexForSource, gapIndexForTarget, withGap } from '@/shared/sort-preview';

describe('单容器排序索引', () => {
  it('源位置按第一个被拖项之前的可见项计数', () => {
    expect(gapIndexForSource(['a', 'b', 'c'], ['b'])).toBe(1);
    expect(gapIndexForSource(['a', 'b', 'c'], ['a'])).toBe(0);
    expect(gapIndexForSource(['a', 'b', 'c'], ['x'])).toBe(0);
  });

  it('目标位置区分前后并过滤被拖项', () => {
    expect(gapIndexForTarget(['a', 'b', 'c'], ['b'], 'c', false)).toBe(1);
    expect(gapIndexForTarget(['a', 'b', 'c'], [], 'b', true)).toBe(2);
    expect(gapIndexForTarget(['a', 'b'], [], 'missing', false)).toBe(0);
  });
});

describe('空位序列', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('隐藏被拖项并在可见索引插入空位', () => {
    expect(withGap(items, { index: 1, height: 40 }, ['b'])).toEqual([
      { key: 'item:a', item: { id: 'a' } },
      { key: 'item:b', item: { id: 'b' }, hidden: true },
      { key: 'sort-gap', gap: true },
      { key: 'item:c', item: { id: 'c' } },
    ]);
  });

  it('无预览时不插空位；越界夹紧到末尾', () => {
    expect(withGap(items, undefined, []).some(row => row.gap)).toBe(false);
    const rows = withGap(items, { index: 99, height: 20 }, []);
    expect(rows[rows.length - 1]).toEqual({ key: 'sort-gap', gap: true });
  });
});
