import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { usePreferencesStore } from './preferences';

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
    });
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
