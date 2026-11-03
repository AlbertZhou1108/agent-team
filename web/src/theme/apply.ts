import { resolveMotionStyle, systemReducedMotion, type MotionStyle } from '@/shared/motion';
import { resolveComponentDesign } from './design-presets';
import { MATERIAL_CATEGORIES, PAPER_TEXTURES, getMaterialCategory, SURFACE_ROLES, type MaterialId, type MaterialCategory } from './materials';
import { TOKEN_KEYS, type ThemeTokens } from './tokens';

/**
 * 把解析后的 token 全量写到 <html> 上,并同步深色 class。
 * 明暗与色相都在这里收口:偏好变更、主题切换、系统明暗变化都最终走本函数。
 * 全量覆写 29 项,不留上一个主题的残留值。
 */
export function applyTheme(tokens: ThemeTokens, isDark: boolean): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.toggle('dark', isDark);
  for (const key of TOKEN_KEYS) {
    root.style.setProperty(`--${key}`, tokens[key]);
  }
}

/**
 * 把解析后的动效风格写到 <html data-motion>。
 * 全局 CSS 与 JS 侧动效决策都以这个属性为唯一依据。
 */
export function applyMotion(style: MotionStyle): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.motion = style;
}

/** 材质选项:默认实色,或一种从当前配色派生的玻璃。 */
export type MaterialPreference = MaterialId;

export function isMaterialPreference(value: unknown): value is MaterialPreference {
  return typeof value === 'string' && Object.hasOwn(MATERIAL_CATEGORIES, value);
}

/** 设备能否呈现表面效果(模糊);不能或用户要求降低透明度时回落实色。 */
function surfaceEffectsUsable(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  const supportsBlur =
    typeof CSS !== 'undefined' &&
    (CSS.supports?.('backdrop-filter', 'blur(1px)') ||
      CSS.supports?.('-webkit-backdrop-filter', 'blur(1px)') ||
      false);
  const reduceTransparency =
    window.matchMedia?.('(prefers-reduced-transparency: reduce)').matches ?? false;
  return supportsBlur && !reduceTransparency;
}

/**
 * 把材质大类落到 <html>:data-material 记录"实际生效"的大类,
 * 并按规格表(theme/materials.ts)把每个角色的表面参数写成
 * --surface-{role}-* CSS 变量供表面消费。设备不支持或要求降低透明度时,
 * 回落为默认实色(变量不写,表面走主题基线)。
 */
let appliedMaterial = getMaterialCategory('solid');
export function getAppliedMaterial(): MaterialCategory { return appliedMaterial; }

export function applyMaterial(preference: MaterialPreference): void {
  const category = getMaterialCategory(preference);
  writeMaterial(category.effect === 'glass' && !surfaceEffectsUsable() ? getMaterialCategory('solid') : category);
}
function writeMaterial(effective: MaterialCategory): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  appliedMaterial = effective;
  root.dataset.materialEffect = effective.effect ?? 'opaque';
  // 先清空上一大类的表面变量再写入,切换无残留。
  for (const role of SURFACE_ROLES) {
    root.style.removeProperty(`--surface-${role}-bg`);
    root.style.removeProperty(`--surface-${role}-image`);
    root.style.removeProperty(`--surface-${role}-blur`);
    root.style.removeProperty(`--surface-${role}-shadow`);
  }
  root.dataset.material = effective.id;
  // 材质运动签名:写为属性供动效契约的材质级重映射消费
  // (如禁止弹性的材质把 --motion-ease-spring 压回标准曲线,见 globals.css)。
  root.dataset.materialSpring = effective.motion.spring;
  root.dataset.materialSignature = effective.motion.signature;
  for (const [role, finish] of Object.entries(effective.roles)) {
    if (finish.bg) root.style.setProperty(`--surface-${role}-bg`, finish.bg);
    if (finish.image) root.style.setProperty(`--surface-${role}-image`, finish.image);
    if (finish.blur) root.style.setProperty(`--surface-${role}-blur`, finish.blur);
    if (finish.shadow) root.style.setProperty(`--surface-${role}-shadow`, finish.shadow);
  }
}

/** 界面密度:只调节共享间距与容器留白,不改正文大小与业务信息。 */
export type Density = 'compact' | 'standard' | 'loose';

