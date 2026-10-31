import { BUILTIN_THEME_PACKS, CLASSIC_THEME_ID } from './builtin';
import type { ThemePack, ThemeTokens } from './tokens';

/** 选中 id 对应的主题包:内置优先,其次用户包;找不到(已删除/未知 id)回落 classic。 */
export function resolveThemePack(id: string, userPacks: readonly ThemePack[]): ThemePack {
  const builtin = BUILTIN_THEME_PACKS.find((pack) => pack.id === id);
  if (builtin) return builtin;
  const user = userPacks.find((pack) => pack.id === id);
  if (user) return user;
  return BUILTIN_THEME_PACKS.find((pack) => pack.id === CLASSIC_THEME_ID)!;
}

/**
 * 解析出最终生效的 token 表:以 classic 同模式值为底,选中包覆盖。
 * 主题包缺键(如旧版本包遇上新增变量)时自动回落,保证渲染永不破。
 */
export function resolveTokens(pack: ThemePack, isDark: boolean): ThemeTokens {
  const classic = BUILTIN_THEME_PACKS.find((entry) => entry.id === CLASSIC_THEME_ID)!;
  const base = isDark ? classic.dark : classic.light;
  const over = isDark ? pack.dark : pack.light;
  return { ...base, ...over };
}
