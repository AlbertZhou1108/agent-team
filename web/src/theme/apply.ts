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
