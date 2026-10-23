<script setup lang="ts">
import { computed } from 'vue';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import type { TelemetryMembersResponse } from '@/shared/api/raw-types';
import { compactNumber, relativeValues } from './visuals';
const props = defineProps<{ members: TelemetryMembersResponse['members']; selectedId?: string }>();
const emit = defineEmits<{ select: [id: string] }>();
const rows = computed(() => {
  const members = new Map(props.members.map(m => [m.executor.memberId, m]));
  return relativeValues(props.members.map(m => ({ id: m.executor.memberId, metric: m.totals.totalTokens })))
    .map(r => ({ ...r, executor: members.get(r.id)!.executor }));
});
</script>
<template>
  <Card>
    <CardHeader>
      <CardTitle class="text-sm">成员消耗对比</CardTitle>
      <CardDescription>按已观测 token 比较；选择成员查看详情</CardDescription>
    </CardHeader>
    <CardContent class="flex min-w-0 flex-col gap-4">
      <div v-for="row in rows" :key="row.id" class="flex min-w-0 flex-col gap-2">
        <Button :variant="row.id === selectedId ? 'secondary' : 'ghost'" class="h-auto min-w-0 justify-between gap-3 text-xs" :aria-pressed="row.id === selectedId" @click="emit('select', row.id)">
          <div class="flex min-w-0 items-center gap-2">
            <span class="truncate" :title="row.executor.name">{{ row.executor.name }}</span>
            <span class="shrink-0 text-muted-foreground">{{ row.executor.host }}</span>
          </div>
          <div class="flex shrink-0 items-center gap-1 tabular-nums" :title="row.value?.toLocaleString()">
            <Badge v-if="row.value != null && row.metric.completeness !== 'complete'" variant="outline">部分</Badge>
            <span>{{ compactNumber(row.value) }}</span>
            <Badge v-if="row.metric.quality === 'estimated'" variant="outline">估算</Badge>
          </div>
        </Button>
        <Progress v-if="row.percent != null" :model-value="row.percent" :aria-label="`${row.executor.name}：${row.value} token，相对最大值 ${row.percent.toFixed(1)}%`" class="h-2" />
        <span v-else class="text-xs text-muted-foreground">尚无观测</span>
      </div>
    </CardContent>
  </Card>
</template>
