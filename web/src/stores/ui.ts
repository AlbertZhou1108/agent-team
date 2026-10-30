import { defineStore } from 'pinia';

const storageKey = 'agent-team:ui';

function load() {
  try {
    return {
      sidebarCollapsed: false,
      contextCollapsed: false,
      inspectorOpen: false,
      inspectorWidth: 440,
      sidebarWidth: 248,
      contextWidth: 360,
      composerHeight: 96,
      composerCollapsed: false,
      runCardCollapsed: false,
      ...JSON.parse(localStorage.getItem(storageKey) ?? '{}'),
    };
  } catch {
    return { sidebarWidth: 248, contextWidth: 360, composerHeight: 96, sidebarCollapsed: false, contextCollapsed: false, inspectorOpen: false, inspectorWidth: 440, composerCollapsed: false, runCardCollapsed: false };
  }
}

export const useUiStore = defineStore('ui', {
  state: load,
  actions: {
    persist() {
      localStorage.setItem(storageKey, JSON.stringify({
        sidebarCollapsed: this.sidebarCollapsed,
        contextCollapsed: this.contextCollapsed,
        inspectorWidth: this.inspectorWidth,
        sidebarWidth: this.sidebarWidth,
        contextWidth: this.contextWidth,
        composerHeight: this.composerHeight,
        composerCollapsed: this.composerCollapsed,
        runCardCollapsed: this.runCardCollapsed,
      }));
    },
    toggleSidebar() {
      this.sidebarCollapsed = !this.sidebarCollapsed;
      this.persist();
    },
    toggleContext() {
      this.contextCollapsed = !this.contextCollapsed;
      this.persist();
    },
    openInspector() {
      this.contextCollapsed = false;
      this.inspectorOpen = true;
      this.persist();
    },
    closeInspector() {
      this.inspectorOpen = false;
    },
    setInspectorWidth(width: number) {
      this.inspectorWidth = Math.min(680, Math.max(340, width));
      this.persist();
    },
  },
});
