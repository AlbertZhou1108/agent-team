<script setup lang="ts">
import { Disclosure } from '@/components/ui/disclosure';
import { computed } from 'vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { MessagesSquare } from '@lucide/vue';
import PanelState from '@/components/panel/PanelState.vue';
import { useCoordinationTelemetryQuery } from '@/features/queries';
import TelemetryExecutorCard from './TelemetryExecutorCard.vue';
import TelemetryBatchList from './TelemetryBatchList.vue';
import TelemetrySourceSubtotals from './TelemetrySourceSubtotals.vue';
import { formatTimestamp } from './format';

const props = defineProps<{ groupId: string }>();

const query = useCoordinationTelemetryQuery(() => props.groupId || undefined);
const data = computed(() => query.firstPage.value);
const summary = computed(() => data.value?.summary);
const coordination = computed(() => data.value?.coordination);

async function loadMore() {
  await query.fetchNextPage();
}
</script>

<template>
  <div class="flex min-w-0 flex-col gap-4">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex flex-wrap items-center gap-1">
        <h3 class="text-sm font-semibold">主 Agent 协调会话</h3>
        <Badge variant="outline">按输入批次</Badge>
      </div>
      <span class="text-2xs text-muted-foreground"
        >更新 {{ formatTimestamp(data?.generatedAt ?? null) }}</span
      >
    </div>
    <PanelState
      v-if="query.isPending.value"
      loading
      title="正在读取协调遥测"
    />
    <Alert v-else-if="query.error.value" variant="destructive">
      <AlertDescription
        >读取协调遥测失败：{{ query.error.value.message }}</AlertDescription
      >
    </Alert>
    <template v-else-if="data && coordination && summary">
      <TelemetryExecutorCard
        :executor="coordination.executor"
        :totals="summary.executorTotals"
        :context-reference="summary.contextReference"
        :physical-sessions="coordination.physicalSessions"
        :batch-count="summary.coverage.batchCount"
        :coverage="summary.coverage"
        title="协调执行方"
      />

      <TelemetrySourceSubtotals
        :subtotals="summary.sourceSubtotals"
        :merged-batch-ids="summary.mergedBatchIds"
        :shared-source-batch-ids="summary.sharedSourceBatchIds"
      />

      <TelemetryBatchList
        :batches="query.batches.value"
        :shared-source-batch-ids="summary.sharedSourceBatchIds"
        :merged-batch-ids="summary.mergedBatchIds"
        :source-subtotals="summary.sourceSubtotals"
        :next-cursor="data.nextCursor"
        :fetching-next-page="query.isFetchingNextPage.value"
        empty-title="暂无协调批次"
        empty-description="协调会话产生宿主执行回合并上报指标后，会在这里按输入批次展示。"
        @load-more="loadMore"
      />
    </template>
    <PanelState
      v-else-if="data && !coordination"
      :icon="MessagesSquare"
      title="暂无协调会话遥测"
      description="该群尚未解析到协调执行方或还没有遥测批次。"
    />
  </div>
</template>
