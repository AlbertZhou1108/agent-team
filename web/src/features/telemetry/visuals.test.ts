import { describe, expect, it } from 'vitest';
import type { TelemetryMetric, TelemetryMetrics } from '@/shared/api/raw-types';
import { compactNumber, numeric, ratioPercent, relativeValues, tokenComposition } from './visuals';
const metric = (value: number | null) => ({ value, completeness: 'complete', quality: 'host_reported' }) as TelemetryMetric;
const metrics = (input: number | null, output: number | null, total: number | null) => ({ inputTokensTotal: metric(input), outputTokens: metric(output), totalTokens: metric(total) }) as TelemetryMetrics;
describe('telemetry visual values', () => {
  it('keeps missing distinct from zero and rejects invalid graphical values', () => {
    expect(compactNumber(null)).toBe('—'); expect(compactNumber(0)).toBe('0');
    for (const n of [null, NaN, Infinity, -1]) expect(numeric(metric(n))).toBeNull();
    expect(numeric(metric(0))).toBe(0);
  });
  it('does not fabricate an input/output breakdown for incomplete or inconsistent totals', () => {
    expect(tokenComposition(metrics(80, 20, 100))).toEqual({ input: 80, output: 20, inputPercent: 80 });
    expect(tokenComposition(metrics(null, 20, 100))).toBeNull();
    expect(tokenComposition(metrics(80, 20, 110))).toBeNull();
    expect(tokenComposition(metrics(0, 0, 0))).toBeNull();
  });
  it('keeps ratios bounded without silently correcting bad source values', () => {
    expect(ratioPercent(metric(0.25))).toBe(25);
    expect(ratioPercent(metric(1.1))).toBeNull();
    expect(ratioPercent(metric(null))).toBeNull();
  });
  it('compares against the maximum instead of summing members and preserves unknowns', () => {
    const rows = relativeValues([{ id: 'missing', metric: metric(null) }, { id: 'small', metric: metric(10) }, { id: 'big', metric: metric(20) }, { id: 'zero', metric: metric(0) }]);
    expect(rows.map(r => [r.id, r.percent])).toEqual([['big', 100], ['small', 50], ['zero', 0], ['missing', null]]);
  });
});
