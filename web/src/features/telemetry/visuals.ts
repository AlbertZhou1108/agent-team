import type { TelemetryMetric, TelemetryMetrics } from '@/shared/api/raw-types';
export function numeric(metric: TelemetryMetric | undefined): number | null {
  const n = metric?.value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
}
export function compactNumber(value: number | null): string {
  return value == null ? '—' : new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}
export function ratioPercent(metric: TelemetryMetric): number | null {
  const ratio = numeric(metric);
  return ratio == null || ratio > 1 ? null : ratio * 100;
}
export function tokenComposition(metrics: TelemetryMetrics) {
  const input = numeric(metrics.inputTokensTotal), output = numeric(metrics.outputTokens), total = numeric(metrics.totalTokens);
  if (input == null || output == null || total == null || total <= 0 || input + output !== total) return null;
  return { input, output, inputPercent: input / total * 100 };
}
export function relativeValues(rows: Array<{ id: string; metric: TelemetryMetric }>) {
  const values = rows.map(r => ({ ...r, value: numeric(r.metric) }));
  const max = Math.max(0, ...values.flatMap(r => r.value == null ? [] : [r.value]));
  return values.sort((a, b) => (b.value ?? -1) - (a.value ?? -1)).map(r => ({ ...r, percent: r.value == null ? null : max > 0 ? r.value / max * 100 : 0 }));
}
export function compactDuration(value: number | null) {
  if (value == null) return '—';
  if (value >= 3600000) return `${(value / 3600000).toFixed(1)} h`;
  if (value >= 60000) return `${(value / 60000).toFixed(1)} min`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)} s`;
  return `${Math.round(value)} ms`;
}
