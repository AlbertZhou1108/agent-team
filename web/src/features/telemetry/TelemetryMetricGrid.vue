<script setup lang="ts">
import { Badge } from '@/components/ui/badge';
import type { TelemetryMetrics } from '@/shared/api/raw-types';
import TelemetryMetricBadge from './TelemetryMetricBadge.vue';
import {
  METRIC_KEYS,
  METRIC_LABELS,
  aggregationLabel,
  completenessLabel,
  countMissing,
  countWithValue,
  formatTimestamp,
  metricDisplay,
  missingReasonLabel,
  qualityLabel,
} from './format';

withDefaults(
  defineProps<{
    metrics: TelemetryMetrics;
    showDetail?: boolean;
    columns?: 1 | 2 | 3;
  }>(),
  { showDetail: true, columns: 2 },
);
</script>

<template>
  <div class="flex min-w-0 flex-col gap-3">
    <dl
      class="grid gap-x-4 gap-y-3"
      :class="
        columns === 3
          ? 'grid-cols-3'
          : columns === 1
            ? 'grid-cols-1'
            : 'grid-cols-2'
      "
    >
      <div
        v-for="key in METRIC_KEYS"
        :key="key"
        class="flex min-w-0 flex-col gap-1"
        :data-metric-key="key"
      >
        <dt class="text-xs text-muted-foreground">{{ METRIC_LABELS[key] }}</dt>
        <dd class="flex min-w-0 flex-wrap items-center gap-1">
          <span
            class="text-sm font-medium tabular-nums"
            :title="`${metrics[key].source}${
              metrics[key].formula ? ` · ${metrics[key].formula}` : ''
            }`"
            >{{ metricDisplay(metrics[key], key) }}</span
          >
          <TelemetryMetricBadge :metric="metrics[key]" compact />
        </dd>
      </div>
    </dl>

    <details v-if="showDetail" class="text-xs text-muted-foreground">
      <summary class="w-fit cursor-pointer">
        来源与完整性 · 有值 {{ countWithValue(metrics) }}/{{ METRIC_KEYS.length }} ·
        缺失 {{ countMissing(metrics) }}
      </summary>
      <ul class="mt-2 flex flex-col gap-2">
        <li
          v-for="key in METRIC_KEYS"
          :key="key"
          class="flex flex-col gap-0.5 border-l-2 border-border pl-2"
        >
          <span class="font-medium text-foreground"
            >{{ METRIC_LABELS[key] }}：
            <template v-if="metrics[key].value == null">未采集</template>
            <template v-else>{{ metricDisplay(metrics[key], key) }}</template>
          </span>
          <span class="break-all">
            {{ qualityLabel(metrics[key].quality) }} ·
            {{ completenessLabel(metrics[key].completeness) }} ·
            {{ aggregationLabel(metrics[key].aggregation) }} ·
            {{ metrics[key].source }}
          </span>
          <span v-if="metrics[key].formula" class="break-all"
            >公式：{{ metrics[key].formula }}</span
          >
          <span v-if="metrics[key].value == null" class="break-all"
            >缺失原因：{{ missingReasonLabel(metrics[key].missingReason) }}</span
          >
          <span class="break-all"
            >采样：{{ formatTimestamp(metrics[key].observedAt) }}</span
          >
        </li>
      </ul>
    </details>
    <Badge v-if="!showDetail && countMissing(metrics)" variant="outline">
      {{ countMissing(metrics) }} 项未采集
    </Badge>
  </div>
</template>