export function isDensity(value: unknown): value is Density {
  return value === 'compact' || value === 'standard' || value === 'loose';
}

export function applyDensity(density: Density): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.density = density;
}

/** 阅读设置四参数(与明暗/主题/材质正交,不随外观切换重置)。 */
export type ReadingSize = 'standard' | 'large' | 'xlarge';
export type ReadingLeading = 'standard' | 'relaxed';
export type ReadingWidth = 'standard' | 'wide' | 'full';
export type CodeSize = 'standard' | 'large';

export function isReadingSize(value: unknown): value is ReadingSize {
  return value === 'standard' || value === 'large' || value === 'xlarge';
}
export function isReadingLeading(value: unknown): value is ReadingLeading {
  return value === 'standard' || value === 'relaxed';
}
export function isReadingWidth(value: unknown): value is ReadingWidth {
  return value === 'standard' || value === 'wide' || value === 'full';
}
export function isCodeSize(value: unknown): value is CodeSize {
  return value === 'standard' || value === 'large';
}

export interface ReadingPreference {
  readingSize: ReadingSize;
  readingLeading: ReadingLeading;
  readingWidth: ReadingWidth;
  codeSize: CodeSize;
}

const READING_SIZE_VAR: Record<ReadingSize, string> = {
  standard: '1rem',
  large: '1.09375rem',
  xlarge: '1.1875rem',
};
const READING_LEADING_VAR: Record<ReadingLeading, string> = {
  standard: '1.75',
  relaxed: '1.9',
};
const READING_WIDTH_VAR: Record<ReadingWidth, string> = {
  standard: '820px',
  wide: '960px',
  full: '100%',
};
const CODE_SIZE_VAR: Record<CodeSize, string> = {
  standard: '0.875rem',
  large: '1rem',
};

/** 把阅读设置写成 <html> 上的 CSS 变量,由 .markdown-content 与正文宽度消费。 */
export function applyReading(preference: ReadingPreference): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.style.setProperty('--reading-size', READING_SIZE_VAR[preference.readingSize]);
  root.style.setProperty('--reading-leading', READING_LEADING_VAR[preference.readingLeading]);
  root.style.setProperty('--reading-width', READING_WIDTH_VAR[preference.readingWidth]);
  root.style.setProperty('--code-size', CODE_SIZE_VAR[preference.codeSize]);
}

/** 首帧和后续偏好更新共用同一完整输出,不在组件内判别预设。 */
export function applyComponentDesign(preferences: { designPreset?: unknown; materialPreference: string; density: Density }, output?: ReturnType<typeof resolveComponentDesign>): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const resolved = output ?? resolveComponentDesign({ presetId: preferences.designPreset, material: root.dataset.material ?? preferences.materialPreference, density: preferences.density });
  root.dataset.designPreset = resolved.presetId;
  for (const [key, value] of Object.entries(resolved.variables)) root.style.setProperty(key, value);
}

/** 唯一外观应用链:首帧和 watcher 使用同一个解析/输出过程。 */
export function applyAppearance(preferences: ReadingPreference & {
  designPreset: unknown; materialPreference: MaterialPreference; density: Density;
  motionPreference: import('@/shared/motion').MotionPreference;
}, tokens: ThemeTokens, isDark: boolean): void {
  const resolved = resolveComponentDesign({ presetId: preferences.designPreset, material: preferences.materialPreference, density: preferences.density, effectsUsable: surfaceEffectsUsable() });
  applyTheme(tokens, isDark);
  applyDensity(preferences.density);
  applyReading(preferences);
  writeMaterial(resolved.material);
  applyComponentDesign(preferences, resolved);
  applyPaperTexture(isDark);
  applyMotion(resolveMotionStyle(preferences.motionPreference, systemReducedMotion()));
}

/**
 * 纸质的深色纹理不能沿用浅色那套叠加层:深底会把高频噪点放大成沙点。
 * 在组件变量写完之后按明暗替换纹理变量;其他材质不参与。
 */
export function applyPaperTexture(isDark: boolean): void {
  if (typeof document === 'undefined' || getAppliedMaterial().id !== 'paper') return;
  const texture = isDark ? PAPER_TEXTURES.dark : PAPER_TEXTURES.light;
  const root = document.documentElement;
  root.style.setProperty('--component-content-image', texture.content);
  root.style.setProperty('--component-surface-texture', texture.surface);
}
