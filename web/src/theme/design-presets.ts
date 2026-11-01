import type { ColorMode } from '@/stores/preferences';
import { freezeConfiguration } from './configuration-data';
import type { MotionPreference } from '@/shared/motion';
import { COMPONENT_DEFAULTS, type ComponentDimension, type ComponentDimensionPatch } from './component-contract';
import { getMaterialCategory, type MaterialCategory } from './materials';

/** 设计预设的五维参数集合;已有主题包与阅读偏好继续兼容。 */
export interface DesignPreset {
  id: string;
  label: string;
  dimensions: {
    style: { themePack: string; colorMode: ColorMode; tokens?: ComponentDimensionPatch['style'] };
    typography: NonNullable<ComponentDimensionPatch['typography']>;
    material: MaterialCategory;
    behavior: { preference: MotionPreference; tokens?: ComponentDimensionPatch['behavior'] };
    layout: { density: 'compact' | 'standard' | 'loose'; tokens?: ComponentDimensionPatch['layout'] };
  };
}

export const DESIGN_PRESETS = freezeConfiguration({
  classic: {
    id: 'classic', label: '默认', dimensions: {
      style: { themePack: 'classic', colorMode: 'system' }, typography: {},
      material: getMaterialCategory('solid'), behavior: { preference: 'system' }, layout: { density: 'standard' },
    },
  },
  'liquid-glass': {
    id: 'liquid-glass', label: '液态玻璃', dimensions: {
      style: { themePack: 'classic', colorMode: 'system', tokens: { '--component-control-radius': 'var(--radius-lg)' } },
      typography: {}, material: getMaterialCategory('glass'),
      behavior: { preference: 'soft', tokens: { '--component-button-press-scale': '0.97' } },
      layout: { density: 'standard', tokens: { '--component-choice-track-padding': '4px', '--component-choice-gap': '4px' } },
    },
  },
  paper: {
    id: 'paper', label: '纸质', dimensions: {
      style: { themePack: 'classic', colorMode: 'system', tokens: { '--component-control-radius': 'var(--radius-sm)', '--component-panel-radius': 'var(--radius-md)' } },
      typography: { '--component-title-font-size': '1.0625rem' }, material: getMaterialCategory('paper'),
      behavior: { preference: 'simple', tokens: { '--component-button-press-scale': '1' } },
      layout: { density: 'standard', tokens: { '--component-nav-padding-x': '14px' } },
    },
  },
} satisfies Record<string, DesignPreset>);

export type DesignPresetId = keyof typeof DESIGN_PRESETS;
export function isDesignPresetId(value: unknown): value is DesignPresetId {
  return typeof value === 'string' && Object.hasOwn(DESIGN_PRESETS, value);
}
export function legacyDesignPreset(material: unknown): DesignPresetId {
  return material === 'glass' ? 'liquid-glass' : material === 'paper' ? 'paper' : 'classic';
}
export function getDesignPreset(id: unknown): DesignPreset {
  return DESIGN_PRESETS[isDesignPresetId(id) ? id : 'classic'];
}

const DENSITY_LAYOUT = {
  compact: { '--component-control-height': '32px', '--component-nav-padding-y': '6px' },
  standard: { '--component-control-height': '36px', '--component-nav-padding-y': '8px' },
  loose: { '--component-control-height': '40px', '--component-nav-padding-y': '10px' },
} satisfies Record<string, ComponentDimensionPatch['layout']>;

/** 完整默认→预设差量→用户对应轴→能力回退。纯函数,不访问 DOM。 */
export function resolveComponentDesign(options: {
  presetId: unknown; preset?: DesignPreset; material: string; density: 'compact' | 'standard' | 'loose'; effectsUsable?: boolean;
}) {
  const preset = options.preset ?? getDesignPreset(options.presetId);
  const requestedMaterial = options.material === preset.dimensions.material.id ? preset.dimensions.material : getMaterialCategory(options.material);
  // Include nested role finishes / optics / motion in the snapshot. Consumers cannot
  // mutate shared registry objects or a different resolution through this result.
  const material = structuredClone(requestedMaterial.effect === 'glass' && options.effectsUsable === false ? getMaterialCategory('solid') : requestedMaterial);
  const dimensions = {
    style: { ...COMPONENT_DEFAULTS.style, ...preset.dimensions.style.tokens },
    typography: { ...COMPONENT_DEFAULTS.typography, ...preset.dimensions.typography },
    material: { ...COMPONENT_DEFAULTS.material, ...material.components },
    behavior: { ...COMPONENT_DEFAULTS.behavior, ...preset.dimensions.behavior.tokens },
    layout: { ...COMPONENT_DEFAULTS.layout, ...preset.dimensions.layout.tokens, ...DENSITY_LAYOUT[options.density] },
  };
  // 平铺只发生在输出边界;每个键在契约中恰好归属一个维度。
  const variables: Record<string, string> = {};
  for (const dimension of Object.keys(dimensions) as ComponentDimension[]) Object.assign(variables, dimensions[dimension]);
  return { presetId: preset.id, material, dimensions, variables };
}
