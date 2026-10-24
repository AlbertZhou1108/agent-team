import { defineStore } from 'pinia';

export type ColorMode = 'dark' | 'light' | 'system';

interface PreferencesState {
  colorMode: ColorMode;
  showReasoning: boolean;
  showRawPayloads: boolean;
  refreshInterval: number;
}

const storageKey = 'agent-team:preferences';

function load(): PreferencesState {
  const fallback: PreferencesState = {
    colorMode: 'system',
    showReasoning: true,
    showRawPayloads: false,
    refreshInterval: 2000,
  };
  try {
    const saved = JSON.parse(
      localStorage.getItem(storageKey) ?? '{}',
    ) as Partial<PreferencesState> & {
      theme?: ColorMode;
    };
    return {
      ...fallback,
      colorMode: saved.colorMode ?? saved.theme ?? fallback.colorMode,
      showReasoning: saved.showReasoning ?? fallback.showReasoning,
      showRawPayloads: saved.showRawPayloads ?? fallback.showRawPayloads,
      refreshInterval: saved.refreshInterval ?? fallback.refreshInterval,
    };
  } catch {
    return fallback;
  }
}

export function resolveDark(colorMode: ColorMode) {
  return (
    colorMode === 'dark' ||
    (colorMode === 'system' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches)
  );
}

export function applyColorMode(colorMode: ColorMode) {
  document.documentElement.classList.toggle('dark', resolveDark(colorMode));
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
    toggleReasoning() {
      this.showReasoning = !this.showReasoning;
      this.persist();
    },
    setShowReasoning(value: boolean) {
      this.showReasoning = value;
      this.persist();
    },
    toggleRawPayloads() {
      this.showRawPayloads = !this.showRawPayloads;
      this.persist();
    },
  },
});
