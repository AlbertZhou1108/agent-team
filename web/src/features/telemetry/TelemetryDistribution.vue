<script setup lang="ts">
import { computed } from 'vue';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription } from '@/components/ui/empty';
import { Progress } from '@/components/ui/progress';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { TelemetryMetrics } from '@/shared/api/raw-types';
import { compactNumber } from './visuals';
type DistributionRow = { id: string; name: string; batchCount: number; metrics: TelemetryMetrics };
const props = defineProps<{ title: string; rows: DistributionRow[]; selected?: string }>();
const emit = defineEmits<{ select: [id: string] }>();
const metric = defineModel<string>('metric', { default: 'tokens' });
const value = (row: DistributionRow) => metric.value === 'turns' ? row.batchCount : row.metrics.totalTokens.value;
const sorted = computed(() => props.rows.filter(row => (value(row) ?? 0) > 0).sort((a, b) => (value(b) ?? -1) - (value(a) ?? -1)));
const total = computed(() => sorted.value.reduce((sum, row) => sum + (value(row) ?? 0), 0));
</script>
<template>
  <Card size="compact" class="min-w-0">
    <CardHeader><CardTitle>{{ title }}</CardTitle>
      <ToggleGroup type="single" :model-value="metric" :aria-label="`${title}指标`" @update:model-value="v => { if (v) metric = String(v); }">
        <ToggleGroupItem value="tokens">Token</ToggleGroupItem><ToggleGroupItem value="turns">回合数</ToggleGroupItem>
      </ToggleGroup>
    </CardHeader>
    <CardContent class="flex max-h-80 min-w-0 flex-col gap-3 overflow-y-auto">
      <Empty v-if="!sorted.length"><EmptyDescription>暂无数据</EmptyDescription></Empty>
      <Button v-for="row in sorted" :key="row.id" :variant="selected === row.id ? 'secondary' : 'ghost'" class="h-auto min-w-0 justify-start" :aria-pressed="selected === row.id" @click="emit('select', row.id)">
        <span class="flex w-full min-w-0 flex-col gap-2">
          <span class="flex min-w-0 justify-between gap-3"><span class="truncate">{{ row.name }}</span><span class="shrink-0 tabular-nums">{{ value(row) === null ? '—' : compactNumber(value(row)!) }} · {{ total ? ((value(row) ?? 0) / total * 100).toFixed(1) : '0' }}%</span></span>
          <Progress :model-value="total ? (value(row) ?? 0) / total * 100 : 0" :aria-label="row.name" />
        </span>
      </Button>
    </CardContent>
  </Card>
</template>
