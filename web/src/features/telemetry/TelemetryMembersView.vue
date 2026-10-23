<script setup lang="ts">
import { computed, ref } from 'vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Users } from '@lucide/vue';
import PanelState from '@/components/panel/PanelState.vue';
import {
  useMembersTelemetryQuery,
  useTelemetryCapabilitiesQuery,
} from '@/features/queries';
import TelemetryMemberComparison from './TelemetryMemberComparison.vue';
import TelemetryExecutorCard from './TelemetryExecutorCard.vue';
import TelemetrySourceSubtotals from './TelemetrySourceSubtotals.vue';
import TelemetryCapabilitiesView from './TelemetryCapabilitiesView.vue';
import { numeric } from './visuals';
import { formatTimestamp } from './format';

const props = defineProps<{ groupId: string }>();

const query = useMembersTelemetryQuery(() => props.groupId || undefined);
const capabilitiesQuery = useTelemetryCapabilitiesQuery(
  () => props.groupId || undefined,
);

const data = computed(() => query.data.value);
const selectedId = ref('');
const selectedMember = computed(() => data.value?.members.find(m => m.executor.memberId === selectedId.value)
  ?? [...(data.value?.members ?? [])].sort((a, b) => (numeric(b.totals.totalTokens) ?? -1) - (numeric(a.totals.totalTokens) ?? -1))[0]);
const hosts = computed(() => capabilitiesQuery.data.value?.hosts ?? []);

function capabilitySummary(host: string): string {
  const entry = hosts.value.find(item => item.host === host);
  if (!entry) return '能力声明未返回';
  const values = Object.values(entry.metrics);
  const direct = values.filter(metric => metric.capability === 'direct').length;
  const derived = values.filter(
    metric => metric.capability === 'derived',
  ).length;
  const unsupported = values.filter(
    metric => metric.capability === 'unsupported',
  ).length;
  return `能力：直接 ${direct} · 派生 ${derived} · 不支持 ${unsupported}`;
}

</script>

<template>
  <div class="flex min-w-0 flex-col gap-4">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex flex-wrap items-center gap-1">
        <h3 class="text-sm font-semibold">成员开销</h3>

      </div>
      <span class="text-[11px] text-muted-foreground"
        >更新 {{ formatTimestamp(data?.generatedAt ?? null) }}</span
      >
    </div>
    <p class="text-xs text-muted-foreground">先看消耗分布，再展开成员详情。未采集的数据不补零。</p>

    <PanelState
      v-if="query.isPending.value"
      loading
      title="正在读取成员遥测"
      description="等待服务端返回 executor 汇总。"
    />
    <Alert v-else-if="query.error.value" variant="destructive">
      <AlertDescription
        >读取成员遥测失败：{{ query.error.value.message }}</AlertDescription
      >
    </Alert>
    <PanelState
      v-else-if="!data?.members.length"
      :icon="Users"
      title="暂无成员遥测"
      description="成员执行任务后，这里会按执行归属显示消耗；没有数据时不显示为 0。"
    />
    <template v-else>
      <TelemetryMemberComparison :members="data.members" :selected-id="selectedMember?.executor.memberId" @select="selectedId = $event" />
      <TelemetryExecutorCard
        v-if="selectedMember"
        :key="selectedMember.executor.memberId"
        :executor="selectedMember.executor"
        :totals="selectedMember.totals"
        :context-reference="selectedMember.contextReference"
        :physical-sessions="selectedMember.physicalSessions"
        :batch-count="selectedMember.batchCount"
        :coverage="selectedMember.coverage"
      >
        <template #footer>
          <div class="flex flex-wrap items-center gap-1 text-[11px]">
            <Badge variant="outline">{{ capabilitySummary(selectedMember.executor.host) }}</Badge>
          </div>
        </template>
      </TelemetryExecutorCard>

      <details class="text-xs text-muted-foreground">
        <summary class="w-fit cursor-pointer">来源归因与去重口径</summary>
        <div class="mt-3">
      <TelemetrySourceSubtotals
        :subtotals="data.sourceAnalysis.actors"
        :merged-batch-ids="data.sourceAnalysis.mergedBatchIds"
        :shared-source-batch-ids="data.sourceAnalysis.sharedSourceBatchIds"
        :note="data.sourceAnalysis.note"
      />

        </div>
      </details>

      <details class="rounded-lg border p-3 text-xs">
        <summary class="w-fit cursor-pointer font-medium">
          宿主采集能力
        </summary>
        <div class="mt-3">
          <TelemetryCapabilitiesView :group-id="groupId" />
        </div>
      </details>
    </template>
  </div>
</template>
