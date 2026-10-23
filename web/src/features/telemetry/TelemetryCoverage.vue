<script setup lang="ts">
import { computed } from 'vue';
import { Badge } from '@/components/ui/badge';
import type { TelemetryCoverage } from '@/shared/api/raw-types';
import { coverageReasonLabel, formatTimestamp } from './format';

const props = defineProps<{ coverage: TelemetryCoverage }>();

const variant = computed(() => {
  if (props.coverage.complete) return 'outline';
  if (props.coverage.unknownBatchCount && !props.coverage.partialBatchCount) {
    return 'outline';
  }
  return 'secondary';
});

const label = computed(() =>
  props.coverage.complete
    ? '覆盖完整'
    : props.coverage.reasons.includes('no_observations')
      ? '无观测'
      : '覆盖不完整',
);
</script>

<template>
  <div class="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
    <div class="flex flex-wrap items-center gap-1">
      <Badge :variant="variant">{{ label }}</Badge>
      <Badge v-for="reason in coverage.reasons" :key="reason" variant="outline">{{
        coverageReasonLabel(reason)
      }}</Badge>
      <span class="tabular-nums"
        >批次 {{ coverage.batchCount }} · 完整
        {{ coverage.completeBatchCount }} · 部分
        {{ coverage.partialBatchCount }} · 未知
        {{ coverage.unknownBatchCount }}</span
      >
    </div>
    <p>
      采集起点：{{ formatTimestamp(coverage.captureStartedAt) }}
    </p>
  </div>
</template>
