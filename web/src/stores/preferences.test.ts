import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { usePreferencesStore } from './preferences';

function stubStorage(value: string | null) {
  vi.stubGlobal('localStorage', {
    getItem: () => value,
    setItem: () => {},
  });
}

describe('preferences theme default', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to following the system when nothing is saved', () => {
    stubStorage(null);
    setActivePinia(createPinia());

    expect(usePreferencesStore().theme).toBe('system');
  });

  it('keeps a previously saved explicit theme', () => {
    stubStorage(JSON.stringify({ theme: 'light' }));
    setActivePinia(createPinia());

    expect(usePreferencesStore().theme).toBe('light');
  });
});
