import { describe, expect, it, vi } from 'vitest';
import { applyComponentDesign } from './apply';
import { COMPONENT_DEFAULTS } from './component-contract';
import { DESIGN_PRESETS, resolveComponentDesign, type DesignPreset } from './design-presets';

const resolve = (presetId = 'liquid-glass', material = 'glass', density: 'standard' | 'compact' | 'loose' = 'standard') => resolveComponentDesign({ presetId, material, density });

describe('five-dimension component configuration', () => {
  it('replaces the complete applied output across repeated preset switches', () => {
    const values = new Map<string, string>();
    const root = { dataset: {} as Record<string, string>, style: { setProperty: (key: string, value: string) => values.set(key, value) } };
    vi.stubGlobal('document', { documentElement: root });
    try {
      for (const id of ['liquid-glass', 'paper', 'classic', 'paper', 'liquid-glass'] as const) {
        const material = DESIGN_PRESETS[id].dimensions.material.id;
        const output = resolve(id, material);
        applyComponentDesign({ designPreset: id, materialPreference: material, density: 'standard' }, output);
        expect(root.dataset.designPreset).toBe(id);
        expect(Object.fromEntries(values)).toEqual(output.variables);
      }
    } finally { vi.unstubAllGlobals(); }
  });
  it('isolates nested role recipes and every axis between resolutions', () => {
    const baseline = resolve();
    const changed = resolve();
    changed.material.roles['nav-panel']!.refraction!.strength = 999;
    changed.material.motion.signature = 'none';
    changed.dimensions.style['--component-control-radius'] = '99px';
    changed.variables['--component-content-bg'] = 'red';
    expect(resolve()).toEqual(baseline);
    expect(resolve('paper', 'paper')).not.toEqual(changed);
  });
  it('keeps editing a glass preset local to that preset across all five axes', () => {
    const paper = resolve('paper', 'paper');
    const classic = resolve('classic', 'solid');
    const custom: DesignPreset = structuredClone(DESIGN_PRESETS['liquid-glass']);
    custom.dimensions.style.tokens!['--component-control-radius'] = '19px';
    custom.dimensions.typography['--component-title-font-size'] = '1.5rem';
    custom.dimensions.material.roles['nav-panel']!.bg = 'transparent';
    custom.dimensions.behavior.tokens!['--component-button-press-scale'] = '0.9';
    custom.dimensions.layout.tokens = { '--component-panel-gap': '22px' };
    const output = resolveComponentDesign({ presetId: custom.id, preset: custom, material: 'glass', density: 'standard' });
    expect(output.variables['--component-control-radius']).toBe('19px');
    expect(output.variables['--component-title-font-size']).toBe('1.5rem');
    expect(output.variables['--component-panel-gap']).toBe('22px');
    expect(output.material.roles['nav-panel']!.bg).toBe('transparent');
    expect(resolve('paper', 'paper')).toEqual(paper);
    expect(resolve('classic', 'solid')).toEqual(classic);
  });
  it('protects shared defaults and built-in recipes from accidental mutation', () => {
    expect(Object.isFrozen(COMPONENT_DEFAULTS.style)).toBe(true);
    expect(Object.isFrozen(DESIGN_PRESETS.paper.dimensions)).toBe(true);
    expect(Object.isFrozen(DESIGN_PRESETS['liquid-glass'].dimensions.material.roles['nav-panel']!.refraction)).toBe(true);
  });
  it('owns every variable in exactly one dimension and always emits the complete contract', () => {
    const keys = Object.values(COMPONENT_DEFAULTS).flatMap(Object.keys);
    expect(new Set(keys).size).toBe(keys.length);
    for (const preset of Object.values(DESIGN_PRESETS)) {
      const output = resolve(preset.id, preset.dimensions.material.id);
      expect(Object.keys(output.variables).sort()).toEqual(keys.sort());
    }
  });
  it('changes only layout when the user overrides density', () => {
    const standard = resolve(), compact = resolve('liquid-glass', 'glass', 'compact');
    for (const axis of ['style', 'typography', 'material', 'behavior'] as const) expect(compact.dimensions[axis]).toEqual(standard.dimensions[axis]);
    expect(compact.dimensions.layout).not.toEqual(standard.dimensions.layout);
  });
  it('replaces only material recipes when overriding the preset material', () => {
    const glass = resolve(), solid = resolve('liquid-glass', 'solid');
    expect(solid.material.id).toBe('solid');
    expect(solid.dimensions.style).toEqual(glass.dimensions.style);
    expect(solid.dimensions.behavior).toEqual(glass.dimensions.behavior);
    expect(solid.dimensions.material['--component-nav-state-shadow']).toBe('none');
  });
  it('falls back only the effects that need unavailable backdrop support', () => {
    const glass = resolveComponentDesign({ presetId: 'liquid-glass', material: 'glass', density: 'loose', effectsUsable: false });
    expect(glass.material.id).toBe('solid');
    expect(glass.dimensions.layout['--component-control-height']).toBe('40px');
    const paper = resolveComponentDesign({ presetId: 'paper', material: 'paper', density: 'standard', effectsUsable: false });
    expect(paper.material.id).toBe('paper');
    expect(paper.material.motion.spring).toBe('suppress');
  });
  it('accepts a new data-only preset without a new component branch', () => {
    const preset: DesignPreset = {
      ...DESIGN_PRESETS.paper, id: 'editorial', label: 'Editorial',
      dimensions: { ...DESIGN_PRESETS.paper.dimensions, typography: { '--component-title-font-size': '1.25rem' }, style: { ...DESIGN_PRESETS.paper.dimensions.style, tokens: { '--component-control-radius': '2px' } } },
    };
    const output = resolveComponentDesign({ presetId: preset.id, preset, material: 'paper', density: 'standard' });
    expect(output.variables['--component-title-font-size']).toBe('1.25rem');
    expect(output.variables['--component-control-radius']).toBe('2px');
    expect(output.material.id).toBe('paper');
    expect(resolve('classic', 'solid').variables['--component-control-radius']).toBe('var(--radius-md)');
  });
});
