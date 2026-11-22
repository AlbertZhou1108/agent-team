import { defineStore } from 'pinia';

const storageKey = 'agent-team:ui';

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
    return {
      sidebarCollapsed: false,
      contextCollapsed: false,
      inspectorOpen: false,
      inspectorWidth: 440,
      sidebarWidth: 248,
      contextWidth: 360,
      composerHeight: 96,
      composerCollapsed: true,
      noteComposerCollapsed: true,
      ...saved,
      // 日期分组 key 必须是纯字符串数组;坏的旧值不让整页加载失败。
      noteCollapsedGroups: Array.isArray(saved.noteCollapsedGroups)
        ? saved.noteCollapsedGroups.filter((key: unknown): key is string => typeof key === 'string')
        : [],
      // 高度只认有限数字;范围由输入框自己按视口再夹一次。
      noteComposerHeight: Number.isFinite(saved.noteComposerHeight) ? saved.noteComposerHeight : 128,
    };
  } catch {
    return { sidebarWidth: 248, contextWidth: 360, composerHeight: 96, sidebarCollapsed: false, contextCollapsed: false, inspectorOpen: false, inspectorWidth: 440, composerCollapsed: true, noteComposerCollapsed: true, noteComposerHeight: 128, noteCollapsedGroups: [] };
  }
}

export const useUiStore = defineStore('ui', {
  state: () => ({ ...load(), searchOpen: false }),
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
        noteComposerCollapsed: this.noteComposerCollapsed,
        noteComposerHeight: this.noteComposerHeight,
        noteCollapsedGroups: this.noteCollapsedGroups,
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
