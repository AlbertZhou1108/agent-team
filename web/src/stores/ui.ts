import { defineStore } from 'pinia';

const storageKey = 'agent-team:ui';

function load() {
  try {
    return {
      sidebarCollapsed: false,
      inspectorOpen: false,
      inspectorWidth: 440,
      settingsOpen: false,
      ...JSON.parse(localStorage.getItem(storageKey) ?? '{}'),
    };
  } catch {
    return { sidebarCollapsed: false, inspectorOpen: false, inspectorWidth: 440, settingsOpen: false };
  }
}

export const useUiStore = defineStore('ui', {
  state: load,
  actions: {
    persist() {
      localStorage.setItem(storageKey, JSON.stringify({
        sidebarCollapsed: this.sidebarCollapsed,
        inspectorWidth: this.inspectorWidth,
      }));
    },
    toggleSidebar() {
      this.sidebarCollapsed = !this.sidebarCollapsed;
      this.persist();
    },
    openInspector() {
      this.inspectorOpen = true;
    },
    closeInspector() {
      this.inspectorOpen = false;
    },
    openSettings() {
      this.settingsOpen = true;
    },
    closeSettings() {
      this.settingsOpen = false;
    },
    setInspectorWidth(width: number) {
      this.inspectorWidth = Math.min(680, Math.max(340, width));
      this.persist();
    },
  },
});
