<script setup lang="ts">
import { computed } from 'vue';
import { ListChecks } from '@lucide/vue';
import { Badge } from '@/components/ui/badge';
import type { TelemetryBatch } from '@/shared/api/raw-types';
import TelemetryBatchCard from './TelemetryBatchCard.vue';
import TelemetryBatchSection from './TelemetryBatchSection.vue';
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
  <TelemetryBatchSection
    :count="batches.length"
    :has-more="Boolean(nextCursor)"
    :fetching="fetchingNextPage"
    :empty-icon="ListChecks"
    :empty-title="emptyTitle"
    :empty-description="emptyDescription"
    @load-more="emit('loadMore')"
  >
    <template v-if="!invariantOk" #badges>
      <Badge variant="destructive">归因异常</Badge>
    </template>
    <template #notice>
      <p v-if="!invariantOk" class="text-xs text-destructive">
        服务端返回的来源小计包含合并批次，或共同批次未列入合并批次；页面不自行重算，请回查 API。
      </p>
    </template>
    <TelemetryBatchCard
      v-for="batch in batches"
      :key="batch.batchId"
      :batch="batch"
      :shared="sharedIds.has(batch.batchId)"
      :data-merged="mergedIds.has(batch.batchId) || undefined"
    />
  </TelemetryBatchSection>
</template>
