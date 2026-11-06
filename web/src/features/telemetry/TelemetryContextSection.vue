<script setup lang="ts">
import { computed } from 'vue';
import type { TelemetryContextReference } from '@/shared/api/raw-types';
import { CONTEXT_METRIC_LABELS, contextMetricDisplay } from './format';

const props = withDefaults(
  defineProps<{
    contextReference: TelemetryContextReference;
    title?: string;
    columns?: 1 | 3;
  }>(),
  { columns: 3 },
);

const metrics = computed(() =>
  (
    Object.keys(CONTEXT_METRIC_LABELS) as Array<
      keyof typeof CONTEXT_METRIC_LABELS
    >
  ).map(key => ({
    key,
    label: CONTEXT_METRIC_LABELS[key],
    metric: props.contextReference[key],
  })),
);
</script>

<template>
  <section class="flex min-w-0 flex-col gap-2">
    <h4 class="text-xs font-semibold">{{ title ?? '上下文参考' }}</h4>
    <dl
      class="grid gap-x-3 gap-y-2"
      :class="columns === 1 ? 'grid-cols-1' : 'grid-cols-3'"
    >
      <div
        v-for="item in metrics"
        :key="item.key"
        class="flex min-w-0 flex-col gap-0.5"
        :data-context-metric-key="item.key"
      >
        <dt class="text-2xs text-muted-foreground">{{ item.label }}</dt>
        <dd class="flex min-w-0 flex-wrap items-center gap-1">
          <span class="text-sm font-medium tabular-nums">{{
            contextMetricDisplay(item.metric, item.key)
          }}</span>
        </dd>
      </div>
    </dl>
    <p v-if="contextReference.model" class="text-2xs text-muted-foreground">
      模型：{{ contextReference.model.provider ? `${contextReference.model.provider}/` : '' }}{{ contextReference.model.model }}
    </p>
  </section>
</template>
