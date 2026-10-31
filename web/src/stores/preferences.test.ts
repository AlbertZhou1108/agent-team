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
  });

  it('loads functional settings while discarding saved custom appearance', () => {
    stubStorage(
      JSON.stringify({
        colorMode: 'light',
        colorTheme: 'ocean',
        appearanceVersion: 2,
        density: 'compact',
        showReasoning: false,
        showRawPayloads: true,
        refreshInterval: 5000,
      }),
    );
    expect(usePreferencesStore().$state).toEqual({
      colorMode: 'light',
      themePack: 'classic',
      themePackSnapshot: null,
      showReasoning: false,
      showRawPayloads: true,
      refreshInterval: 5000,
    });
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
});
