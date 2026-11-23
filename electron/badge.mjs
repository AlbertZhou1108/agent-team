/**
 * 桌面任务栏/托盘徽标辅助（纯函数，无 Electron 依赖，便于单元测试）：
 * - badgeLabel: 超过 99 显示 99+；
 * - badgeOverlayPng: 为 Windows 任务栏 setOverlayIcon 生成 16×16 红底白字数字徽标 PNG。
 */
import { PNG } from 'pngjs';

export const BADGE_CAP = 99;

/** 3×5 像素点阵字形，供 16×16 覆盖图标绘制数字与 + 号。 */
const GLYPHS = {
  0: ['111', '101', '101', '101', '111'],
  1: ['010', '110', '010', '010', '111'],
  2: ['111', '001', '111', '100', '111'],
  3: ['111', '001', '111', '001', '111'],
  4: ['101', '101', '111', '001', '001'],
  5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'],
  7: ['111', '001', '001', '010', '010'],
  8: ['111', '101', '111', '101', '111'],
  9: ['111', '101', '111', '001', '111'],
  '+': ['000', '010', '111', '010', '000'],
};

export function badgeLabel(count) {
  if (!Number.isFinite(count) || count <= 0) return '';
  return count > BADGE_CAP ? `${BADGE_CAP}+` : String(Math.floor(count));
}

function setPixel(png, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const idx = (png.width * y + x) << 2;
  png.data[idx] = r;
  png.data[idx + 1] = g;
  png.data[idx + 2] = b;
  png.data[idx + 3] = a;
}

/** 生成 16×16 圆形红底白字 PNG Buffer；count <= 0 返回 null（清除任务栏角标）。 */
export function badgeOverlayPng(count) {
  const label = badgeLabel(count);
  if (!label) return null;
  const size = 16;
  const png = new PNG({ width: size, height: size });
  const center = 7.5;
  const radiusSq = 7.5 * 7.5;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - center;
      const dy = y - center;
      if (dx * dx + dy * dy <= radiusSq) {
        setPixel(png, x, y, 220, 38, 38, 255);
      }
    }
  }
  const chars = [...label];
  const gap = 1;
  const glyphWidth = 3;
  const totalWidth = chars.length * glyphWidth + Math.max(0, chars.length - 1) * gap;
  const startX = Math.floor((size - totalWidth) / 2);
  const startY = 5;
  chars.forEach((char, index) => {
    const glyph = GLYPHS[char];
    if (!glyph) return;
    const ox = startX + index * (glyphWidth + gap);
    for (let row = 0; row < glyph.length; row += 1) {
      for (let col = 0; col < glyph[row].length; col += 1) {
        if (glyph[row][col] === '1') setPixel(png, ox + col, startY + row, 255, 255, 255, 255);
      }
    }
  });
  return PNG.sync.write(png);
}
