<script setup lang="ts">
import { computed } from 'vue';
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
  <section class="flex min-w-0 flex-col gap-2" aria-label="成员 Token 消耗排行">
    <div class="flex justify-between px-2 text-xs text-muted-foreground"><span>成员</span><span>Token 消耗</span></div>
    <Button v-for="row in rows" :key="row.id" :variant="row.id === selectedId ? 'secondary' : 'ghost'" class="h-auto min-w-0 justify-between gap-2 py-2" :aria-label="row.executor.name + '，' + (row.value == null ? '暂无观测' : row.value.toLocaleString() + ' Token') + '，查看详情'" :aria-pressed="row.id === selectedId" @click="emit('select', row.id)">
      <span class="min-w-0 truncate" :title="row.executor.name">{{ row.executor.name }}</span>
      <span class="flex shrink-0 items-center gap-1 tabular-nums">
        <Badge v-if="row.value != null && row.metric.completeness !== 'complete'" variant="outline">部分</Badge>
        <Badge v-if="row.metric.quality === 'estimated'" variant="outline">估算</Badge>
        <span :title="row.value?.toLocaleString()">{{ row.value == null ? '—' : compactNumber(row.value) }}</span>
      </span>
    </Button>
  </section>
</template>
