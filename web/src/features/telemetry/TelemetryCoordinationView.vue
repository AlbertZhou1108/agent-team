<script setup lang="ts">
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
        <Badge variant="outline">只读</Badge>
      </div>
      <span class="text-[11px] text-muted-foreground"
        >更新 {{ formatTimestamp(data?.generatedAt ?? null) }}</span
      >
    </div>
    <p class="text-xs text-muted-foreground">
      每个输入批次只出现一次。合并投递展示整批总消耗与全部来源，不拆分、不平均、不向每个来源重复计入；跨来源共同批次独立展示且不计入对话独占小计。
    </p>

    <PanelState
      v-if="query.isPending.value"
      loading
      title="正在读取协调遥测"
      description="等待服务端返回协调批次与执行方汇总。"
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

      <section class="flex flex-wrap items-center gap-1 text-xs">
        <Badge variant="outline"
          >单一来源 {{ summary.singleSourceBatchIds.length }}</Badge
        >
        <Badge variant="outline"
          >合并投递 {{ summary.mergedBatchIds.length }}</Badge
        >
        <Badge variant="default"
          >共同批次 {{ summary.sharedSourceBatchIds.length }}</Badge
        >
        <Badge variant="outline"
          >合计覆盖批次 {{ summary.coverage.batchCount }}</Badge
        >
      </section>

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
