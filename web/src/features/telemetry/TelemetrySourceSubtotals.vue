<script setup lang="ts">
import { Disclosure } from '@/components/ui/disclosure';
import { Badge } from '@/components/ui/badge';
import type { TelemetrySourceSubtotal } from '@/shared/api/raw-types';
import TelemetryMetricGrid from './TelemetryMetricGrid.vue';
import { metricDisplay } from './format';

defineProps<{
  subtotals: TelemetrySourceSubtotal[];
  mergedBatchIds: string[];
  sharedSourceBatchIds: string[];
  note?: string;
}>();
</script>

<template>
  <section class="flex min-w-0 flex-col gap-3">
    <h4 class="text-sm font-semibold">来源分析</h4>
      <p v-if="!subtotals.length" class="text-xs text-muted-foreground">
        暂无可归入来源小计的单一来源批次。
      </p>
      <div v-else class="divide-y divide-border">
        <Disclosure
          v-for="subtotal in subtotals.filter(item => item.includedBatchIds.length)"
          :key="subtotal.sourceActorId"
          :data-source-actor-id="subtotal.sourceActorId"
        >
          <template #summary>
            <span class="font-medium">{{ subtotal.sourceActorName }}</span>
            <Badge variant="outline"
              >{{ subtotal.includedBatchIds.length }} 批次</Badge
            >
            <span class="text-muted-foreground tabular-nums"
              >输入
              {{
                metricDisplay(
                  subtotal.totals.inputTokensTotal,
                  'inputTokensTotal',
                )
              }}
              · 输出
              {{ metricDisplay(subtotal.totals.outputTokens, 'outputTokens') }}
              · 合计
              {{ metricDisplay(subtotal.totals.totalTokens, 'totalTokens') }}</span
            >
          </template>
          <TelemetryMetricGrid
            :metrics="subtotal.totals"
            :show-detail="false"
            :columns="2"
          />
        </Disclosure>
      </div>
  </section>
</template>
