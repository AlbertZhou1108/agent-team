import { describe, expect, it } from 'vitest';
import type {
  TelemetryBatch,
  TelemetryMetric,
  TelemetryMetrics,
  TelemetrySourceSubtotal,
} from '@/shared/api/raw-types';
import {
  METRIC_KEYS,
  batchHasExclusiveSubtotal,
  batchMergeLabels,
  capabilityLabel,
  contextMetricDisplay,
  formatDuration,
  formatInteger,
  formatRatio,
  metricDisplay,
  missingReasonLabel,
  qualityLabel,
  sourceSubtotalsExcludeMerged,
  sharedBatchesAreMerged,
  uniqueBatchIds,
} from './format';

function metric(overrides: Partial<TelemetryMetric> = {}): TelemetryMetric {
  return {
    value: 10,
    quality: 'host_reported',
    completeness: 'complete',
    scope: 'turn',
    aggregation: 'delta',
    source: 'test.source',
    observedAt: '2026-10-23T00:00:00.000Z',
    ...overrides,
  };
}

function missingMetric(
  reason: TelemetryMetric['missingReason'] = 'not_reported_by_host',
): TelemetryMetric {
  return metric({
    value: null,
    quality: 'unknown',
    completeness: 'unknown',
    aggregation: 'unknown',
    observedAt: null,
    missingReason: reason,
  });
}

function metrics(overrides: Partial<TelemetryMetrics> = {}): TelemetryMetrics {
  return Object.fromEntries(
    METRIC_KEYS.map(key => [key, metric()]),
  ) as unknown as TelemetryMetrics;
}

function batch(overrides: Partial<TelemetryBatch['inputBatch']['merge']> = {}): TelemetryBatch {
  return {
    batchId: 'batch:1',
    frameworkTurnId: 'turn-1',
    executor: { kind: 'member', memberId: 'm1', name: '成员', host: 'codex' },
    physicalSession: {
      instanceId: 'ps_1',
      host: 'codex',
      endpointId: 'ep_1',
      memberId: 'm1',
      context: 'pair',
      peer: 'm2',
      sessionKey: 'default',
      hostSessionNamespace: 'codex:default',
      hostSessionId: 'thread-1',
      firstObservedAt: null,
      resetAt: null,
    },
    inputBatch: {
      batchId: 'batch:1',
      kind: 'single_source',
      messages: [],
      sourceActors: [],
      merge: {
        merged: false,
        sharedSources: false,
        sourceCount: 1,
        countedOnce: true,
        splitBySource: false,
        exclusiveSubtotal: true,
        ...overrides,
      },
      allocation: 'whole_to_executor',
    },
    state: 'succeeded',
    startedAt: null,
    endedAt: null,
    attempts: [],
    metrics: metrics(),
    contextReference: {
      lastRequestInputTokens: metric({ scope: 'request', aggregation: 'snapshot' }),
      contextWindowTokens: metric({ scope: 'request', aggregation: 'snapshot' }),
      lastRequestInputRatio: metric({ aggregation: 'ratio' }),
      sampledAt: null,
      sampleTurnId: null,
      model: null,
    },
    completeness: 'complete',
    anomalies: [],
    provenance: [],
  };
}

function subtotal(included: string[]): TelemetrySourceSubtotal {
  return {
    sourceActorId: 'source-1',
    sourceActorName: '来源成员',
    totals: metrics(),
    includedBatchIds: included,
    excludedMergedBatchIds: [],
  };
}

describe('telemetry formatting', () => {
  it('renders missing metrics as dash without pretending zero', () => {
    expect(metricDisplay(missingMetric(), 'inputTokensTotal')).toBe('—');
    expect(formatInteger(null)).toBe('—');
    expect(formatRatio(null)).toBe('—');
    expect(formatDuration(null)).toBe('—');
    expect(missingReasonLabel('unsupported')).toBe('宿主不支持');
    expect(missingReasonLabel('not_captured')).toBe('尚未采集');
  });

  it('renders explicit zero as a valid value', () => {
    const zero = metric({ value: 0, quality: 'host_reported' });
    expect(metricDisplay(zero, 'cacheReadTokens')).toBe('0');
    expect(formatInteger(0)).toBe('0');
  });

  it('labels capabilities and metric quality without upgrading derived to direct', () => {
    expect(capabilityLabel('direct')).toBe('直接采集');
    expect(capabilityLabel('derived')).toBe('可派生');
    expect(capabilityLabel('unsupported')).toBe('宿主不支持');
    expect(qualityLabel('host_reported')).toBe('宿主报告');
    expect(qualityLabel('derived')).toBe('派生');
    expect(qualityLabel('measured')).toBe('框架实测');
    expect(qualityLabel('unknown')).toBe('未知');
  });

  it('formats ratios as percentages and durations in ms/s', () => {
    expect(formatRatio(0.058688)).toBe('5.87%');
    expect(formatDuration(863)).toBe('863 ms');
    expect(formatDuration(5336)).toBe('5.34 s');
    expect(
      contextMetricDisplay(
        metric({ value: 0.25, aggregation: 'ratio' }),
        'lastRequestInputRatio',
      ),
    ).toBe('25%');
  });
});

describe('telemetry batch merge invariants', () => {
  it('labels merged cross-source batches and keeps them out of exclusive subtotals', () => {
    const merged = batch({
      merged: true,
      sharedSources: true,
      sourceCount: 2,
      exclusiveSubtotal: false,
    });
    expect(batchMergeLabels(merged)).toEqual([
      '合并投递',
      '跨来源 2 方',
      '整批归执行方',
    ]);
    expect(batchHasExclusiveSubtotal(merged)).toBe(false);
  });

  it('labels single-source batches as exclusive', () => {
    const single = batch();
    expect(batchMergeLabels(single)).toEqual(['单一来源', '整批归执行方']);
    expect(batchHasExclusiveSubtotal(single)).toBe(true);
  });

  it('does not split a merged batch despite contradictory API flags', () => {
    const contradictory = batch({ merged: true, exclusiveSubtotal: true });
    expect(batchHasExclusiveSubtotal(contradictory)).toBe(false);
  });
});

describe('telemetry summary invariants', () => {
  it('detects source subtotals that include merged batches', () => {
    expect(
      sourceSubtotalsExcludeMerged({
        mergedBatchIds: ['batch:merged'],
        sourceSubtotals: [subtotal(['batch:single'])],
      }),
    ).toBe(true);
    expect(
      sourceSubtotalsExcludeMerged({
        mergedBatchIds: ['batch:merged'],
        sourceSubtotals: [subtotal(['batch:single', 'batch:merged'])],
      }),
    ).toBe(false);
  });

  it('requires shared batches to be listed as merged', () => {
    expect(
      sharedBatchesAreMerged({
        mergedBatchIds: ['batch:shared'],
        sharedSourceBatchIds: ['batch:shared'],
      }),
    ).toBe(true);
    expect(
      sharedBatchesAreMerged({
        mergedBatchIds: [],
        sharedSourceBatchIds: ['batch:shared'],
      }),
    ).toBe(false);
  });

  it('deduplicates batches when pages overlap', () => {
    const first = batch();
    const second = { ...batch(), batchId: 'batch:2' };
    expect(uniqueBatchIds([first, first, second])).toEqual([
      'batch:1',
      'batch:2',
    ]);
  });
});
