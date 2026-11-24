import { describe, expect, it, vi } from 'vitest';
import { applyTeamClick, containerOf, resolveSidebarDrop } from '@/features/layout/sidebar-drag';
import type { SidebarDropAction, SidebarDropTarget, SidebarDragSource } from '@/features/layout/sidebar-drag';
import { gapIndexForSource, gapIndexForTarget, withFolderGap, withTeamGap } from '@/features/layout/sidebar-sort-preview';
import type { SortPreview } from '@/features/layout/sidebar-sort-preview';
import { dropSide } from '@/shared/drag-order';
import { NOTE_DRAG_TYPE, TEAM_DRAG_TYPE, TEAM_FOLDER_DRAG_TYPE, folderIdFrom, isNoteDrag, isTeamDrag, isTeamFolderDrag, noteIdsFrom, teamIdsFrom } from '@/shared/pdd-drag';
import type { PddSource } from '@/shared/pdd-drag';
import { withGap } from '@/shared/sort-preview';
import { effectScope, nextTick } from 'vue';
import { usePddBindings } from '@/shared/use-pdd-bindings';
import type { PddBind } from '@/shared/use-pdd-bindings';

describe('sidebar-drag', () => {
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
});

describe('sidebar-sort-preview', () => {
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

    it('被拖项保留为 hidden，空位插在可见序的目标位置', () => {
      const preview: SortPreview = { kind: 'team', container: 'root', index: 1, height: 40 };
      const rows = withTeamGap(items, preview, 'root', ['b']);
      expect(rows).toEqual([
        { key: 'team:a', item: { id: 'a' } },
        { key: 'team:b', item: { id: 'b' }, hidden: true },
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

    it('文件夹预览把被拖文件夹标记 hidden 并插入空位', () => {
      const preview: SortPreview = { kind: 'folder', index: 1, height: 60 };
      const rows = withFolderGap(items, preview, 'a');
      expect(rows).toEqual([
        { key: 'folder:a', item: { id: 'a' }, hidden: true },
        { key: 'folder:b', item: { id: 'b' } },
        { key: 'gap:folders', gap: true },
        { key: 'folder:c', item: { id: 'c' } },
      ]);
    });
  });
});

describe('drag-order', () => {
  const rect = { left: 100, top: 200, width: 200, height: 80 };

  describe('dropSide', () => {
    it('splits a vertical target at its middle for before/after', () => {
      expect(dropSide({ clientX: 0, clientY: 200 }, rect, 'y')).toBe('before');
      expect(dropSide({ clientX: 0, clientY: 239 }, rect, 'y')).toBe('before');
      expect(dropSide({ clientX: 0, clientY: 281 }, rect, 'y')).toBe('after');
      expect(dropSide({ clientX: 0, clientY: 300 }, rect, 'y')).toBe('after');
    });

    it('splits a horizontal target at its middle for before/after', () => {
      expect(dropSide({ clientX: 100, clientY: 0 }, rect, 'x')).toBe('before');
      expect(dropSide({ clientX: 199, clientY: 0 }, rect, 'x')).toBe('before');
      expect(dropSide({ clientX: 201, clientY: 0 }, rect, 'x')).toBe('after');
      expect(dropSide({ clientX: 300, clientY: 0 }, rect, 'x')).toBe('after');
    });

    it('treats the exact middle as before, matching the existing strict comparison', () => {
      expect(dropSide({ clientX: 0, clientY: 240 }, rect, 'y')).toBe('before');
      expect(dropSide({ clientX: 200, clientY: 0 }, rect, 'x')).toBe('before');
    });
  });
});

describe('pdd-drag', () => {
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

    it('笔记 id 只从笔记负载读取，且过滤非法项', () => {
      expect(noteIdsFrom(source({ type: NOTE_DRAG_TYPE, ids: ['a', 'a', 1, 'b'] }))).toEqual(['a', 'b']);
      expect(noteIdsFrom(source({ type: TEAM_DRAG_TYPE, ids: ['a'] }))).toEqual([]);
      expect(noteIdsFrom(source({ type: NOTE_DRAG_TYPE }))).toEqual([]);
    });

    it('文件夹 id 只从文件夹负载读取', () => {
      expect(folderIdFrom(source({ type: TEAM_FOLDER_DRAG_TYPE, folderId: 'f1' }))).toBe('f1');
      expect(folderIdFrom(source({ type: TEAM_DRAG_TYPE, folderId: 'f1' }))).toBeUndefined();
      expect(folderIdFrom(source({ type: TEAM_FOLDER_DRAG_TYPE, folderId: 42 }))).toBeUndefined();
      expect(folderIdFrom(source({ type: TEAM_FOLDER_DRAG_TYPE }))).toBeUndefined();
    });
  });
});

