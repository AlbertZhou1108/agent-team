<script setup lang="ts">
import { Disclosure } from '@/components/ui/disclosure';
import { computed } from 'vue';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import type { TelemetryMetrics } from '@/shared/api/raw-types';
import { METRIC_KEYS, METRIC_LABELS, metricDisplay } from './format';
import { compactDuration, compactNumber, numeric, ratioPercent, tokenComposition } from './visuals';
const props = withDefaults(defineProps<{ metrics: TelemetryMetrics; showDetail?: boolean; columns?: 1 | 2 | 3 }>(), { showDetail: true, columns: 2 });
const primary = ['totalTokens', 'cacheReadRatio', 'executionWallMs'] as const;
const keys = computed(() => props.showDetail ? primary : METRIC_KEYS);
const composition = computed(() => tokenComposition(props.metrics));
const cache = computed(() => ratioPercent(props.metrics.cacheReadRatio));
function display(key: keyof TelemetryMetrics) {
  if (key === 'executionWallMs') return compactDuration(numeric(props.metrics[key]));
  return key === 'totalTokens' ? compactNumber(numeric(props.metrics[key])) : metricDisplay(props.metrics[key], key);
}
</script>
<template>
  <div class="flex min-w-0 flex-col gap-3">
    <dl :class="cn('grid gap-x-4 gap-y-3', showDetail ? 'grid-cols-3' : columns === 1 ? 'grid-cols-1' : columns === 3 ? 'grid-cols-3' : 'grid-cols-2')">
      <div v-for="key in keys" :key="key" class="flex min-w-0 flex-col gap-1" :data-metric-key="key">
        <dt class="text-xs text-muted-foreground">{{ key === 'totalTokens' ? 'Token 消耗' : key === 'cacheReadRatio' ? '缓存占比' : METRIC_LABELS[key] }}</dt>
        <dd class="flex min-w-0 flex-col gap-1">
          <span :class="cn('font-medium tabular-nums', showDetail ? 'text-lg' : 'text-sm')" :title="metricDisplay(metrics[key], key)">{{ display(key) }}</span>
        </dd>
      </div>
    </dl>
    <div v-if="showDetail && composition" class="flex flex-col gap-1.5">
      <div class="flex h-2 overflow-hidden rounded-full bg-muted" role="img" :aria-label="`输入 ${composition.input} token，输出 ${composition.output} token`">
        <div class="bg-primary" :style="{ width: `${composition.inputPercent}%` }" />
        <div class="flex-1 bg-muted-foreground/40" />
      </div>
      <div class="flex justify-between text-xs text-muted-foreground">
        <span>输入 {{ compactNumber(composition.input) }}</span><span>输出 {{ compactNumber(composition.output) }}</span>
      </div>
    </div>
    <div v-if="showDetail && cache != null" class="flex items-center gap-2">
      <span class="shrink-0 text-xs text-muted-foreground">缓存读取占输入</span>
      <Progress :model-value="cache" :aria-label="`缓存读取占输入 ${cache.toFixed(1)}%`" class="h-1.5" />
    </div>
    <Disclosure v-if="showDetail">
      <template #summary>全部指标</template>
      <dl class="mt-3 flex max-h-[min(24rem,50vh)] min-w-0 flex-col gap-3 overflow-y-auto overscroll-contain pr-2 [overflow-wrap:anywhere] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" role="region" aria-label="全部指标内容" tabindex="0">
        <div v-for="key in METRIC_KEYS" :key="key" class="flex flex-wrap items-center justify-between gap-2 text-foreground">
          <dt>{{ METRIC_LABELS[key] }}</dt>
          <dd>{{ metricDisplay(metrics[key], key) }}</dd>
        </div>
      </dl>
    </Disclosure>
  </div>
</template>
