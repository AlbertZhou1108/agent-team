import { describe, expect, it } from 'vitest';
import { resolveMotionStyle } from './motion';

describe('resolveMotionStyle', () => {
  it('follows the system preference only when set to system', () => {
    expect(resolveMotionStyle('system', true)).toBe('reduced');
    expect(resolveMotionStyle('system', false)).toBe('simple');
  });

  it('lets an explicit user choice win over the system preference', () => {
    expect(resolveMotionStyle('reduced', false)).toBe('reduced');
    expect(resolveMotionStyle('simple', true)).toBe('simple');
    expect(resolveMotionStyle('soft', true)).toBe('soft');
    expect(resolveMotionStyle('lively', false)).toBe('lively');
  });
});
