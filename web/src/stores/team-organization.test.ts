import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useTeamOrganization } from './team-organization';

let saved: string | null;
beforeEach(() => {
  saved = null;
  vi.stubGlobal('localStorage', { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; } });
  setActivePinia(createPinia());
});
describe('team organization', () => {
  it('移动团队并解散文件夹时不丢颜色，移动会清除置顶', () => {
    const store = useTeamOrganization();
    const folder = store.createFolder('测试')!;
    store.color('a', '#22c55e');
    store.move(['a', 'b'], folder);
    expect(store.teams.a.folder).toBe(folder);
    expect(store.teams.a.pinned).toBeUndefined();
    store.togglePin('a');
    store.dissolve(folder);
    expect(store.folders).toEqual([]);
    expect(store.teams.a).toEqual({ color: '#22c55e', pinned: true });
    expect(store.teams.b.folder).toBeUndefined();
  });
  it('restores folder membership, labels and pins from local preferences', () => {
    const store = useTeamOrganization();
    const folder = store.createFolder('演示')!;
    store.move(['a'], folder); store.color(folder, '#3b82f6', true); store.togglePin('a');
    setActivePinia(createPinia());
    const restored = useTeamOrganization();
    expect(restored.teams.a).toEqual({ folder, pinned: true });
    expect(restored.folders[0].color).toBe('#3b82f6');
  });
  it('moves back to root and rejects a missing target folder', () => {
    const store = useTeamOrganization();
    const folder = store.createFolder('测试')!;
    store.move(['a', 'b'], folder); store.move(['a']);
    store.move(['b'], 'missing');
    expect(store.teams.a.folder).toBeUndefined();
    expect(store.teams.b.folder).toBe(folder);
  });
  it('keeps home pinning independent from sidebar pinning', () => {
    const store = useTeamOrganization();

    store.togglePin('sidebar-only');
    store.toggleHomePin('home-only');

    expect(store.teams['sidebar-only']?.pinned).toBe(true);
    expect(store.homePinned).toEqual(['home-only']);

    store.toggleHomePin('home-only');
    expect(store.teams['sidebar-only']?.pinned).toBe(true);
    expect(store.homePinned).toEqual([]);
  });
  it('reorders home cards without moving pinned teams or changing sidebar metadata', () => {
    const store = useTeamOrganization();
    store.toggleHomePin('b');
    store.reorderHomeTeams(['a'], 'b', false, ['a', 'b', 'c']);
    store.reorderHomeTeams(['c', 'b'], 'a', true, ['a', 'b', 'c']);

    expect(store.homeOrder).toEqual(['a', 'c', 'b']);
    expect(store.homePinned).toEqual(['b']);
    expect(store.order).toEqual([]);
    expect(store.teams).toEqual({});
  });
});

it('reorders folders and teams while preserving selected block order and membership', () => {
  const store = useTeamOrganization();
  const a = store.createFolder('A')!, b = store.createFolder('B')!;
  store.reorderFolder(b, a, false);
  expect(store.folders.map(folder => folder.id)).toEqual([b, a]);
  store.move(['target'], a);
  store.reorderTeams(['one', 'two'], 'target', true, ['one', 'target', 'two', 'last']);
  expect(store.order).toEqual(['target', 'one', 'two', 'last']);
  expect(store.teams.one.folder).toBe(a);
  expect(store.teams.two.folder).toBe(a);
  store.reorderTeams(['one', 'two'], 'last', false, ['one', 'target', 'two', 'last']);
  expect(store.teams.one.folder).toBeUndefined();
  expect(store.order).toEqual(['target', 'one', 'two', 'last']);
});

 it('persists independent pinned and ungrouped section collapse states', () => {
   const store = useTeamOrganization();
   expect(store.sections).toEqual({ pinned: false, ungrouped: false });
   store.toggleSection('pinned');
   setActivePinia(createPinia());
   const restored = useTeamOrganization();
   expect(restored.sections).toEqual({ pinned: true, ungrouped: false });
   restored.toggleSection('ungrouped');
   expect(restored.sections).toEqual({ pinned: true, ungrouped: true });
 });

describe('拖拽归属语义', () => {
  it('投放到置顶行：置顶但保留原文件夹归属', () => {
    const store = useTeamOrganization();
    const folder = store.createFolder('F')!;
    store.move(['a'], folder);
    store.togglePin('pinned-target');
    store.reorderTeams(['a'], 'pinned-target', true, ['a', 'pinned-target']);
    expect(store.teams.a?.pinned).toBe(true);
    expect(store.teams.a?.folder).toBe(folder);
  });

  it('投放到普通行：跟随目标文件夹并取消置顶', () => {
    const store = useTeamOrganization();
    const folder = store.createFolder('F')!;
    store.move(['target'], folder);
    store.togglePin('a');
    store.reorderTeams(['a'], 'target', false, ['a', 'target']);
    expect(store.teams.a?.pinned).toBeUndefined();
    expect(store.teams.a?.folder).toBe(folder);
  });

  it('appendTo 追加到容器末尾并处理归属与置顶', () => {
    const store = useTeamOrganization();
    const folder = store.createFolder('F')!;
    store.order = ['x', 'y'];

    store.appendTo(['a', 'b'], { folder, pinned: false });
    expect(store.teams.a?.folder).toBe(folder);
    expect(store.teams.a?.pinned).toBeUndefined();
    expect(store.order).toEqual(['x', 'y', 'a', 'b']);

    store.appendTo(['a'], { pinned: true });
    expect(store.teams.a?.pinned).toBe(true);
    expect(store.teams.a?.folder).toBe(folder);
    expect(store.order).toEqual(['x', 'y', 'b', 'a']);

    store.appendTo(['a'], { pinned: false });
    expect(store.teams.a?.folder).toBeUndefined();
    expect(store.order).toEqual(['x', 'y', 'b', 'a']);
  });

  it('expandFolder 与 expandSection 只在折叠时改变状态', () => {
    const store = useTeamOrganization();
    const folder = store.createFolder('F')!;
    store.toggleFolder(folder);
    store.expandFolder(folder);
    expect(store.folders[0]?.collapsed).toBe(false);

    store.toggleSection('pinned');
    store.expandSection('pinned');
    expect(store.sections.pinned).toBe(false);

    store.expandSection('ungrouped');
    expect(store.sections.ungrouped).toBe(false);
  });

  it('目标不在 order 中时不改动团队归属', () => {
    const store = useTeamOrganization();
    const folder = store.createFolder('F')!;
    store.move(['a'], folder);
    store.reorderTeams(['a'], 'missing', false, []);
    expect(store.teams.a?.folder).toBe(folder);
    expect(store.order).toEqual([]);
  });

  it('appendTo 对不存在的文件夹不改变状态', () => {
    const store = useTeamOrganization();
    store.appendTo(['a'], { folder: 'missing' });
    expect(store.teams.a).toBeUndefined();
    expect(store.order).toEqual([]);
  });

  it('展开动作会持久化', () => {
    const store = useTeamOrganization();
    const folder = store.createFolder('F')!;
    store.toggleFolder(folder);
    store.expandFolder(folder);
    store.toggleSection('pinned');
    store.expandSection('pinned');

    setActivePinia(createPinia());
    const restored = useTeamOrganization();
    expect(restored.folders[0]?.collapsed).toBe(false);
    expect(restored.sections.pinned).toBe(false);
  });
});