describe('sort-preview', () => {
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
});

describe('use-pdd-bindings', () => {
  function fakeElement(): HTMLElement {
    return { nodeType: 1 } as unknown as HTMLElement;
  }

  function setupSpy() {
    const cleanups: Array<ReturnType<typeof vi.fn>> = [];
    const setup = vi.fn((_element: HTMLElement) => {
      const cleanup = vi.fn();
      cleanups.push(cleanup);
      return cleanup;
    });
    return { setup, cleanups };
  }

  describe('pdd 元素绑定账本', () => {
    it('首次绑定调用一次 setup，且传入的就是该元素', () => {
      const { bind } = usePddBindings();
      const { setup } = setupSpy();
      const element = fakeElement();
      bind('a', element, setup);
      expect(setup).toHaveBeenCalledOnce();
      expect(setup).toHaveBeenCalledWith(element);
    });

    it('卸载后同一元素重新挂载会重新 setup', () => {
      const { bind } = usePddBindings();
      const { setup } = setupSpy();
      const element = fakeElement();
      bind('a', element, setup);
      bind('a', null, setup);
      bind('a', element, setup);
      expect(setup).toHaveBeenCalledTimes(2);
    });

    it('某个 cleanup 抛错时仍清理其余条目，并抛出首个错误', () => {
      const { bind, dispose } = usePddBindings();
      const later = vi.fn();
      bind('a', fakeElement(), () => () => {
        throw new Error('cleanup boom');
      });
      bind('b', fakeElement(), () => later);
      expect(() => dispose()).toThrow('cleanup boom');
      expect(later).toHaveBeenCalledOnce();
    });

    it('同一 key 同一元素重复回调不重复注册', () => {
      const { bind } = usePddBindings();
      const { setup } = setupSpy();
      const element = fakeElement();
      bind('a', element, setup);
      bind('a', element, setup);
      bind('a', element, setup);
      expect(setup).toHaveBeenCalledOnce();
    });

    it('元素被替换时先清理旧的再注册新的', () => {
      const { bind } = usePddBindings();
      const order: string[] = [];
      let index = 0;
      const setup = vi.fn((_element: HTMLElement) => {
        index += 1;
        const tag = index;
        order.push(`setup${tag}`);
        return () => order.push(`cleanup${tag}`);
      });
      bind('a', fakeElement(), setup);
      bind('a', fakeElement(), setup);
      expect(order).toEqual(['setup1', 'cleanup1', 'setup2']);
    });

    it('判重按元素而不是按 setup 身份', () => {
      const { bind } = usePddBindings();
      const element = fakeElement();
      const first = setupSpy();
      const second = setupSpy();
      bind('a', element, first.setup);
      bind('a', element, second.setup);
      expect(first.setup).toHaveBeenCalledOnce();
      expect(second.setup).not.toHaveBeenCalled();
    });

    it('替换元素时新 setup 抛错：旧注册已清理，key 不保留', () => {
      const { bind } = usePddBindings();
      const first = setupSpy();
      const element = fakeElement();
      bind('a', element, first.setup);
      expect(() => bind('a', fakeElement(), () => {
        throw new Error('boom');
      })).toThrow('boom');
      expect(first.cleanups[0]).toHaveBeenCalledOnce();

      const retry = setupSpy();
      bind('a', element, retry.setup);
      expect(retry.setup).toHaveBeenCalledOnce();
    });

    it('元素卸载（null）时清理，重复 null 不重复清理', () => {
      const { bind } = usePddBindings();
      const { setup, cleanups } = setupSpy();
      bind('a', fakeElement(), setup);
      bind('a', null, setup);
      bind('a', undefined, setup);
      expect(cleanups[0]).toHaveBeenCalledOnce();
      expect(setup).toHaveBeenCalledOnce();
    });

    it('非元素值不注册；已有注册时会被清理', () => {
      const { bind } = usePddBindings();
      const { setup, cleanups } = setupSpy();
      bind('a', {} as unknown as Element, setup);
      bind('a', { nodeType: 3 } as unknown as Element, setup);
      expect(setup).not.toHaveBeenCalled();

      bind('b', fakeElement(), setup);
      bind('b', {} as unknown as Element, setup);
      expect(cleanups[0]).toHaveBeenCalledOnce();
    });

    it('dispose 清理全部注册，重复调用不重复清理', () => {
      const { bind, dispose } = usePddBindings();
      const { setup, cleanups } = setupSpy();
      bind('a', fakeElement(), setup);
      bind('b', fakeElement(), setup);
      dispose();
      dispose();
      expect(cleanups[0]).toHaveBeenCalledOnce();
      expect(cleanups[1]).toHaveBeenCalledOnce();
    });

    it('不同 key 互不影响', () => {
      const { bind, dispose } = usePddBindings();
      const { setup, cleanups } = setupSpy();
      bind('a', fakeElement(), setup);
      bind('b', fakeElement(), setup);
      bind('a', null, setup);
      expect(cleanups[0]).toHaveBeenCalledOnce();
      expect(cleanups[1]).not.toHaveBeenCalled();
      dispose();
      expect(cleanups[1]).toHaveBeenCalledOnce();
    });

    it('setup 抛错时不写入注册表，异常向上抛', () => {
      const { bind } = usePddBindings();
      const element = fakeElement();
      expect(() => bind('a', element, () => { throw new Error('boom'); })).toThrow('boom');

      const { setup } = setupSpy();
      bind('a', element, setup);
      expect(setup).toHaveBeenCalledOnce();
    });

    it('所在作用域销毁时自动清理', async () => {
      const { setup, cleanups } = setupSpy();
      const scope = effectScope();
      scope.run(() => {
        const { bind } = usePddBindings();
        bind('a', fakeElement(), setup);
      });
      await nextTick();
      expect(cleanups[0]).not.toHaveBeenCalled();
      scope.stop();
      expect(cleanups[0]).toHaveBeenCalledOnce();
    });

    it('旧元素晚到的卸载回调不会误删新注册', () => {
      const { bind } = usePddBindings();
      const { setup } = setupSpy();
      const first = fakeElement();
      const second = fakeElement();
      bind('a', first, setup);
      bind('a', second, setup);
      bind('a', null, setup, first);

      const probe = setupSpy();
      bind('a', second, probe.setup);
      expect(probe.setup).not.toHaveBeenCalled();
    });

    it('卸载回调携带的元素与当前登记一致时才释放', () => {
      const { bind } = usePddBindings();
      const { setup, cleanups } = setupSpy();
      const element = fakeElement();
      bind('a', element, setup);
      bind('a', null, setup, fakeElement());
      expect(cleanups[0]).not.toHaveBeenCalled();
      bind('a', null, setup, element);
      expect(cleanups[0]).toHaveBeenCalledOnce();
    });
  });

  describe('pdd 绑定类型', () => {
    it('bind 签名接受 null 与 undefined 元素', () => {
      const bind: PddBind = () => {};
      bind('a', null, () => () => {});
      bind('a', undefined, () => () => {});
    });
  });
});
