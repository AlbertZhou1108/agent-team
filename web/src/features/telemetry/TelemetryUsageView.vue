<script setup lang="ts">
import { computed } from 'vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Gauge } from '@lucide/vue';
import PanelState from '@/components/panel/PanelState.vue';
import {
  useConversationTelemetryQuery,
  useCoordinationTelemetryQuery,
  useManagerConversationTelemetryQuery,
} from '@/features/queries';
import TelemetryMetricGrid from './TelemetryMetricGrid.vue';
import { formatTimestamp, sumCoverage, sumMetrics } from './format';
import type { TelemetryCoverage, TelemetryMetrics } from '@/shared/api/raw-types';

/**
 * 详情-用量的唯一视图:只给该会话的总量指标与覆盖说明。
 * 批次、时间筛选、物理 session 等观测细节都已收敛——按人的开销在成员页,
 * 采集细节在其折叠区,这里不再重复。
 */
const props = defineProps<{
  groupId: string;
  kind: 'manager-pair' | 'pair' | 'coordination';
  memberId?: string;
  peerId?: string;
}>();

const pairQuery = useConversationTelemetryQuery(
  () => props.groupId,
  () => props.memberId,
  () => props.peerId,
  () => props.kind === 'pair',
);
const managerQuery = useManagerConversationTelemetryQuery(
  () => props.groupId,
  () => props.memberId,
  () => props.kind === 'manager-pair',
);
const coordinationQuery = useCoordinationTelemetryQuery(
  () => props.groupId,
  () => props.kind === 'coordination',
);

const pending = computed(() => {
  if (props.kind === 'pair') return pairQuery.isPending.value;
  if (props.kind === 'manager-pair') return managerQuery.isPending.value;
  return coordinationQuery.isPending.value;
});
const error = computed(() => {
  if (props.kind === 'pair') return pairQuery.error.value;
  if (props.kind === 'manager-pair') return managerQuery.error.value;
  return coordinationQuery.error.value;
});
const errorMessage = computed(() => {
  const raw = error.value?.message;
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw) as { error?: string };
    return parsed.error ?? raw;
  } catch {
    return raw;
  }
});
const generatedAt = computed(() => {
  if (props.kind === 'pair') return pairQuery.data.value?.generatedAt ?? null;
  if (props.kind === 'manager-pair') return managerQuery.data.value?.generatedAt ?? null;
  return coordinationQuery.data.value?.generatedAt ?? null;
});

const totals = computed<TelemetryMetrics | null>(() => {
  if (props.kind === 'pair') {
    const executors = pairQuery.data.value?.executors ?? [];
    return sumMetrics(executors.map(entry => entry.totals));
  }
  if (props.kind === 'manager-pair') {
    const data = managerQuery.data.value;
    if (!data) return null;
    return sumMetrics([data.memberSide.totals, data.managerSide.involvementTotals]);
  }
  return coordinationQuery.data.value?.summary.executorTotals ?? null;
});

const coverage = computed<TelemetryCoverage | null>(() => {
  if (props.kind === 'pair') return pairQuery.data.value?.summary.coverage ?? null;
  if (props.kind === 'manager-pair') {
    const data = managerQuery.data.value;
    return data ? sumCoverage([data.memberSide.coverage, data.managerSide.coverage]) : null;
  }
  return coordinationQuery.data.value?.summary.coverage ?? null;
});
</script>

<template>
  <div class="flex min-w-0 flex-col gap-4" data-testid="telemetry-usage-view">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h3 class="text-sm font-semibold">用量</h3>
      <span class="text-2xs text-muted-foreground"
        >更新 {{ formatTimestamp(generatedAt) }}</span
      >
    </div>

    <PanelState v-if="pending" loading title="正在读取用量" />
    <Alert v-else-if="error" variant="destructive">
      <AlertDescription>读取用量失败：{{ errorMessage }}</AlertDescription>
    </Alert>
    <PanelState
      v-else-if="!totals"
      :icon="Gauge"
      title="暂无用量观测"
      description="会话执行并上报指标后显示。"
    />
    <template v-else>
      <p
        v-if="kind === 'manager-pair'"
        class="text-xs text-muted-foreground"
      >
        成员侧独占执行与主 Agent 侧相关执行已合并计入下方总量。
      </p>
      <TelemetryMetricGrid :metrics="totals" />
      <div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>已记录 {{ coverage?.batchCount ?? 0 }} 个回合</span>
        <Badge v-if="coverage && !coverage.complete" variant="outline">部分采集</Badge>
      </div>
    </template>
  </div>
</template>
