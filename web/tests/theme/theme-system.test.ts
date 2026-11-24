import { describe, expect, it, vi } from 'vitest';
import { applyComponentDesign, applyMaterial } from '@/theme/apply';
import type { MaterialId } from '@/theme/materials';
import { COMPONENT_DEFAULTS } from '@/theme/component-contract';
import { DESIGN_PRESETS, isPresetModified, resolveComponentDesign } from '@/theme/design-presets';
import type { DesignPreset } from '@/theme/design-presets';
import { BUILTIN_THEME_PACKS } from '@/theme/builtin';
import { resolveThemePack, resolveTokens } from '@/theme/resolve';
import { validateThemeTokens, TOKEN_KEYS } from '@/theme/tokens';
import type { UserThemePack } from '@/theme/tokens';
import { parseThemePackJson, stripJsonComments, THEME_FILE_MAX } from '@/theme/validate';
import { THEME_TEMPLATE_JSON } from '@/theme/template';

describe('design-presets', () => {
  const resolve = (presetId = 'frosted-glass', material = 'frosted', density: 'standard' | 'compact' | 'loose' = 'standard') => resolveComponentDesign({ presetId, material, density });

  describe('five-dimension component configuration', () => {
    it('replaces the complete applied output across repeated preset switches', () => {
      const values = new Map<string, string>();
      const root = { dataset: {} as Record<string, string>, style: { setProperty: (key: string, value: string) => values.set(key, value) } };
      vi.stubGlobal('document', { documentElement: root });
      try {
        for (const id of ['frosted-glass', 'paper', 'vivid', 'classic', 'vivid', 'paper', 'frosted-glass'] as const) {
          const material = DESIGN_PRESETS[id].dimensions.material.id;
          const output = resolve(id, material);
          applyComponentDesign({ designPreset: id, materialPreference: material, density: 'standard' }, output);
          expect(root.dataset.designPreset).toBe(id);
          expect(Object.fromEntries(values)).toEqual(output.variables);
        }
      } finally { vi.unstubAllGlobals(); }
    });
    it('matches a fresh application after every ordered preset switch, including material cleanup', () => {
      const makeRoot = () => {
        const values = new Map<string, string>();
        return {
          dataset: {} as Record<string, string>,
          style: {
            setProperty: (key: string, value: string) => values.set(key, value),
            removeProperty: (key: string) => values.delete(key),
          },
          snapshot: () => ({ dataset: { ...root.dataset }, variables: Object.fromEntries(values) }),
        };
      };
      let root = makeRoot();
      vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
      vi.stubGlobal('CSS', { supports: () => true });
      const apply = (preset: DesignPreset) => {
        applyMaterial(preset.dimensions.material.id as MaterialId);
        applyComponentDesign({ designPreset: preset.id, materialPreference: preset.dimensions.material.id, density: 'standard' });
      };
      try {
        for (const target of Object.values(DESIGN_PRESETS)) {
          root = makeRoot();
          vi.stubGlobal('document', { documentElement: root });
          apply(target);
          const fresh = root.snapshot();
          for (const source of Object.values(DESIGN_PRESETS)) {
            root = makeRoot();
            vi.stubGlobal('document', { documentElement: root });
            apply(source);
            // Keep the same DOM and inline styles across the switch.
            apply(target);
            expect(root.snapshot(), `${source.id} → ${target.id}`).toEqual(fresh);
          }
        }
      } finally { vi.unstubAllGlobals(); }
    });
    it('uses one shared paper grain for content and panel surfaces', () => {
      const { material } = resolve('paper', 'paper');
      expect(material.components?.['--component-content-image']).toContain('paper-grain');
      expect(material.components?.['--component-surface-texture']).toBe(material.components?.['--component-content-image']);
    });
    it('keeps the paper sheet edge on the theme border token', () => {
      const { variables } = resolve('paper', 'paper');
      // 卡片与页面表面同为 --card 色:边线必须消费主题边框色,混进纸面就看不见了;
      // 曾以 45% 混色弱化,卡片只剩上缘/下缘两条内侧假边线。
      expect(variables['--component-surface-border']).toBe(COMPONENT_DEFAULTS.material['--component-surface-border']);
      expect(variables['--component-surface-border']).toBe('var(--border)');
      // 可见边线只由 border 承担:内容面与面板都不叠加上缘内侧高光线,内缘只留下缘截面。
      for (const key of ['--component-content-shadow', '--component-panel-shadow']) {
        expect(variables[key]).not.toContain('inset 0 1px 0');
        expect(variables[key]).toContain('inset 0 -1px 0');
      }
    });
    it('clears role depth when switching from paper back to solid', () => {
      const values = new Map<string, string>();
      vi.stubGlobal('document', { documentElement: {
        dataset: {}, style: {
          setProperty: (key: string, value: string) => values.set(key, value),
          removeProperty: (key: string) => values.delete(key),
        },
      } });
      try {
        applyMaterial('paper');
        expect(values.has('--surface-nav-panel-shadow')).toBe(true);
        expect(values.has('--surface-input-shadow')).toBe(true);
        expect(values.has('--surface-overlay-shadow')).toBe(true);
        applyMaterial('solid');
        // paper 的层级阴影必须清干净;solid 只写自己的明度阶梯(bg),不残留 shadow。
        expect([...values.keys()].filter(key => key.startsWith('--surface-') && key.endsWith('-shadow'))).toEqual([]);
        expect(values.get('--surface-nav-panel-bg')).toBe('var(--background)');
      } finally { vi.unstubAllGlobals(); }
    });
    it('isolates nested role recipes and every axis between resolutions', () => {
      const baseline = resolve();
      const changed = resolve();
      changed.material.roles['nav-panel']!.bg = 'rgb(999 0 0)';
      changed.material.motion.signature = 'none';
      changed.dimensions.material['--component-control-radius'] = '99px';
      changed.variables['--component-content-bg'] = 'red';
      expect(resolve()).toEqual(baseline);
      expect(resolve('paper', 'paper')).not.toEqual(changed);
    });
    it('keeps editing a glass preset local to that preset across all five axes', () => {
      const paper = resolve('paper', 'paper');
      const classic = resolve('classic', 'solid');
      const custom: DesignPreset = structuredClone(DESIGN_PRESETS['frosted-glass']);
      custom.dimensions.style.tokens = { '--component-nav-marker-width': '4px' };
      custom.dimensions.typography['--component-title-font-size'] = '1.5rem';
      custom.dimensions.material.roles['nav-panel']!.bg = 'transparent';
      custom.dimensions.material.components!['--component-control-radius'] = '19px';
      custom.dimensions.behavior.tokens = { '--component-feedback-duration': '0.5s' };
      custom.dimensions.layout.tokens = { '--component-panel-gap': '22px' };
      const output = resolveComponentDesign({ presetId: custom.id, preset: custom, material: 'frosted', density: 'standard' });
      expect(output.variables['--component-nav-marker-width']).toBe('4px');
      expect(output.variables['--component-title-font-size']).toBe('1.5rem');
      expect(output.variables['--component-panel-gap']).toBe('22px');
      expect(output.variables['--component-control-radius']).toBe('19px');
      expect(output.variables['--component-feedback-duration']).toBe('0.5s');
      expect(output.material.roles['nav-panel']!.bg).toBe('transparent');
      expect(resolve('paper', 'paper')).toEqual(paper);
      expect(resolve('classic', 'solid')).toEqual(classic);
    });
    it('protects shared defaults and built-in recipes from accidental mutation', () => {
      expect(Object.isFrozen(COMPONENT_DEFAULTS.style)).toBe(true);
      expect(Object.isFrozen(COMPONENT_DEFAULTS.material)).toBe(true);
      expect(Object.isFrozen(DESIGN_PRESETS.paper.dimensions)).toBe(true);
      expect(Object.isFrozen(DESIGN_PRESETS['frosted-glass'].dimensions.material.roles['nav-panel']!)).toBe(true);
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
      const standard = resolve(), compact = resolve('frosted-glass', 'frosted', 'compact');
      for (const axis of ['style', 'typography', 'material', 'behavior'] as const) expect(compact.dimensions[axis]).toEqual(standard.dimensions[axis]);
      expect(compact.dimensions.layout).not.toEqual(standard.dimensions.layout);
      expect(standard.variables['--component-control-xs-height']).toBe('24px');
      expect(standard.variables['--component-control-sm-height']).toContain('--component-control-height');
      expect(standard.variables['--component-control-lg-height']).toContain('--component-control-height');
      expect(standard.variables['--component-card-md-padding']).toBe('16px');
      expect(standard.variables['--component-section-md-padding']).toBe('14px');
    });
    it('replaces only material recipes when overriding the preset material', () => {
      const glass = resolve(), solid = resolve('frosted-glass', 'solid');
      expect(solid.material.id).toBe('solid');
      expect(solid.dimensions.style).toEqual(glass.dimensions.style);
      expect(solid.dimensions.behavior).toEqual(glass.dimensions.behavior);
      expect(solid.dimensions.material['--component-nav-state-shadow']).toBe('none');
      // 物性随材质:手选实色后 radius/press 回实色基线,不再停留在玻璃值。
      expect(solid.variables['--component-control-radius']).toBe('var(--radius-md)');
      expect(solid.variables['--component-button-press-scale']).toBe('0.98');
    });
    it('carries material physics (radius, press) with the material, not the preset', () => {
      const glassOnPaperPreset = resolve('paper', 'frosted');
      expect(glassOnPaperPreset.variables['--component-control-radius']).toBe('var(--radius-lg)');
      expect(glassOnPaperPreset.variables['--component-button-press-scale']).toBe('0.97');
      const paperOnGlassPreset = resolve('frosted-glass', 'paper');
      expect(paperOnGlassPreset.variables['--component-control-radius']).toBe('4px');
      expect(paperOnGlassPreset.variables['--component-panel-radius']).toBe('6px');
    });
    it('uses Gaussian blur with vibrancy and no refraction optics', () => {
      const frosted = resolve('frosted-glass', 'frosted');
      expect(frosted.material.id).toBe('frosted');
      expect(frosted.material.effect).toBe('glass');
      for (const role of ['nav-panel', 'context-panel', 'action', 'overlay'] as const) {
        const finish = frosted.material.roles[role]!;
        expect(finish.blur).toContain('blur(');
        expect(finish.blur).toContain('saturate(');
        expect(finish).not.toHaveProperty('refraction');
      }
      // 输入面接近实色,不把父层操作区的模糊透上来。
      expect(frosted.material.roles.input!.bg).toContain('96%');
      expect(frosted.variables['--component-light-image']).toBeUndefined();
    });
    it('falls back only the effects that need unavailable backdrop support', () => {
      const glass = resolveComponentDesign({ presetId: 'frosted-glass', material: 'frosted', density: 'loose', effectsUsable: false });
      expect(glass.material.id).toBe('solid');
      expect(glass.dimensions.layout['--component-control-height']).toBe('40px');
      const paper = resolveComponentDesign({ presetId: 'paper', material: 'paper', density: 'standard', effectsUsable: false });
      expect(paper.material.id).toBe('paper');
      expect(paper.material.motion.spring).toBe('suppress');
    });
    it('accepts a new data-only preset without a new component branch', () => {
      const preset: DesignPreset = {
        ...DESIGN_PRESETS.paper, id: 'editorial', label: 'Editorial',
        dimensions: { ...DESIGN_PRESETS.paper.dimensions, typography: { '--component-title-font-size': '1.25rem' } },
      };
      const output = resolveComponentDesign({ presetId: preset.id, preset, material: 'paper', density: 'standard' });
      expect(output.variables['--component-title-font-size']).toBe('1.25rem');
      // 物性不随预设携带:radius/press 来自 paper 材质注册表,而非预设差量。
      expect(output.variables['--component-control-radius']).toBe('4px');
      expect(output.variables['--component-button-press-scale']).toBe('1');
      expect(output.material.id).toBe('paper');
      expect(resolve('classic', 'solid').variables['--component-control-radius']).toBe('var(--radius-md)');
    });
    it('keeps the component contract free of per-preset button decoration keys', () => {
      // 用户决策(2026-11-04):重点按钮不加渐变边框,主操作用纯色;
      // 契约不保留任何 accent/decoration 入口,避免为候选风格预建配置。
      expect(Object.keys(COMPONENT_DEFAULTS.style).filter(key => key.includes('accent'))).toEqual([]);
    });
    it('ships the vivid preset with its own material, theme and physics', () => {
      const { presetId, material, variables } = resolve('vivid', 'vivid');
      expect(presetId).toBe('vivid');
      expect(material.id).toBe('vivid');
      expect(material.motion.spring).toBe('allow');
      // 活力物性:大圆角、扁平(普通卡片无阴影),浮层保留极轻分离。
      expect(variables['--component-control-radius']).toBe('14px');
      expect(variables['--component-panel-radius']).toBe('22px');
      expect(variables['--component-content-shadow']).toBe('none');
      expect(variables['--component-panel-shadow']).toBe('none');
      // 主操作是纯色 default variant,不携带任何按钮装饰配方。
      expect(variables['--component-accent-button-image']).toBeUndefined();
    });
    it('keeps vivid surface recipes isolated from the solid material', () => {
      const fallback = resolve('vivid', 'solid');
      expect(fallback.material.id).toBe('solid');
      // 手选默认实色后,圆角/阴影回实色基线,活力表面配方不再生效。
      expect(fallback.variables['--component-control-radius']).toBe('var(--radius-md)');
      expect(fallback.variables['--component-content-shadow']).toBe(COMPONENT_DEFAULTS.material['--component-content-shadow']);
    });
    it('gives default solid segmented choices and active tabs dark-mode separation', () => {
      const classic = resolve('classic', 'solid');
      expect(classic.variables['--component-choice-selected-bg']).toContain('light-dark(');
      expect(classic.variables['--component-choice-selected-border']).toContain('light-dark(');
      expect(classic.variables['--component-tab-active-bg']).toContain('light-dark(');
    });
  });

  describe('isPresetModified', () => {
    const axes = (overrides: Partial<Parameters<typeof isPresetModified>[1]> = {}) => ({
      colorMode: 'system',
      themePack: 'classic',
      materialPreference: 'solid',
      motionPreference: 'system',
      density: 'standard',
      ...overrides,
    });
    it('reports no deviation while every user axis matches the selected preset', () => {
      expect(isPresetModified('classic', axes())).toBe(false);
      expect(isPresetModified('paper', { colorMode: 'system', themePack: 'ivory', materialPreference: 'paper', motionPreference: 'simple', density: 'standard' })).toBe(false);
      expect(isPresetModified('frosted-glass', { colorMode: 'system', themePack: 'classic', materialPreference: 'frosted', motionPreference: 'soft', density: 'standard' })).toBe(false);
    });
    it('reports deviation as soon as any user axis leaves the preset recipe', () => {
      expect(isPresetModified('classic', axes({ colorMode: 'dark' }))).toBe(true);
      expect(isPresetModified('classic', axes({ materialPreference: 'frosted' }))).toBe(true);
      expect(isPresetModified('classic', axes({ themePack: 'forest' }))).toBe(true);
      expect(isPresetModified('frosted-glass', axes({ motionPreference: 'lively' }))).toBe(true);
      expect(isPresetModified('paper', axes({ density: 'compact' }))).toBe(true);
    });
    it('compares against classic when the stored preset id is unknown', () => {
      expect(isPresetModified('不存在的历史预设', axes())).toBe(false);
      expect(isPresetModified('不存在的历史预设', axes({ materialPreference: 'paper' }))).toBe(true);
    });
  });
});

