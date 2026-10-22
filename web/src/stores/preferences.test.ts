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
  });

  it('defaults to following the system when nothing is saved', () => {
    stubStorage(null);
    setActivePinia(createPinia());

    expect(usePreferencesStore().colorMode).toBe('system');
    expect(usePreferencesStore().colorTheme).toBe('mist');
  });

  it('keeps separately saved color mode and theme', () => {
    stubStorage(JSON.stringify({
      colorMode: 'light',
      colorTheme: 'ocean',
      appearanceVersion: 2,
    }));
    setActivePinia(createPinia());

    expect(usePreferencesStore().colorMode).toBe('light');
    expect(usePreferencesStore().colorTheme).toBe('ocean');
  });

  it('migrates the legacy theme preference as color mode', () => {
    stubStorage(JSON.stringify({ theme: 'dark' }));
    setActivePinia(createPinia());

    expect(usePreferencesStore().colorMode).toBe('dark');
    expect(usePreferencesStore().colorTheme).toBe('mist');
  });

  it('migrates the pre-versioned neutral theme to mist once', () => {
    stubStorage(JSON.stringify({ colorMode: 'light', colorTheme: 'neutral' }));
    setActivePinia(createPinia());

    expect(usePreferencesStore().colorTheme).toBe('mist');
    expect(usePreferencesStore().appearanceVersion).toBe(2);
  });

  it('migrates the previous default ocean theme to mist once', () => {
    stubStorage(JSON.stringify({
      colorMode: 'light',
      colorTheme: 'ocean',
      appearanceVersion: 1,
    }));
    setActivePinia(createPinia());

    expect(usePreferencesStore().colorTheme).toBe('mist');
    expect(usePreferencesStore().appearanceVersion).toBe(2);
  });

  it('preserves a neutral selection after appearance preferences are versioned', () => {
    stubStorage(JSON.stringify({
      colorMode: 'light',
      colorTheme: 'neutral',
      appearanceVersion: 2,
    }));
    setActivePinia(createPinia());

    expect(usePreferencesStore().colorTheme).toBe('neutral');
  });

  it('preserves ocean after the new default preference is versioned', () => {
    stubStorage(JSON.stringify({
      colorMode: 'dark',
      colorTheme: 'ocean',
      appearanceVersion: 2,
    }));
    setActivePinia(createPinia());

    expect(usePreferencesStore().colorTheme).toBe('ocean');
  });
});
