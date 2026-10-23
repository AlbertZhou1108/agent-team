<script setup lang="ts">
import { computed } from 'vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Users } from '@lucide/vue';
import PanelState from '@/components/panel/PanelState.vue';
import {
  useMembersTelemetryQuery,
  useTelemetryCapabilitiesQuery,
} from '@/features/queries';
import TelemetryExecutorCard from './TelemetryExecutorCard.vue';
import TelemetrySourceSubtotals from './TelemetrySourceSubtotals.vue';
import TelemetryCapabilitiesView from './TelemetryCapabilitiesView.vue';
import { formatTimestamp } from './format';

const props = defineProps<{ groupId: string }>();

const query = useMembersTelemetryQuery(() => props.groupId || undefined);
const capabilitiesQuery = useTelemetryCapabilitiesQuery(
  () => props.groupId || undefined,
);

const data = computed(() => query.data.value);
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
        <h3 class="text-sm font-semibold">群成员概览</h3>
        <Badge variant="outline">按执行归属</Badge>
        <Badge variant="outline">只读</Badge>
      </div>
      <span class="text-[11px] text-muted-foreground"
        >更新 {{ formatTimestamp(data?.generatedAt ?? null) }}</span
      >
    </div>
    <p class="text-xs text-muted-foreground">
      按实际执行宿主回合的成员汇总，不按消息发送者；缺失指标显示“—”与缺失原因，不补零。物理
      session 累计与批次指标是同一消耗的不同视图，禁止相加。
    </p>

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
      <TelemetryExecutorCard
        v-for="member in data.members"
        :key="member.executor.memberId"
        :executor="member.executor"
        :totals="member.totals"
        :context-reference="member.contextReference"
        :physical-sessions="member.physicalSessions"
        :batch-count="member.batchCount"
        :coverage="member.coverage"
      >
        <template #footer>
          <div class="flex flex-wrap items-center gap-1 text-[11px]">
            <Badge variant="outline">{{ capabilitySummary(member.executor.host) }}</Badge>
          </div>
        </template>
      </TelemetryExecutorCard>

      <TelemetrySourceSubtotals
        :subtotals="data.sourceAnalysis.actors"
        :merged-batch-ids="data.sourceAnalysis.mergedBatchIds"
        :shared-source-batch-ids="data.sourceAnalysis.sharedSourceBatchIds"
        :note="data.sourceAnalysis.note"
      />

      <details class="rounded-lg border p-3 text-xs">
        <summary class="w-fit cursor-pointer font-medium">
          宿主能力明细（direct / derived / unsupported）
        </summary>
        <div class="mt-3">
          <TelemetryCapabilitiesView :group-id="groupId" />
        </div>
      </details>
    </template>
  </div>
</template>
