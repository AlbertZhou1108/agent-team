import type {
  TelemetryAggregation,
  TelemetryBatch,
  TelemetryCapability,
  TelemetryCompleteness,
  TelemetryCoverage,
  TelemetryMetric,
  TelemetryMetrics,
  TelemetryMissingReason,
  TelemetryQuality,
} from '@/shared/api/raw-types';

export const METRIC_LABELS: Record<keyof TelemetryMetrics, string> = {
  inputTokensTotal: '输入总量',
  uncachedInputTokens: '未缓存输入',
  cacheReadTokens: '缓存读取',
  cacheWriteTokens: '缓存写入',
  outputTokens: '输出',
  totalTokens: '总 token',
  cacheReadRatio: '缓存读取占比',
  executionWallMs: '框架耗时',
  hostTurnWallMs: '宿主回合耗时',
};

export const METRIC_KEYS = Object.keys(METRIC_LABELS) as Array<
  keyof TelemetryMetrics
>;

export const CONTEXT_METRIC_LABELS = {
  lastRequestInputTokens: '最近请求输入',
  contextWindowTokens: '上下文容量',
  lastRequestInputRatio: '最近请求输入占比',
} as const;

const integerFormatter = new Intl.NumberFormat('zh-CN', {
  maximumFractionDigits: 0,
});

const decimalFormatter = new Intl.NumberFormat('zh-CN', {
  maximumFractionDigits: 2,
});

export function isMissing(metric: TelemetryMetric | null | undefined): boolean {
  return !metric || metric.value == null;
}

export function formatInteger(value: number | null): string {
  return value == null ? '—' : integerFormatter.format(value);
}

export function formatDuration(value: number | null): string {
  if (value == null) return '—';
  if (value < 1000) return `${decimalFormatter.format(value)} ms`;
  return `${decimalFormatter.format(value / 1000)} s`;
}

export function formatRatio(value: number | null): string {
  if (value == null) return '—';
  return `${decimalFormatter.format(value * 100)}%`;
}

export function metricDisplay(
  metric: TelemetryMetric,
  kind: keyof TelemetryMetrics,
): string {
  if (metric.value == null) return '—';
  if (kind === 'cacheReadRatio') return formatRatio(metric.value);
  if (kind === 'executionWallMs' || kind === 'hostTurnWallMs') {
    return formatDuration(metric.value);
  }
  return formatInteger(metric.value);
}

export function contextMetricDisplay(
  metric: TelemetryMetric,
  kind: keyof typeof CONTEXT_METRIC_LABELS,
): string {
  if (metric.value == null) return '—';
  return kind === 'lastRequestInputRatio'
    ? formatRatio(metric.value)
    : formatInteger(metric.value);
}

const MISSING_REASON_LABELS: Record<TelemetryMissingReason, string> = {
  unsupported: '宿主不支持',
  not_reported_by_host: '宿主未报告',
  not_captured: '尚未采集',
  scope_mismatch: '范围不匹配',
  dependency_missing: '依赖缺失',
  not_applicable: '不适用',
  anomaly: '数据异常',
};

export function missingReasonLabel(
  reason: TelemetryMissingReason | null | undefined,
): string {
  return reason ? MISSING_REASON_LABELS[reason] : '未说明';
}

const QUALITY_LABELS: Record<TelemetryQuality, string> = {
  host_reported: '宿主报告',
  derived: '派生',
  measured: '框架实测',
  estimated: '估算',
  unknown: '未知',
};

export function qualityLabel(quality: TelemetryQuality): string {
  return QUALITY_LABELS[quality];
}

const COMPLETENESS_LABELS: Record<TelemetryCompleteness, string> = {
  complete: '完整',
  partial: '部分',
  unknown: '未知',
};

export function completenessLabel(
  completeness: TelemetryCompleteness,
): string {
  return COMPLETENESS_LABELS[completeness];
}

const COVERAGE_REASON_LABELS: Record<
  TelemetryCoverage['reasons'][number],
  string
