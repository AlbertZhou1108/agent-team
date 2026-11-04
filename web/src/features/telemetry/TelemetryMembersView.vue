<script setup lang="ts">
import { Disclosure } from '@/components/ui/disclosure';
import { computed, ref, watch } from 'vue';
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


</script>

<template>
  <div class="flex min-w-0 flex-col gap-4">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex flex-wrap items-center gap-1">
        <h3 class="text-sm font-semibold">成员开销</h3>
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
      </TelemetryExecutorCard>
      </Disclosure>

      <TelemetrySourceSubtotals
        :subtotals="data.sourceAnalysis.actors"
        :merged-batch-ids="data.sourceAnalysis.mergedBatchIds"
        :shared-source-batch-ids="data.sourceAnalysis.sharedSourceBatchIds"
        :note="data.sourceAnalysis.note"
      />
    </template>
  </div>
</template>
