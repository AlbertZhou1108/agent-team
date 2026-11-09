import { describe, expect, it } from 'vitest';
import { BUILTIN_THEME_PACKS } from '@/theme/builtin';
import { resolveThemePack, resolveTokens } from '@/theme/resolve';
import type { UserThemePack } from '@/theme/tokens';

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
