import { defineStore } from 'pinia';
import { CLASSIC_THEME_ID } from '@/theme/builtin';
import type { ThemeTokens } from '@/theme/tokens';

export type ColorMode = 'dark' | 'light' | 'system';

/** 选中主题时缓存的包数据:刷新首帧在请求返回前同步应用,避免闪默认主题。 */
export interface ThemePackSnapshot {
  light: ThemeTokens;
  dark: ThemeTokens;
}

interface PreferencesState {
  colorMode: ColorMode;
  themePack: string;
  themePackSnapshot: ThemePackSnapshot | null;
  showReasoning: boolean;
  showRawPayloads: boolean;
  refreshInterval: number;
}

const storageKey = 'agent-team:preferences';

function isThemePackSnapshot(value: unknown): value is ThemePackSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.light !== null &&
    typeof record.light === 'object' &&
    record.dark !== null &&
    typeof record.dark === 'object'
  );
}

function load(): PreferencesState {
  const fallback: PreferencesState = {
    colorMode: 'system',
    themePack: CLASSIC_THEME_ID,
    themePackSnapshot: null,
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
      // 遗留:旧版本曾把 colorMode 存在 theme 键下,仅用于迁移;主题包用 themePack 键,两者不冲突。
      colorMode: saved.colorMode ?? saved.theme ?? fallback.colorMode,
      themePack:
        typeof saved.themePack === 'string' && saved.themePack
          ? saved.themePack
          : fallback.themePack,
      themePackSnapshot: isThemePackSnapshot(saved.themePackSnapshot)
        ? saved.themePackSnapshot
        : null,
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

export const usePreferencesStore = defineStore('preferences', {
  state: load,
  actions: {
    persist() {
      localStorage.setItem(storageKey, JSON.stringify(this.$state));
    },
    // 外观应用统一由 theme/application 收口,这里只改偏好并持久化。
    setColorMode(colorMode: ColorMode) {
      this.colorMode = colorMode;
      this.persist();
    },
    setThemePack(id: string, snapshot: ThemePackSnapshot | null) {
      this.themePack = id;
      this.themePackSnapshot = snapshot;
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
