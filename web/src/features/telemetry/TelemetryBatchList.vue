<script setup lang="ts">
import { computed } from 'vue';
import { LoaderCircle, ListChecks } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import PanelState from '@/components/panel/PanelState.vue';
import type { TelemetryBatch } from '@/shared/api/raw-types';
import TelemetryBatchCard from './TelemetryBatchCard.vue';
import { sharedBatchesAreMerged, sourceSubtotalsExcludeMerged } from './format';

const props = withDefaults(
  defineProps<{
    batches: TelemetryBatch[];
    sharedSourceBatchIds?: string[];
    mergedBatchIds?: string[];
    sourceSubtotals?: Array<{ includedBatchIds: string[] }>;
    nextCursor?: string | null;
    fetchingNextPage?: boolean;
    emptyTitle?: string;
    emptyDescription?: string;
  }>(),
  {
    sharedSourceBatchIds: () => [],
    mergedBatchIds: () => [],
    sourceSubtotals: () => [],
    nextCursor: null,
    fetchingNextPage: false,
    emptyTitle: '暂无遥测批次',
    emptyDescription: '宿主执行回合并上报指标后，会显示在这里。',
  },
);

const emit = defineEmits<{ loadMore: [] }>();

const sharedIds = computed(() => new Set(props.sharedSourceBatchIds));
const mergedIds = computed(() => new Set(props.mergedBatchIds));
const invariantOk = computed(() =>
  sourceSubtotalsExcludeMerged({
    mergedBatchIds: props.mergedBatchIds,
    sourceSubtotals: props.sourceSubtotals,
  }) &&
  sharedBatchesAreMerged({
    mergedBatchIds: props.mergedBatchIds,
    sharedSourceBatchIds: props.sharedSourceBatchIds,
  }),
);
</script>

<template>
  <div class="flex min-w-0 flex-col gap-3">
    <div class="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
      <Badge variant="outline">批次 {{ batches.length }}</Badge>
      <Badge v-if="mergedBatchIds.length" variant="outline"
        >合并 {{ mergedBatchIds.length }}</Badge
      >
      <Badge v-if="sharedSourceBatchIds.length" variant="default"
        >共同批次 {{ sharedSourceBatchIds.length }}</Badge
      >
      <Badge :variant="invariantOk ? 'outline' : 'destructive'">{{
        invariantOk ? '归因口径一致' : '归因口径异常'
      }}</Badge>
    </div>
    <p v-if="!invariantOk" class="text-xs text-destructive">
      服务端返回的来源小计包含合并批次，或共同批次未列入合并批次；页面不自行重算，请回查 API。
    </p>

    <PanelState
      v-if="!batches.length"
      :icon="ListChecks"
      :title="emptyTitle"
      :description="emptyDescription"
    />
    <TelemetryBatchCard
      v-for="batch in batches"
      :key="batch.batchId"
      :batch="batch"
      :shared="sharedIds.has(batch.batchId)"
      :data-merged="mergedIds.has(batch.batchId) || undefined"
    />

    <Button
      v-if="nextCursor"
      variant="outline"
      size="sm"
      class="w-full"
      :disabled="fetchingNextPage"
      @click="emit('loadMore')"
    >
      <LoaderCircle v-if="fetchingNextPage" class="animate-spin" />
      {{ fetchingNextPage ? '正在加载' : '加载更多批次' }}
    </Button>
  </div>
</template>
