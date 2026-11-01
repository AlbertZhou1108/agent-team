/** 圆角矩形曲面法线图。R/G 编码横/纵采样偏移，中心保持中性灰。 */
export function createRefractionMap(width: number, height: number, radius: number, edge: number) {
  // 大面板限制纹理尺寸;法线仍按 CSS 像素计算,不改变曲面带的实际厚度。
  const mapWidth = Math.max(1, Math.min(1024, Math.round(width)));
  const mapHeight = Math.max(1, Math.min(1024, Math.round(height)));
  const data = new Uint8ClampedArray(mapWidth * mapHeight * 4);
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  const band = Math.max(1, Math.min(edge, width / 3, height / 3));
  for (let y = 0; y < mapHeight; y++) {
    for (let x = 0; x < mapWidth; x++) {
      const px = (x + 0.5) * width / mapWidth - width / 2;
      const py = (y + 0.5) * height / mapHeight - height / 2;
      const qx = Math.abs(px) - (width / 2 - r);
      const qy = Math.abs(py) - (height / 2 - r);
      const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
      const length = Math.hypot(ax, ay);
      const distance = length + Math.min(Math.max(qx, qy), 0) - r;
      const nx = (length ? ax / length : qx > qy ? 1 : 0) * Math.sign(px);
      const ny = (length ? ay / length : qy >= qx ? 1 : 0) * Math.sign(py);
      const depth = Math.max(0, -distance);
      const weight = distance <= 0 && depth < band ? Math.sin(Math.PI * depth / band) ** 1.2 : 0;
      const index = (y * mapWidth + x) * 4;
      data[index] = Math.round(127.5 + nx * weight * 127.5);
      data[index + 1] = Math.round(127.5 + ny * weight * 127.5);
      data[index + 2] = 128;
      data[index + 3] = 255;
    }
  }
  return { width: mapWidth, height: mapHeight, data };
}
