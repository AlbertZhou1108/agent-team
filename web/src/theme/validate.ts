import {
  THEME_NAME_MAX,
  validateThemeTokens,
  type ThemePackDraft,
} from './tokens';

/** 上传文件的大小上限(含注释)。 */
export const THEME_FILE_MAX = 64_000;

/**
 * 剥离 JSON 文本中的 `//` 行注释与 `/* 块注释 *​/`。字符串感知:
 * 引号内的注释记号原样保留;块注释保留换行,便于出错时对照行号。
 */
export function stripJsonComments(text: string): string {
  let result = '';
  let index = 0;
  const length = text.length;
  while (index < length) {
    const char = text[index];
    if (char === '"') {
      result += char;
      index += 1;
      while (index < length) {
        const inner = text[index];
        result += inner;
        index += 1;
        if (inner === '\\') {
          if (index < length) {
            result += text[index];
            index += 1;
          }
          continue;
        }
        if (inner === '"') break;
      }
      continue;
    }
    if (char === '/' && text[index + 1] === '/') {
      while (index < length && text[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && text[index + 1] === '*') {
      index += 2;
      while (index < length && !(text[index] === '*' && text[index + 1] === '/')) {
        if (text[index] === '\n') result += '\n';
        index += 1;
      }
      index += 2;
      continue;
    }
    result += char;
    index += 1;
  }
  return result;
}

export type ThemePackParseResult =
  | { ok: true; pack: ThemePackDraft }
  | { ok: false; error: string };

/**
 * 解析上传的主题文件(允许注释,即 JSONC):结构 → 名称 → light/dark 全量校验。
 * 校验在前端完成,颜色语义不出浏览器;服务端只做结构级兜底。
 */
export function parseThemePackJson(text: string): ThemePackParseResult {
  if (text.length > THEME_FILE_MAX) {
    return { ok: false, error: `文件过大,上限 ${Math.floor(THEME_FILE_MAX / 1000)}KB` };
  }
  let data: unknown;
  try {
    data = JSON.parse(stripJsonComments(text));
  } catch (cause) {
    return {
      ok: false,
      error: `JSON 解析失败:${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: '主题文件顶层应为对象' };
  }
  const source = data as Record<string, unknown>;
  if (source.format !== 'agent-team-theme' || source.version !== 1) {
    return { ok: false, error: '不是 agent-team 主题文件(format/version 不符)' };
  }
  const name = typeof source.name === 'string' ? source.name.trim() : '';
  if (!name || name.length > THEME_NAME_MAX) {
    return { ok: false, error: `主题名称需要 1-${THEME_NAME_MAX} 字符` };
  }
  const lightError = validateThemeTokens(source.light, '浅色(light)');
  if (lightError) return { ok: false, error: lightError };
  const darkError = validateThemeTokens(source.dark, '深色(dark)');
  if (darkError) return { ok: false, error: darkError };
  return {
    ok: true,
    pack: {
      name,
      light: source.light as ThemePackDraft['light'],
      dark: source.dark as ThemePackDraft['dark'],
    },
  };
}
