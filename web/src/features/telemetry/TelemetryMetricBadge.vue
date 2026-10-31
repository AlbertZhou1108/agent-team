<script setup lang="ts">
import { computed } from 'vue';
import { Badge } from '@/components/ui/badge';
import type { TelemetryMetric } from '@/shared/api/raw-types';
import {
  completenessLabel,
  missingReasonLabel,
  qualityLabel,
} from './format';

const props = defineProps<{
  metric: TelemetryMetric;
  compact?: boolean;
}>();

const labels = computed(() => {
  const metric = props.metric;
  if (metric.value == null) return [missingReasonLabel(metric.missingReason)];
  const result: string[] = [];
  if (metric.completeness === 'partial') result.push('部分');
  if (metric.quality === 'derived') result.push('派生');
  else if (metric.quality === 'measured') result.push('实测');
  else if (metric.quality === 'estimated') result.push('估算');
  return result;
});

const title = computed(
  () =>
    `${qualityLabel(props.metric.quality)} · ${completenessLabel(
      props.metric.completeness,
    )} · ${props.metric.source}${
      props.metric.formula ? ` · ${props.metric.formula}` : ''
    }`,
);
</script>

<template>
  <Badge
    v-for="label in labels"
    :key="label"
    :variant="metric.value == null ? 'outline' : 'secondary'"
    :title="title"
    :class="compact ? 'text-2xs' : undefined"
    >{{ label }}</Badge
  >
</template>
