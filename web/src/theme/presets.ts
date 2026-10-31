import type { MotionPreference } from '@/shared/motion';
import type { Density, MaterialPreference } from '@/theme/apply';
import type { ColorMode } from '@/stores/preferences';

/** 组合预设:保存明确的外观维度选择(明暗/主题/材质/动效/密度);阅读设置独立,不入预设。 */
export interface AppearancePreset {
  id: string;
  name: string;
  colorMode: ColorMode;
  themePack: string;
  materialPreference: MaterialPreference;
  motionPreference: MotionPreference;
  density: Density;
}

export const APPEARANCE_PRESET_MAX = 12;
export const APPEARANCE_PRESET_NAME_MAX = 30;

const STORAGE_KEY = 'agent-team:appearance-presets';

const COLOR_MODES = ['dark', 'light', 'system'];
const MATERIALS = ['solid', 'glass'];
const MOTIONS = ['system', 'reduced', 'simple', 'soft', 'lively'];
const DENSITIES = ['compact', 'standard', 'loose'];

function isPreset(value: unknown): value is AppearancePreset {
  if (!value || typeof value !== 'object') return false;
  const record = value as AppearancePreset;
  return (
    typeof record.id === 'string' &&
    record.id.length > 0 &&
    typeof record.name === 'string' &&
    record.name.length > 0 &&
    typeof record.themePack === 'string' &&
    COLOR_MODES.includes(record.colorMode) &&
    MATERIALS.includes(record.materialPreference) &&
    MOTIONS.includes(record.motionPreference) &&
    DENSITIES.includes(record.density)
  );
}

export function loadAppearancePresets(): AppearancePreset[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter(isPreset).slice(0, APPEARANCE_PRESET_MAX) : [];
  } catch {
    return [];
  }
}

export function saveAppearancePresets(presets: AppearancePreset[]): void {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(presets.slice(0, APPEARANCE_PRESET_MAX)),
  );
}

export function newPresetId(): string {
  return `preset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
