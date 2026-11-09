import { describe, expect, it } from 'vitest';
import { motionDurationMs, resolveMotionStyle } from '@/shared/motion';

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

describe('motionDurationMs', () => {
  it('uses the contract tiers instead of ad-hoc numbers', () => {
    // 无 DOM(节奏系数回落为 1)时即契约基准:150 / 220 / 320。
    expect(motionDurationMs('fast')).toBe(150);
    expect(motionDurationMs('normal')).toBe(220);
    expect(motionDurationMs('slow')).toBe(320);
  });
});
