import { describe, expect, it } from 'vitest';
import { createRefractionMap } from '@/theme/refraction-map';

function pixel(map: ReturnType<typeof createRefractionMap>, x: number, y: number) {
  return [...map.data.slice((y * map.width + x) * 4, (y * map.width + x) * 4 + 4)];
}

describe('rounded glass refraction map', () => {
  it('keeps the reading center neutral and bends opposing edges in opposing directions', () => {
    const map = createRefractionMap(200, 100, 16, 20);
    expect(pixel(map, 100, 50)).toEqual([128, 128, 128, 255]);
    expect(pixel(map, 10, 50)[0]).toBeLessThan(20);
    expect(pixel(map, 189, 50)[0]).toBeGreaterThan(235);
    expect(pixel(map, 100, 10)[1]).toBeLessThan(20);
    expect(pixel(map, 100, 89)[1]).toBeGreaterThan(235);
  });

  it('leaves the outside of rounded corners neutral and generates diagonal corner normals', () => {
    const map = createRefractionMap(200, 100, 24, 20);
    expect(pixel(map, 0, 0)).toEqual([128, 128, 128, 255]);
    const corner = pixel(map, 12, 12);
    expect(corner[0]).toBeLessThan(100);
    expect(corner[1]).toBeLessThan(100);
    expect(corner[0]).toBe(corner[1]);
  });

  it('caps large panel textures and accommodates narrow controls without invalid pixels', () => {
    const large = createRefractionMap(1800, 1200, 8, 24);
    expect([large.width, large.height, large.data.length]).toEqual([1024, 1024, 1024 * 1024 * 4]);
    const narrow = createRefractionMap(1, 1, 26, 26);
    expect(pixel(narrow, 0, 0)).toEqual([128, 128, 128, 255]);
  });
});
