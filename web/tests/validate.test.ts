import { describe, expect, it } from 'vitest';
import { BUILTIN_THEME_PACKS } from '@/theme/builtin';
import { validateThemeTokens, TOKEN_KEYS } from '@/theme/tokens';
import { parseThemePackJson, stripJsonComments, THEME_FILE_MAX } from '@/theme/validate';

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

describe('token 契约', () => {
  it('内置三套包 × 双模式全部通过白名单', () => {
    expect(TOKEN_KEYS.length).toBe(29);
    for (const pack of BUILTIN_THEME_PACKS) {
      expect(validateThemeTokens(pack.light, '浅色')).toBeNull();
      expect(validateThemeTokens(pack.dark, '深色')).toBeNull();
    }
  });
});
