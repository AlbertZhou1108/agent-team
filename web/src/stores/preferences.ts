import { defineStore } from 'pinia';

export type ThemePreference = 'dark' | 'light' | 'system';
export type Density = 'comfortable' | 'compact';

interface PreferencesState {
  theme: ThemePreference;
  density: Density;
  showReasoning: boolean;
  showRawPayloads: boolean;
  refreshInterval: number;
}

const storageKey = 'agent-team:preferences';

function load(): PreferencesState {
  const fallback: PreferencesState = {
    theme: 'system',
    density: 'comfortable',
    showReasoning: true,
    showRawPayloads: false,
    refreshInterval: 2000,
  };
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem(storageKey) ?? '{}') };
  } catch {
    return fallback;
  }
}

export function resolveDark(theme: ThemePreference) {
  return theme === 'dark'
    || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

export function applyTheme(theme: ThemePreference) {
  document.documentElement.classList.toggle('dark', resolveDark(theme));
}

export const usePreferencesStore = defineStore('preferences', {
  state: load,
  actions: {
    persist() {
      localStorage.setItem(storageKey, JSON.stringify(this.$state));
    },
    setTheme(theme: ThemePreference) {
      this.theme = theme;
      applyTheme(theme);
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