describe('resolve', () => {
  const classic = BUILTIN_THEME_PACKS.find((pack) => pack.id === 'classic')!;
  const ocean = BUILTIN_THEME_PACKS.find((pack) => pack.id === 'ocean')!;
  const userPack: UserThemePack = {
    id: 'u1',
    name: '用户包',
    light: { ...classic.light, primary: '#123456' },
    dark: { ...classic.dark, primary: '#654321' },
    created: '',
    updated: '',
  };

  describe('resolveThemePack', () => {
    it('命中内置包', () => {
      expect(resolveThemePack('ocean', [userPack])).toBe(ocean);
    });
    it('命中用户包', () => {
      expect(resolveThemePack('u1', [userPack])).toBe(userPack);
    });
    it('缺 id(已删除/未知)回落 classic', () => {
      expect(resolveThemePack('gone', [userPack])).toBe(classic);
    });
  });

  describe('resolveTokens', () => {
    it('以 classic 为底、选中包覆盖', () => {
      const tokens = resolveTokens(userPack, false);
      expect(tokens.primary).toBe('#123456');
      expect(tokens.foreground).toBe(classic.light.foreground);
    });
    it('dark/light 分支正确', () => {
      expect(resolveTokens(userPack, true).primary).toBe('#654321');
      expect(resolveTokens(ocean, true).background).toBe(ocean.dark.background);
    });
    it('选中包缺键时回落 classic(向前兼容)', () => {
      const partial = {
        ...userPack,
        light: { primary: '#123456' } as UserThemePack['light'],
      };
      const tokens = resolveTokens(partial, false);
      expect(tokens.primary).toBe('#123456');
      expect(tokens.background).toBe(classic.light.background);
    });
  });
});

