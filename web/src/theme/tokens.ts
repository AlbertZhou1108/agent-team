/**
 * 主题 token 契约:全前端视觉变量的唯一清单。
 * 键名 = CSS 变量名去 `--` 前缀;主题包(内置或上传)按 mode 各提供一份完整取值,
 * 派生态(hover/tint/滚动条等)由 CSS 从基色自动派生,不进契约。
 */
export const TOKEN_KEYS = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'accent',
  'accent-foreground',
  'muted',
  'muted-foreground',
  'destructive',
  'destructive-foreground',
  'success',
  'success-foreground',
  'warning',
  'warning-foreground',
  'info',
  'info-foreground',
  'border',
  'input',
  'ring',
  'code',
  'code-foreground',
  'scrim',
  'radius',
] as const;

export type TokenKey = (typeof TOKEN_KEYS)[number];
export type ThemeTokens = Record<TokenKey, string>;

export interface ThemePack {
  id: string;
  name: string;
  light: ThemeTokens;
  dark: ThemeTokens;
}

/** 服务端存储的用户主题包(light/dark 已在前端 client 层解析为 token 表)。 */
export interface UserThemePack extends ThemePack {
  created: string;
  updated: string;
}

/** 上传文件解析出的待入库草稿:id 由服务端生成。 */
export interface ThemePackDraft {
  name: string;
  light: ThemeTokens;
  dark: ThemeTokens;
}

export const THEME_NAME_MAX = 60;
/** 单个 token 值长度上限(防超长注入)。 */
export const TOKEN_VALUE_MAX = 128;

// 颜色白名单:hex 或限定函数名的颜色函数。函数名整体锚定 + 参数字符集不含括号/分号,
// 因此 url()、var()、嵌套函数与一切 CSS 结构性注入都无法通过。
// 参数允许字母是为了 color(srgb …)、rgba() 等写法;函数名锚定已挡掉 url/var。
const COLOR_VALUE_RE =
  /^(#[0-9a-fA-F]{3,8}|(oklch|oklab|hsl|hwb|lab|lch|rgb|rgba|color)\([0-9a-zA-Z%.,\s/+-]*\))$/;
const RADIUS_VALUE_RE = /^\d*\.?\d+(px|rem|em|%)$/;

/** 校验一组 token 是否完整合法;返回首个错误的用户可读信息,通过返回 null。 */
export function validateThemeTokens(value: unknown, label: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return `${label}格式不正确,应为对象`;
  }
  const record = value as Record<string, unknown>;
  const missing = TOKEN_KEYS.filter((key) => !(key in record));
  if (missing.length) {
    return `${label}缺少变量:${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ' 等' : ''}`;
  }
  const unknown = Object.keys(record).filter(
    (key) => !(TOKEN_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length) {
    return `${label}包含未知变量:${unknown.slice(0, 4).join(', ')}${unknown.length > 4 ? ' 等' : ''}`;
  }
  for (const key of TOKEN_KEYS) {
    const token = record[key];
    if (typeof token !== 'string' || !token.trim()) {
      return `${label}的 ${key} 不是非空字符串`;
    }
    if (token.length > TOKEN_VALUE_MAX) {
      return `${label}的 ${key} 超过 ${TOKEN_VALUE_MAX} 字符`;
    }
    const matched = key === 'radius' ? RADIUS_VALUE_RE.test(token) : COLOR_VALUE_RE.test(token);
    if (!matched) {
      if (key === 'radius') {
        return `${label}的 radius 只支持 px/rem/em/% 单位的长度值`;
      }
      return `${label}的 ${key} 不是支持的颜色写法(#hex、oklch()、hsl()、rgb()、color() 等)`;
    }
  }
  return null;
}
