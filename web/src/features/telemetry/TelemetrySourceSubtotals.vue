<script setup lang="ts">
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Disclosure } from '@/components/ui/disclosure';
import { Badge } from '@/components/ui/badge';
import type { TelemetrySourceSubtotal } from '@/shared/api/raw-types';
import TelemetryMetricGrid from './TelemetryMetricGrid.vue';
import { METRIC_LABELS, metricDisplay } from './format';

defineProps<{
  subtotals: TelemetrySourceSubtotal[];
  mergedBatchIds: string[];
  sharedSourceBatchIds: string[];
  note?: string;
}>();


function metricLabel(key: keyof TelemetrySourceSubtotal['totals']) {
  return METRIC_LABELS[key];
}
</script>

<template>
  <Card size="compact">
    <CardHeader>
    <div class="flex flex-wrap items-center justify-between gap-2">
      <CardTitle>来源分析（不与执行归属相加）</CardTitle>
      <div class="flex flex-wrap gap-1">
        <Badge variant="outline">合并批次 {{ mergedBatchIds.length }}</Badge>
        <Badge variant="outline"
          >共同批次 {{ sharedSourceBatchIds.length }}</Badge
        >
      </div>
    </div>
    </CardHeader>
    <CardContent class="flex min-w-0 flex-col gap-3">
    <p class="text-2xs text-muted-foreground">
      {{
        note ??
        '本视图按消息触发来源统计，仅含单一来源批次；合并批次不拆分、不重复计入。它不能与成员执行归属总量相加。'
      }}
    </p>
    <p v-if="!subtotals.length" class="text-xs text-muted-foreground">
      暂无可归入来源小计的单一来源批次。
    </p>
    <Disclosure
      v-for="subtotal in subtotals"
      :key="subtotal.sourceActorId"
      variant="card"
      :data-source-actor-id="subtotal.sourceActorId"
    >
      <template #summary>
        <span class="font-medium">{{ subtotal.sourceActorName }}</span>
        <Badge variant="outline"
          >{{ subtotal.includedBatchIds.length }} 批次</Badge
        >
        <Badge v-if="subtotal.excludedMergedBatchIds.length" variant="outline"
          >排除合并 {{ subtotal.excludedMergedBatchIds.length }}</Badge
        >
        <span class="text-muted-foreground"
          >{{ metricLabel('inputTokensTotal') }}
          {{
            metricDisplay(
              subtotal.totals.inputTokensTotal,
              'inputTokensTotal',
            )
          }}
          · {{ metricLabel('outputTokens') }}
          {{ metricDisplay(subtotal.totals.outputTokens, 'outputTokens') }}
          · {{ metricLabel('totalTokens') }}
          {{ metricDisplay(subtotal.totals.totalTokens, 'totalTokens') }}</span
        >
      </template>
      <div class="mt-3">
        <TelemetryMetricGrid
          :metrics="subtotal.totals"
          :show-detail="false"
          :columns="2"
        />
      </div>
    </Disclosure>
    </CardContent>
  </Card>
</template>