describe('validate', () => {
  const base = BUILTIN_THEME_PACKS[0]!.light;

  function themeFile(overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
      format: 'agent-team-theme',
      version: 1,
      name: '测试主题',
      light: { ...base },
      dark: { ...base },
      ...overrides,
    });
  }

  describe('stripJsonComments', () => {
    it('保留字符串内的注释记号', () => {
      const source = '{"a":"http://x // not-a-comment"}';
      expect(stripJsonComments(source)).toBe(source);
    });
    it('剥离行注释与块注释', () => {
      const stripped = stripJsonComments('{ // 行注释\n  "a": 1 /* 块\n注释 */ }');
      expect(JSON.parse(stripped)).toEqual({ a: 1 });
    });
    it('处理字符串内的转义引号', () => {
      const stripped = stripJsonComments('{"a":"说 \\"// 这个\\" 的话"}');
      expect(JSON.parse(stripped)).toEqual({ a: '说 "// 这个" 的话' });
    });
  });

  describe('parseThemePackJson', () => {
    it('解析合法文件', () => {
      const result = parseThemePackJson(themeFile());
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.pack.name).toBe('测试主题');
    });
    it('format/version 不符被拒绝', () => {
      expect(parseThemePackJson(themeFile({ format: 'other' })).ok).toBe(false);
      expect(parseThemePackJson(themeFile({ version: 2 })).ok).toBe(false);
    });
    it('名称必须为 1-60 字', () => {
      expect(parseThemePackJson(themeFile({ name: '  ' })).ok).toBe(false);
      expect(parseThemePackJson(themeFile({ name: 'x'.repeat(61) })).ok).toBe(false);
    });
    it('缺键被拒绝', () => {
      const light: Record<string, string> = { ...base };
      delete light.primary;
      const result = parseThemePackJson(themeFile({ light }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('缺少变量');
    });
    it('未知键被拒绝', () => {
      const light = { ...base, extra: 'oklch(0.5 0 0)' };
      const result = parseThemePackJson(themeFile({ light }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('未知变量');
    });
    it('拒绝 url()/var()/嵌套函数等注入', () => {
      for (const value of [
        'url(https://evil.example/pixel)',
        'var(--background)',
        'oklch(var(--primary))',
        'rgb(0 0 0) ; } * { background: red }',
      ]) {
        const result = parseThemePackJson(themeFile({ light: { ...base, primary: value } }));
        expect(result.ok).toBe(false);
      }
    });
    it('radius 只接受长度值', () => {
      expect(parseThemePackJson(themeFile({ light: { ...base, radius: 'oklch(0.5 0 0)' } })).ok).toBe(false);
      expect(parseThemePackJson(themeFile({ light: { ...base, radius: '0.75rem' } })).ok).toBe(true);
    });
    it('超大小文件被拒绝', () => {
      expect(parseThemePackJson('x'.repeat(THEME_FILE_MAX + 1)).ok).toBe(false);
    });
  });

  describe('THEME_TEMPLATE_JSON', () => {
    it('样板经注释剥离后必须能完整通过解析(防样板漂移)', () => {
      const result = parseThemePackJson(THEME_TEMPLATE_JSON);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.pack.name).toBe('我的主题');
        expect(Object.keys(result.pack.light).length).toBe(29);
        expect(Object.keys(result.pack.dark).length).toBe(29);
      }
    });
  });

  describe('token 契约', () => {
    it('内置三套包 × 双模式全部通过白名单', () => {
      expect(TOKEN_KEYS.length).toBe(29);
      for (const pack of BUILTIN_THEME_PACKS) {
        expect(validateThemeTokens(pack.light, '浅色')).toBeNull();
        expect(validateThemeTokens(pack.dark, '深色')).toBeNull();
      }
    });
  });
});
