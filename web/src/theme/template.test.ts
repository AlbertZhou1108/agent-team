import { describe, expect, it } from 'vitest';
import { THEME_TEMPLATE_JSON } from './template';
import { parseThemePackJson } from './validate';

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