> = {
  no_observations: '无观测',
  partial_capture: '采集不完整',
  missing_usage: '缺少用量',
  failed_attempt: '含失败尝试',
  session_reset: '会话重置',
  anomaly: '含异常',
  model_route_mismatch: '模型路由不匹配',
};

export function coverageReasonLabel(
  reason: TelemetryCoverage['reasons'][number],
): string {
  return COVERAGE_REASON_LABELS[reason];
}

const CAPABILITY_LABELS: Record<TelemetryCapability, string> = {
  direct: '直接采集',
  derived: '可派生',
  unsupported: '宿主不支持',
};

export function capabilityLabel(capability: TelemetryCapability): string {
  return CAPABILITY_LABELS[capability];
}

const BATCH_STATE_LABELS: Record<TelemetryBatch['state'], string> = {
  succeeded: '成功',
  failed: '失败',
  cancelled: '取消',
  unknown: '未知',
};

export function batchStateLabel(state: TelemetryBatch['state']): string {
  return BATCH_STATE_LABELS[state];
}

/**
 * 失败状态用危险色强调;其余状态保持常规文字,不靠颜色承载含义
 * (标签本身已经写明「失败」)。带 ! 是为了在同一行里盖过外层弱化文字与
 * Badge outline 的前景色。
 */
export function batchStateClass(state: TelemetryBatch['state']): string {
  return state === 'failed' ? 'text-destructive!' : '';
}

const SESSION_STATUS_LABELS: Record<
  'active' | 'ended' | 'reset' | 'unknown',
  string
> = {
  active: '活跃',
  ended: '已结束',
  reset: '已重置',
  unknown: '未知',
};

export function sessionStatusLabel(
  status: 'active' | 'ended' | 'reset' | 'unknown',
): string {
  return SESSION_STATUS_LABELS[status];
}

export function countWithValue(metrics: TelemetryMetrics): number {
  return METRIC_KEYS.filter(key => metrics[key]?.value != null).length;
}

export function countMissing(metrics: TelemetryMetrics): number {
  return METRIC_KEYS.filter(key => metrics[key]?.value == null).length;
}

export function batchMergeLabels(batch: TelemetryBatch): string[] {
  const labels: string[] = [];
  if (batch.inputBatch.merge.merged) labels.push('合并投递');
  else labels.push('单一来源');
  if (batch.inputBatch.merge.sharedSources) {
    labels.push(`跨来源 ${batch.inputBatch.merge.sourceCount} 方`);
  }
  labels.push('整批归执行方');
  return labels;
}

export function batchHasExclusiveSubtotal(batch: TelemetryBatch): boolean {
  return (
    batch.inputBatch.merge.exclusiveSubtotal &&
    !batch.inputBatch.merge.merged &&
    !batch.inputBatch.merge.sharedSources
  );
}

export function sourceSubtotalsExcludeMerged(summary: {
  mergedBatchIds: string[];
  sourceSubtotals: Array<{ includedBatchIds: string[] }>;
}): boolean {
  const merged = new Set(summary.mergedBatchIds);
  return summary.sourceSubtotals.every(subtotal =>
    subtotal.includedBatchIds.every(id => !merged.has(id)),
  );
}

export function sharedBatchesAreMerged(summary: {
  mergedBatchIds: string[];
  sharedSourceBatchIds: string[];
}): boolean {
  const merged = new Set(summary.mergedBatchIds);
  return summary.sharedSourceBatchIds.every(id => merged.has(id));
}

export function uniqueBatchIds(batches: TelemetryBatch[]): string[] {
  return [...new Set(batches.map(batch => batch.batchId))];
}

export function aggregationLabel(aggregation: TelemetryAggregation): string {
  const labels: Record<TelemetryAggregation, string> = {
    delta: '增量',
    cumulative: '累计',
    snapshot: '快照',
    sum: '求和',
    ratio: '比例',
    unknown: '口径未知',
  };
  return labels[aggregation];
}

export function formatTimestamp(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}
