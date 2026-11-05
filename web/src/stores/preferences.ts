import { defineStore } from 'pinia';
import { getDesignPreset, isDesignPresetId, legacyDesignPreset, type DesignPresetId } from '@/theme/design-presets';
import { isMotionPreference, type MotionPreference } from '@/shared/motion';
import { CLASSIC_THEME_ID } from '@/theme/builtin';
import {
  isCodeSize,
  isDensity,
  isMaterialPreference,
  isReadingLeading,
  isReadingSize,
  isReadingWidth,
  type CodeSize,
  type Density,
  type MaterialPreference,
  type ReadingLeading,
  type ReadingSize,
  type ReadingWidth,
} from '@/theme/apply';
import type { ThemeTokens } from '@/theme/tokens';
import { TOOL_SLOTS, builtinTool, type ToolSlot } from '@/tools';

export type ColorMode = 'dark' | 'light' | 'system';

/** 选中主题时缓存的包数据:刷新首帧在请求返回前同步应用,避免闪默认主题。 */
export interface ThemePackSnapshot {
  light: ThemeTokens;
  dark: ThemeTokens;
}

/** 工具模块的用户级状态:工具级禁用 + 挂载级隐藏。hidden 的键是 `${工具id}:${槽位}`。 */
export interface ToolModulesState {
  disabled: Record<string, boolean>;
  hidden: Record<string, boolean>;
}

interface PreferencesState {
  designPreset: DesignPresetId;
  colorMode: ColorMode;
  themePack: string;
  themePackSnapshot: ThemePackSnapshot | null;
  motionPreference: MotionPreference;
  materialPreference: MaterialPreference;
  density: Density;
  readingSize: ReadingSize;
  readingLeading: ReadingLeading;
  readingWidth: ReadingWidth;
  codeSize: CodeSize;
  showReasoning: boolean;
  showRawPayloads: boolean;
  refreshInterval: number;
  toolModules: ToolModulesState;
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

/** 键值都过白名单:非法值直接丢弃,坏数据不进状态。v1 的 surfaces 字段不迁移直接丢弃。 */
function loadToolModules(value: unknown): ToolModulesState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { disabled: {}, hidden: {} };
  }
  const record = value as Record<string, unknown>;
  const entries = (input: unknown) =>
    input && typeof input === 'object' && !Array.isArray(input)
      ? Object.entries(input as Record<string, unknown>)
      : [];
  const knownId = (key: string) => {
    const [toolId] = key.split(':');
    return Boolean(builtinTool(toolId));
  };
  const disabled = Object.fromEntries(
    entries(record.disabled).filter(
      (entry): entry is [string, boolean] =>
        typeof entry[1] === 'boolean' && Boolean(builtinTool(entry[0])),
    ),
  );
  const hidden = Object.fromEntries(
    entries(record.hidden).filter(
      (entry): entry is [string, boolean] =>
        typeof entry[1] === 'boolean' &&
        knownId(entry[0]) &&
        (TOOL_SLOTS as readonly string[]).includes(entry[0].split(':')[1] ?? ''),
    ),
  );
  return { disabled, hidden };
}

function load(): PreferencesState {
  const fallback: PreferencesState = {
    designPreset: 'classic',
    colorMode: 'system',
    themePack: CLASSIC_THEME_ID,
    themePackSnapshot: null,
    motionPreference: 'system',
    materialPreference: 'solid',
    density: 'standard',
    readingSize: 'standard',
    readingLeading: 'standard',
    readingWidth: 'standard',
    codeSize: 'standard',
    showReasoning: true,
    showRawPayloads: false,
    refreshInterval: 2000,
    toolModules: { disabled: {}, hidden: {} },
  };
  try {
    const saved = JSON.parse(
      localStorage.getItem(storageKey) ?? '{}',
    ) as Partial<PreferencesState> & {
      theme?: ColorMode;
    };
    return {
      ...fallback,
      designPreset: isDesignPresetId(saved.designPreset) ? saved.designPreset : legacyDesignPreset(saved.materialPreference),
      // 遗留:旧版本曾把 colorMode 存在 theme 键下,仅用于迁移;主题包用 themePack 键,两者不冲突。
      colorMode: saved.colorMode ?? saved.theme ?? fallback.colorMode,
      themePack:
        typeof saved.themePack === 'string' && saved.themePack
          ? saved.themePack
          : fallback.themePack,
      themePackSnapshot: isThemePackSnapshot(saved.themePackSnapshot)
        ? saved.themePackSnapshot
        : null,
      motionPreference: isMotionPreference(saved.motionPreference)
        ? saved.motionPreference
        : fallback.motionPreference,
      materialPreference: isMaterialPreference(saved.materialPreference)
        ? saved.materialPreference
        : fallback.materialPreference,
      density: isDensity(saved.density) ? saved.density : fallback.density,
      readingSize: isReadingSize(saved.readingSize) ? saved.readingSize : fallback.readingSize,
      readingLeading: isReadingLeading(saved.readingLeading)
        ? saved.readingLeading
        : fallback.readingLeading,
      readingWidth: isReadingWidth(saved.readingWidth) ? saved.readingWidth : fallback.readingWidth,
      codeSize: isCodeSize(saved.codeSize) ? saved.codeSize : fallback.codeSize,
      showReasoning: saved.showReasoning ?? fallback.showReasoning,
      showRawPayloads: saved.showRawPayloads ?? fallback.showRawPayloads,
      refreshInterval: saved.refreshInterval ?? fallback.refreshInterval,
      toolModules: loadToolModules(saved.toolModules),
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
    setDesignPreset(id: DesignPresetId, applyDefaults = true) {
      const preset = getDesignPreset(id);
      this.designPreset = id;
      if (applyDefaults) {
        this.colorMode = preset.dimensions.style.colorMode;
        this.themePack = preset.dimensions.style.themePack;
        this.themePackSnapshot = null;
        this.materialPreference = preset.dimensions.material.id as MaterialPreference;
        this.motionPreference = preset.dimensions.behavior.preference;
        this.density = preset.dimensions.layout.density;
      }
      this.persist();
    },
    setColorMode(colorMode: ColorMode) {
      this.colorMode = colorMode;
      this.persist();
    },
    setThemePack(id: string, snapshot: ThemePackSnapshot | null) {
      this.themePack = id;
      this.themePackSnapshot = snapshot;
      this.persist();
    },
    setMotionPreference(motionPreference: MotionPreference) {
      this.motionPreference = motionPreference;
      this.persist();
    },
    setMaterialPreference(materialPreference: MaterialPreference) {
      this.materialPreference = materialPreference;
      this.persist();
    },
    setDensity(density: Density) {
      this.density = density;
      this.persist();
    },
    setReading(preference: Partial<Pick<PreferencesState, 'readingSize' | 'readingLeading' | 'readingWidth' | 'codeSize'>>) {
      Object.assign(this, preference);
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
    setToolEnabled(id: string, enabled: boolean) {
      if (enabled) delete this.toolModules.disabled[id];
      else this.toolModules.disabled[id] = true;
      this.persist();
    },
    setMountHidden(toolId: string, slot: ToolSlot, hidden: boolean) {
      const key = `${toolId}:${slot}`;
      if (hidden) this.toolModules.hidden[key] = true;
      else delete this.toolModules.hidden[key];
      this.persist();
    },
  },
});
