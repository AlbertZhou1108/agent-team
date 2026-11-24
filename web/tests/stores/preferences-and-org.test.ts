import { describe, beforeEach, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { usePreferencesStore } from '@/stores/preferences';
import { useTeamOrganization } from '@/stores/team-organization';

describe('preferences', () => {
  function stubStorage(value: string | null) {
    vi.stubGlobal('localStorage', {
      getItem: () => value,
      setItem: () => {},
    });
  }

  describe('preferences appearance', () => {
    beforeEach(() => {
      vi.unstubAllGlobals();
      setActivePinia(createPinia());
    });

    it('defaults to following the system when nothing is saved', () => {
      stubStorage(null);
      const store = usePreferencesStore();
      expect(store.colorMode).toBe('system');
      expect(store.themePack).toBe('classic');
      expect(store.themePackSnapshot).toBeNull();
      expect(store.motionPreference).toBe('system');
    });

    it('loads functional settings while discarding saved custom appearance', () => {
      stubStorage(
        JSON.stringify({
          colorMode: 'light',
          colorTheme: 'ocean',
          appearanceVersion: 2,
          density: 'compact',
          motionPreference: 'soft',
          showReasoning: false,
          showRawPayloads: true,
          refreshInterval: 5000,
        }),
      );
      expect(usePreferencesStore().$state).toEqual({
        designPreset: 'classic',
        colorMode: 'light',
        themePack: 'classic',
        themePackSnapshot: null,
        motionPreference: 'soft',
        materialPreference: 'solid',
        density: 'compact',
        readingSize: 'standard',
        readingLeading: 'standard',
        readingWidth: 'standard',
        codeSize: 'standard',
        showReasoning: false,
        showRawPayloads: true,
        refreshInterval: 5000,
        toolModules: { disabled: {}, hidden: {}, order: {}, pinned: {} },
        primaryNavOrder: ['home', 'team', 'agent'],
      });
    });

    it('loads tool module state, discarding unknown tools and slots; drops the legacy surfaces field', () => {
      stubStorage(JSON.stringify({
        toolModules: {
          disabled: { 'builtin.notes': true, 'builtin.ghost': true },
          hidden: { 'builtin.coordination:right-tools': true, 'builtin.notes:bogus': true },
          surfaces: { 'builtin.coordination': 'right-tab' },
        },
      }));
      const store = usePreferencesStore();
      expect(store.toolModules).toEqual({
        disabled: { 'builtin.notes': true },
        hidden: { 'builtin.coordination:right-tools': true },
        order: {},
        pinned: {},
      });
    });

    it('keeps only known-tool order lists and drops non-string entries', () => {
      stubStorage(JSON.stringify({
        toolModules: {
          order: {
            'right-tools': ['builtin.notes:right-tools', 'builtin.coordination:right-tools', 42],
            'right-bogus': ['x'],
          },
        },
      }));
      expect(usePreferencesStore().toolModules.order).toEqual({
        'right-tools': ['builtin.notes:right-tools', 'builtin.coordination:right-tools'],
      });
    });

    it('keeps only known pinned mounts and ignores unknown slots', () => {
      stubStorage(JSON.stringify({
        toolModules: {
          pinned: {
            'right-tools': ['builtin.notes:right-tools', 'builtin.ghost:right-tools', 7],
            'right-bogus': ['builtin.notes:right-tools'],
          },
        },
      }));
      expect(usePreferencesStore().toolModules.pinned).toEqual({
        'right-tools': ['builtin.notes:right-tools'],
      });
    });

    it('pins and unpins a mount without touching the drag order', () => {
      const written: string[] = [];
      vi.stubGlobal('localStorage', {
        getItem: () => null,
        setItem: (_key: string, value: string) => written.push(value),
      });
      const store = usePreferencesStore();
      store.setToolOrder('right-tools', ['builtin.notes:right-tools', 'builtin.coordination:right-tools']);
      store.setToolPinned('right-tools', 'builtin.coordination:right-tools', true);
      expect(store.toolModules.pinned['right-tools']).toEqual(['builtin.coordination:right-tools']);
      expect(store.toolModules.order['right-tools']).toEqual([
        'builtin.notes:right-tools', 'builtin.coordination:right-tools',
      ]);
      store.setToolPinned('right-tools', 'builtin.coordination:right-tools', false);
      expect(store.toolModules.pinned['right-tools']).toEqual([]);
      expect(JSON.parse(written.at(-1)!).toolModules.pinned['right-tools']).toEqual([]);
    });

    it('toggles and persists mount visibility', () => {
      const written: string[] = [];
      vi.stubGlobal('localStorage', {
        getItem: () => null,
        setItem: (_key: string, value: string) => written.push(value),
      });
      const store = usePreferencesStore();
      store.setMountHidden('builtin.coordination', 'right-tools', true);
      expect(store.toolModules.hidden['builtin.coordination:right-tools']).toBe(true);
      store.setMountHidden('builtin.coordination', 'right-tools', false);
      expect(store.toolModules.hidden).toEqual({});
      expect(JSON.parse(written.at(-1)!).toolModules.hidden).toEqual({});

      store.setMountHidden('builtin.coordination', 'team-tabs', true);
      expect(store.toolModules.hidden['builtin.coordination:team-tabs']).toBe(true);
      store.setMountHidden('builtin.coordination', 'team-tabs', false);
      expect(store.toolModules.hidden).toEqual({});
    });

    it('toggles and persists tool enablement', () => {
      const written: string[] = [];
      vi.stubGlobal('localStorage', {
        getItem: () => null,
        setItem: (_key: string, value: string) => written.push(value),
      });
      const store = usePreferencesStore();
      store.setToolEnabled('builtin.notes', false);
      expect(store.toolModules.disabled['builtin.notes']).toBe(true);
      store.setToolEnabled('builtin.notes', true);
      expect(store.toolModules.disabled['builtin.notes']).toBeUndefined();
      expect(JSON.parse(written.at(-1)!).toolModules.disabled).toEqual({});
    });

    it('falls back to system motion when the saved value is unknown', () => {
      stubStorage(JSON.stringify({ motionPreference: 'bouncy' }));
      expect(usePreferencesStore().motionPreference).toBe('system');
    });

    it('falls back to solid material when the saved value is unknown', () => {
      stubStorage(JSON.stringify({ materialPreference: 'hologram' }));
      expect(usePreferencesStore().materialPreference).toBe('solid');
    });

    it('falls back to standard reading values when the saved values are unknown', () => {
      stubStorage(JSON.stringify({ readingSize: 'huge', readingWidth: 999, codeSize: null }));
      const store = usePreferencesStore();
      expect(store.readingSize).toBe('standard');
      expect(store.readingWidth).toBe('standard');
      expect(store.codeSize).toBe('standard');
    });

    it('migrates the legacy theme preference as color mode', () => {
      stubStorage(JSON.stringify({ theme: 'dark' }));
      expect(usePreferencesStore().colorMode).toBe('dark');
    });

    it('keeps theme pack selection separate from the legacy theme key', () => {
      // 遗留 theme 键是 colorMode 别名,不得被主题包读取;themePack 缺失时回落 classic。
      stubStorage(JSON.stringify({ theme: 'dark', themePack: 'ocean' }));
      const store = usePreferencesStore();
      expect(store.colorMode).toBe('dark');
      expect(store.themePack).toBe('ocean');
    });

    it('persists theme pack selection with snapshot for first paint', () => {
      const written: string[] = [];
      vi.stubGlobal('localStorage', {
        getItem: () => null,
        setItem: (_key: string, value: string) => written.push(value),
      });
      const store = usePreferencesStore();
      const snapshot = { light: { background: '#fff' } as never, dark: { background: '#000' } as never };
      store.setThemePack('ocean', snapshot);
      expect(store.themePack).toBe('ocean');
      expect(store.themePackSnapshot).toStrictEqual(snapshot);
      expect(written.length).toBe(1);
      expect(JSON.parse(written[0]!).themePack).toBe('ocean');
    });

    it('discards malformed snapshots from storage', () => {
      stubStorage(JSON.stringify({ themePack: 'ocean', themePackSnapshot: { light: 'nope' } }));
      expect(usePreferencesStore().themePackSnapshot).toBeNull();
    });
    it('migrates legacy glass ids to frosted on load', () => {
      stubStorage(JSON.stringify({ designPreset: 'liquid-glass', materialPreference: 'glass' }));
      const store = usePreferencesStore();
      expect(store.designPreset).toBe('frosted-glass');
      expect(store.materialPreference).toBe('frosted');
    });

    it('migrates a material-only legacy glass preference and keeps explicit overrides', () => {
      stubStorage(JSON.stringify({ materialPreference: 'glass', readingSize: 'xlarge' }));
      const store = usePreferencesStore();
      expect(store.designPreset).toBe('frosted-glass');
      expect(store.materialPreference).toBe('frosted');
      store.setDesignPreset('paper');
      expect(store.materialPreference).toBe('paper');
      expect(store.themePack).toBe('ivory');
      expect(store.readingSize).toBe('xlarge');
      store.setDensity('compact');
      expect(store.designPreset).toBe('paper');
      expect(store.materialPreference).toBe('paper');
      store.setMaterialPreference('frosted');
      expect(store.designPreset).toBe('paper');
      expect(store.density).toBe('compact');
    });
    it('uses a safe base for unknown design presets without losing other preferences', () => {
      stubStorage(JSON.stringify({ designPreset: 'missing', materialPreference: 'solid', density: 'loose' }));
      const store = usePreferencesStore();
      expect(store.designPreset).toBe('classic');
      expect(store.density).toBe('loose');
    });

    it('persists builtin.search disable/hide state and left-nav order', () => {
      const written: string[] = [];
      vi.stubGlobal('localStorage', {
        getItem: () => null,
        setItem: (_key: string, value: string) => written.push(value),
      });
      const store = usePreferencesStore();
      store.setToolEnabled('builtin.search', false);
      store.setMountHidden('builtin.search', 'left-nav', true);
      store.setToolOrder('left-nav', ['builtin.notes:left-nav', 'builtin.search:left-nav']);
      expect(store.toolModules.disabled['builtin.search']).toBe(true);
      expect(store.toolModules.hidden['builtin.search:left-nav']).toBe(true);
      expect(store.toolModules.order['left-nav']).toEqual(['builtin.notes:left-nav', 'builtin.search:left-nav']);
      const saved = written.at(-1)!;
      stubStorage(saved);
      setActivePinia(createPinia());
      const restored = usePreferencesStore();
      expect(restored.toolModules.disabled['builtin.search']).toBe(true);
      expect(restored.toolModules.hidden['builtin.search:left-nav']).toBe(true);
      expect(restored.toolModules.order['left-nav']).toEqual(['builtin.notes:left-nav', 'builtin.search:left-nav']);
    });

    it('normalizes and persists primaryNavOrder without dropping fixed items', () => {
      const written: string[] = [];
      vi.stubGlobal('localStorage', {
        getItem: () => JSON.stringify({ primaryNavOrder: ['agent', 'bogus', 'agent'] }),
        setItem: (_key: string, value: string) => written.push(value),
      });
      const store = usePreferencesStore();
      expect(store.primaryNavOrder).toEqual(['agent', 'home', 'team']);
      store.setPrimaryNavOrder(['team', 'home', 'agent']);
      expect(store.primaryNavOrder).toEqual(['team', 'home', 'agent']);
      expect(JSON.parse(written.at(-1)!).primaryNavOrder).toEqual(['team', 'home', 'agent']);
    });

  });
});

describe('team-organization', () => {
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

   it('persists independent pinned and ungrouped section collapse states (default collapsed)', () => {
     const store = useTeamOrganization();
     expect(store.sections).toEqual({ pinned: true, ungrouped: true });
     store.toggleSection('pinned');
     setActivePinia(createPinia());
     const restored = useTeamOrganization();
     expect(restored.sections).toEqual({ pinned: false, ungrouped: true });
     restored.toggleSection('ungrouped');
     expect(restored.sections).toEqual({ pinned: false, ungrouped: false });
   });

   it('creates folders collapsed by default while respecting persisted expanded folders', () => {
     const store = useTeamOrganization();
     const folder = store.createFolder('前端开发')!;
     expect(store.folders[0]?.collapsed).toBe(true);
     store.toggleFolder(folder);
     expect(store.folders[0]?.collapsed).toBe(false);
     setActivePinia(createPinia());
     const restored = useTeamOrganization();
     expect(restored.folders[0]?.collapsed).toBe(false);
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
      expect(store.folders[0]?.collapsed).toBe(true);
      store.expandFolder(folder);
      expect(store.folders[0]?.collapsed).toBe(false);

      expect(store.sections.pinned).toBe(true);
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
      store.expandFolder(folder);
      store.expandSection('pinned');

      setActivePinia(createPinia());
      const restored = useTeamOrganization();
      expect(restored.folders[0]?.collapsed).toBe(false);
      expect(restored.sections.pinned).toBe(false);
    });
  });

  describe('最近访问记录', () => {
    it('置顶去重、最多保留 9 个最近访问团队并持久化', () => {
      const store = useTeamOrganization();
      for (let i = 1; i <= 10; i += 1) {
        store.recordVisit(`g-${i}`);
      }
      expect(store.recentIds).toEqual([
        'g-10', 'g-9', 'g-8', 'g-7', 'g-6', 'g-5', 'g-4', 'g-3', 'g-2',
      ]);

      // 再次访问已有项应保持原位而不移至首位，空白 ID 忽略。
      store.recordVisit('g-4');
      store.recordVisit('   ');
      expect(store.recentIds).toEqual([
        'g-10', 'g-9', 'g-8', 'g-7', 'g-6', 'g-5', 'g-4', 'g-3', 'g-2',
      ]);

      setActivePinia(createPinia());
      const restored = useTeamOrganization();
      expect(restored.recentIds).toEqual([
        'g-10', 'g-9', 'g-8', 'g-7', 'g-6', 'g-5', 'g-4', 'g-3', 'g-2',
      ]);
    });

    it('setPinned 支持批量置顶与取消置顶并保留原文件夹与颜色', () => {
      const store = useTeamOrganization();
      const folder = store.createFolder('分组')!;
      store.move(['a', 'b'], folder);
      store.color('a', '#22c55e');

      store.setPinned(['a', 'b'], true);
      expect(store.teams.a).toEqual({ folder, color: '#22c55e', pinned: true });
      expect(store.teams.b).toEqual({ folder, pinned: true });

      store.setPinned(['a', 'b'], false);
      expect(store.teams.a).toEqual({ folder, color: '#22c55e' });
      expect(store.teams.b).toEqual({ folder });
    });
  });
});
