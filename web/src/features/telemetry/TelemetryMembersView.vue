<script setup lang="ts">
import { Disclosure } from '@/components/ui/disclosure';
import { computed, ref, watch } from 'vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Users } from '@lucide/vue';
import HelpPopover from '@/components/panel/HelpPopover.vue';
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
const detailsOpen = ref(false);
watch(() => props.groupId, () => { selectedId.value = ''; detailsOpen.value = false; });
function selectMember(id: string) {
  selectedId.value = id;
  detailsOpen.value = true;
}
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
        <HelpPopover title="消耗统计口径"><p>按已观测 Token 汇总，不同宿主的采集范围可能不同；未采集显示为“未采集”。</p></HelpPopover>

      </div>
      <span class="text-2xs text-muted-foreground"
        >更新 {{ formatTimestamp(data?.generatedAt ?? null) }}</span
      >
    </div>

    <PanelState
      v-if="query.isPending.value"
      loading
      title="正在读取成员遥测"
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
    />
    <template v-else>
      <TelemetryMemberComparison :members="data.members" :selected-id="selectedMember?.executor.memberId" @select="selectMember" />
      <Disclosure v-if="selectedMember" v-model:open="detailsOpen">
        <template #summary>{{ selectedMember.executor.name }} · 执行详情</template>
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
          <div class="flex flex-wrap items-center gap-1 text-2xs">
            <Badge variant="outline">{{ capabilitySummary(selectedMember.executor.host) }}</Badge>
          </div>
        </template>
      </TelemetryExecutorCard>
      </Disclosure>

      <Disclosure>
        <template #summary>来源归因与去重口径</template>
        <div class="mt-3">
      <TelemetrySourceSubtotals
        :subtotals="data.sourceAnalysis.actors"
        :merged-batch-ids="data.sourceAnalysis.mergedBatchIds"
        :shared-source-batch-ids="data.sourceAnalysis.sharedSourceBatchIds"
        :note="data.sourceAnalysis.note"
      />

        </div>
      </Disclosure>

      <Disclosure>
        <template #summary>
          宿主采集能力
        </template>
        <div class="mt-3">
          <TelemetryCapabilitiesView :group-id="groupId" />
        </div>
      </Disclosure>
    </template>
  </div>
</template>
