// 成员身份色：以显示名为 key 生成稳定色相（成员名在群内唯一，见 role_names 约束）。
// 明度取中档，浅色/深色主题下均可读；头像配白色文字。
export function identityHue(key: string): number {
  let hash = 0;
  for (const character of key) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) | 0;
  }
  return Math.abs(hash) % 360;
}

export function identityColor(key: string): string {
  return `hsl(${identityHue(key)} 48% 46%)`;
}
