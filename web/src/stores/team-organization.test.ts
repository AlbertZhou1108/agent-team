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
  it('moves multiple teams and dissolves folders without losing colors or pins', () => {
    const store = useTeamOrganization();
    const folder = store.createFolder('测试')!;
    store.color('a', '#22c55e'); store.togglePin('a');
    store.move(['a', 'b'], folder);
    expect(store.teams.b.folder).toBe(folder);
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
