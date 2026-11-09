import { describe, expect, it } from 'vitest';
import { dropSide } from '@/shared/drag-order';

const rect = { left: 100, top: 200, width: 200, height: 80 };

describe('dropSide', () => {
  it('splits a vertical target at its middle for before/after', () => {
    expect(dropSide({ clientX: 0, clientY: 200 }, rect, 'y')).toBe('before');
    expect(dropSide({ clientX: 0, clientY: 239 }, rect, 'y')).toBe('before');
    expect(dropSide({ clientX: 0, clientY: 281 }, rect, 'y')).toBe('after');
    expect(dropSide({ clientX: 0, clientY: 300 }, rect, 'y')).toBe('after');
  });

  it('splits a horizontal target at its middle for before/after', () => {
    expect(dropSide({ clientX: 100, clientY: 0 }, rect, 'x')).toBe('before');
    expect(dropSide({ clientX: 199, clientY: 0 }, rect, 'x')).toBe('before');
    expect(dropSide({ clientX: 201, clientY: 0 }, rect, 'x')).toBe('after');
    expect(dropSide({ clientX: 300, clientY: 0 }, rect, 'x')).toBe('after');
  });

  it('treats the exact middle as before, matching the existing strict comparison', () => {
    expect(dropSide({ clientX: 0, clientY: 240 }, rect, 'y')).toBe('before');
    expect(dropSide({ clientX: 200, clientY: 0 }, rect, 'x')).toBe('before');
  });
});
