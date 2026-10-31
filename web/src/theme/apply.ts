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
