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
    expect(usePreferencesStore().colorMode).toBe('system');
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
      showReasoning: false,
      showRawPayloads: true,
      refreshInterval: 5000,
    });
  });

  it('migrates the legacy theme preference as color mode', () => {
    stubStorage(JSON.stringify({ theme: 'dark' }));
    expect(usePreferencesStore().colorMode).toBe('dark');
  });
});
