// 成员身份色：以显示名为 key 映射到 6 组 Quiet Instrument 等明度 Tinted Identity Badges
// （成员名在群内唯一，见 role_names 约束）。深浅主题由 light-dark() 自动切换，
// 替代高饱和霓虹彩虹球——数据级色板，与 shared/team-colors.ts 同性质，治理豁免。

interface IdentitySwatch {
  hue: number;
  lightFg: string;
  lightBg: string;
  darkFg: string;
  darkBg: string;
}

const IDENTITY_PALETTE: readonly IdentitySwatch[] = [
  { hue: 221, lightFg: '#1d4ed8', lightBg: '#e8f0fe', darkFg: '#60a5fa', darkBg: '#1b2942' }, // Slate Blue
  { hue: 173, lightFg: '#0f766e', lightBg: '#e6f7f5', darkFg: '#2dd4bf', darkBg: '#132e2c' }, // Teal
  { hue: 263, lightFg: '#6d28d9', lightBg: '#f1ebfe', darkFg: '#a78bfa', darkBg: '#251e3b' }, // Violet
  { hue: 38, lightFg: '#b45309', lightBg: '#fef3e2', darkFg: '#fbbf24', darkBg: '#312615' },  // Amber
  { hue: 152, lightFg: '#15803d', lightBg: '#e8f7ee', darkFg: '#34d399', darkBg: '#142e25' }, // Emerald
  { hue: 348, lightFg: '#be123c', lightBg: '#fdecef', darkFg: '#fb7185', darkBg: '#341b1e' }, // Rose
];

function identityIndex(key: string): number {
  let hash = 0;
  for (const character of key) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) | 0;
  }
  return Math.abs(hash) % IDENTITY_PALETTE.length;
}

function swatchFor(key: string): IdentitySwatch {
  return IDENTITY_PALETTE[identityIndex(key)]!;
}

export function identityHue(key: string): number {
  return swatchFor(key).hue;
}

/** 强调色（用于 2px 左侧角色标、连线、状态点与 Tinted 徽标前景字）。 */
export function identityColor(key: string): string {
  const swatch = swatchFor(key);
  return `light-dark(${swatch.lightFg}, ${swatch.darkFg})`;
}

/** Tinted 徽标柔底色（深浅自动适配，替代高饱和实心圆球）。 */
export function identityTintBg(key: string): string {
  const swatch = swatchFor(key);
  return `light-dark(${swatch.lightBg}, ${swatch.darkBg})`;
}

/** Tinted 徽标前景色（与 identityTintBg 配对保证 AA 对比度）。 */
export function identityTintFg(key: string): string {
  return identityColor(key);
}

/** 实底身份色上的前景（向后兼容调用方）。 */
export function identityForeground(): string {
  return 'white';
}
