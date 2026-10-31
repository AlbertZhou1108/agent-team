import type { MotionStyle } from '@/shared/motion';
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
export type MaterialPreference = 'solid' | 'glass';

export function isMaterialPreference(value: unknown): value is MaterialPreference {
  return value === 'solid' || value === 'glass';
}

/**
 * 把材质选项写到 <html data-material>;具体表面映射由共享 CSS 完成。
 * 效果不可用(不支持 backdrop-filter 或用户要求降低透明度)时由 CSS 回落实色。
 */
export function applyMaterial(preference: MaterialPreference): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.material = preference;
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
