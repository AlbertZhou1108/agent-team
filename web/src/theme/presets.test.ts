import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadAppearancePresets,
  saveAppearancePresets,
} from './presets';

const validPreset = {
  id: 'preset-1',
  name: '夜间',
  colorMode: 'dark',
  themePack: 'classic',
  materialPreference: 'glass',
  motionPreference: 'soft',
  density: 'loose',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('appearance presets storage', () => {
  it('returns an empty list without storage or on malformed data', () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
    expect(loadAppearancePresets()).toEqual([]);

    vi.stubGlobal('localStorage', {
      getItem: () => '{not json',
      setItem: () => {},
    });
    expect(loadAppearancePresets()).toEqual([]);

    vi.stubGlobal('localStorage', {
      getItem: () => JSON.stringify([{ id: 'x', name: '坏数据' }]),
      setItem: () => {},
    });
    expect(loadAppearancePresets()).toEqual([]);
  });

  it('round-trips valid presets and drops invalid entries', () => {
    const written: string[] = [];
    vi.stubGlobal('localStorage', {
      getItem: () => (written.length ? written[0] : null),
      setItem: (_key: string, value: string) => written.push(value),
    });
    saveAppearancePresets([validPreset, { id: 'bad' } as never]);
    expect(loadAppearancePresets()).toEqual([validPreset]);
  });
});
