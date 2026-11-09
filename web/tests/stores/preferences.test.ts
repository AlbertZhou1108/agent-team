import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { usePreferencesStore } from '@/stores/preferences';

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
  it('migrates old glass preferences and keeps explicit dimension overrides after changing density', () => {
    stubStorage(JSON.stringify({ materialPreference: 'glass', readingSize: 'xlarge' }));
    const store = usePreferencesStore();
    expect(store.designPreset).toBe('liquid-glass');
    store.setDesignPreset('paper');
    expect(store.materialPreference).toBe('paper');
    expect(store.themePack).toBe('ivory');
    expect(store.readingSize).toBe('xlarge');
    store.setDensity('compact');
    expect(store.designPreset).toBe('paper');
    expect(store.materialPreference).toBe('paper');
    store.setMaterialPreference('glass');
    expect(store.designPreset).toBe('paper');
    expect(store.density).toBe('compact');
  });
  it('uses a safe base for unknown design presets without losing other preferences', () => {
    stubStorage(JSON.stringify({ designPreset: 'missing', materialPreference: 'solid', density: 'loose' }));
    const store = usePreferencesStore();
    expect(store.designPreset).toBe('classic');
    expect(store.density).toBe('loose');
  });

});
