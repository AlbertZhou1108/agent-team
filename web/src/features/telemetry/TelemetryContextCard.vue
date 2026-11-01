<script setup lang="ts">
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { computed } from 'vue';
import { Badge } from '@/components/ui/badge';
import type { TelemetryContextReference } from '@/shared/api/raw-types';
import TelemetryMetricBadge from './TelemetryMetricBadge.vue';
import {
  CONTEXT_METRIC_LABELS,
  contextMetricDisplay,
  formatTimestamp,
} from './format';

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
  <Card size="compact">
    <CardHeader>
    <div class="flex flex-wrap items-center justify-between gap-2">
      <CardTitle>
        {{ title ?? '上下文参考（最近请求采样）' }}
      </CardTitle>
      <Badge variant="outline">不可相加</Badge>
    </div>
    </CardHeader>
    <CardContent class="flex min-w-0 flex-col gap-3">
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
          <TelemetryMetricBadge :metric="item.metric" compact />
        </dd>
      </div>
    </dl>
    <p class="text-2xs text-muted-foreground">
      模型：
      {{
        contextReference.model
          ? `${contextReference.model.provider ? `${contextReference.model.provider}/` : ''}${contextReference.model.model}`
          : '未报告'
      }}
      · 采样：{{ formatTimestamp(contextReference.sampledAt) }}
    </p>
    <p class="text-2xs text-muted-foreground">
      最近请求输入与窗口容量是采样值，不是累计消耗，也不预测下一次请求占用。
    </p>
    </CardContent>
  </Card>
</template>
