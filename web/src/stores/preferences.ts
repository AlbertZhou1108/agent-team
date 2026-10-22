import { defineStore } from 'pinia';

export type ColorMode = 'dark' | 'light' | 'system';
export type ColorTheme = 'mist' | 'neutral' | 'ocean' | 'forest' | 'rose' | 'amber';
export type Density = 'comfortable' | 'compact';

interface PreferencesState {
  colorMode: ColorMode;
  colorTheme: ColorTheme;
  appearanceVersion: number;
  density: Density;
  showReasoning: boolean;
  showRawPayloads: boolean;
  refreshInterval: number;
}

const storageKey = 'agent-team:preferences';

function load(): PreferencesState {
  const fallback: PreferencesState = {
    colorMode: 'system',
    colorTheme: 'mist',
    appearanceVersion: 2,
    density: 'comfortable',
    showReasoning: true,
    showRawPayloads: false,
    refreshInterval: 2000,
  };
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? '{}') as Partial<PreferencesState> & {
      theme?: ColorMode;
    };
    return {
      ...fallback,
      ...saved,
      colorMode: saved.colorMode ?? saved.theme ?? fallback.colorMode,
      colorTheme: (saved.appearanceVersion ?? 0) < 2
        && (!saved.colorTheme || saved.colorTheme === 'neutral' || saved.colorTheme === 'ocean')
        ? 'mist'
        : saved.colorTheme ?? fallback.colorTheme,
      appearanceVersion: 2,
    };
  } catch {
    return fallback;
  }
}

export function resolveDark(colorMode: ColorMode) {
  return colorMode === 'dark'
    || (colorMode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

export function applyColorMode(colorMode: ColorMode) {
  document.documentElement.classList.toggle('dark', resolveDark(colorMode));
}

export function applyColorTheme(colorTheme: ColorTheme) {
  document.documentElement.dataset.theme = colorTheme;
}

export const usePreferencesStore = defineStore('preferences', {
  state: load,
  actions: {
    persist() {
      localStorage.setItem(storageKey, JSON.stringify(this.$state));
    },
    setColorMode(colorMode: ColorMode) {
      this.colorMode = colorMode;
      applyColorMode(colorMode);
      this.persist();
    },
    setColorTheme(colorTheme: ColorTheme) {
      this.colorTheme = colorTheme;
      applyColorTheme(colorTheme);
      this.persist();
    },
    setDensity(density: Density) {
      this.density = density;
      document.documentElement.dataset.density = density;
      this.persist();
    },
    toggleReasoning() {
      this.showReasoning = !this.showReasoning;
      this.persist();
    },
    toggleRawPayloads() {
      this.showRawPayloads = !this.showRawPayloads;
      this.persist();
    },
  },
});
