<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ArrowLeftRight, Bot } from '@lucide/vue';
import PanelState from '@/components/panel/PanelState.vue';
import { useConversationTelemetryQuery } from '@/features/queries';
import type { Member, SessionEndpoint } from '@/shared/api/raw-types';
import TelemetryExecutorCard from './TelemetryExecutorCard.vue';
import TelemetryBatchList from './TelemetryBatchList.vue';
import TelemetrySourceSubtotals from './TelemetrySourceSubtotals.vue';
import { formatTimestamp } from './format';
import { buildConversationPairs, isPairEndpoint } from './pairs';
import type { ConversationPair } from './pairs';

const props = defineProps<{
  groupId: string;
  members: Member[];
  endpoints: SessionEndpoint[];
  selectedEndpointId?: string;
}>();

const activeMemberIds = computed(
  () =>
    new Set(
      props.members
        .filter(
          member => !member.removed && member.group_id === props.groupId,
        )
        .map(member => member.id),
    ),
);

const pairs = computed(() => buildConversationPairs(props.members, props.endpoints));

const selectedKey = ref('');

function pairFromEndpoint(
  endpointId: string | undefined,
): ConversationPair | undefined {
  const endpoint = props.endpoints.find(item => item.id === endpointId);
  if (!endpoint?.peer || !isPairEndpoint(endpoint)) return undefined;
  const [first, second] = [endpoint.member_id, endpoint.peer].sort();
  return pairs.value.find(pair => pair.key === `${first}:${second}`);
}

const selectedEndpoint = computed(() => {
  const endpoint = props.endpoints.find(
    item => item.id === props.selectedEndpointId,
  );
  return endpoint && isPairEndpoint(endpoint) && endpoint.peer
    ? endpoint
    : undefined;
});

const selectedEndpointIsNonMemberPair = computed(() => {
  const endpoint = selectedEndpoint.value;
  if (!endpoint?.peer) return false;
  return !(
    activeMemberIds.value.has(endpoint.member_id) &&
    activeMemberIds.value.has(endpoint.peer)
  );
});

watch(
  [pairs, () => props.selectedEndpointId, selectedEndpointIsNonMemberPair],
  ([options, endpointId, nonMemberPair]) => {
    if (nonMemberPair) {
      selectedKey.value = '';
      return;
    }
    if (!options.length) {
      selectedKey.value = '';
      return;
    }
    const fromEndpoint = pairFromEndpoint(endpointId);
    if (fromEndpoint) {
      selectedKey.value = fromEndpoint.key;
      return;
    }
    if (!options.some(pair => pair.key === selectedKey.value)) {
      selectedKey.value = options[0]!.key;
    }
  },
  { immediate: true },
);

const selectedPair = computed(() =>
  pairs.value.find(pair => pair.key === selectedKey.value),
);
const participantName = computed(() =>
  selectedPair.value ? selectedPair.value.label : '双方会话',
);

const query = useConversationTelemetryQuery(
  () => props.groupId || undefined,
  () => selectedPair.value?.memberId,
  () => selectedPair.value?.peerId,
);
const data = computed(() => query.firstPage.value);
const summary = computed(() => data.value?.summary);

async function loadMore() {
  await query.fetchNextPage();
}
</script>

<template>
  <div class="flex min-w-0 flex-col gap-4">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex flex-wrap items-center gap-1">
        <h3 class="text-sm font-semibold">双方会话</h3>
        <Badge variant="outline">按执行方分开</Badge>
      </div>
      <span class="text-[11px] text-muted-foreground"
        >更新 {{ formatTimestamp(data?.generatedAt ?? null) }}</span
      >
    </div>

    <div v-if="pairs.length" class="flex min-w-0 flex-col gap-1">
      <label class="text-xs text-muted-foreground" for="telemetry-pair"
        >选择双人会话</label
      >
      <Select v-model="selectedKey">
        <SelectTrigger id="telemetry-pair" class="w-full" size="sm">
          <SelectValue :placeholder="participantName" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem
              v-for="pair in pairs"
              :key="pair.key"
              :value="pair.key"
              >{{ pair.label }}</SelectItem
            >
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>

    <p class="text-xs text-muted-foreground">
      双方执行归属消耗分开显示，互不合并；来源小计是触发来源分析视图，不能与执行归属总量相加。合并投递整批计入执行方一次。
    </p>

    <PanelState
      v-if="!selectedPair && selectedEndpointIsNonMemberPair"
      :icon="Bot"
      title="该会话对端不是群成员"
      description="该 pair 会话的对端是 Panel Agent 或已移除成员；双方会话遥测仅支持群成员之间。Panel Agent 的协调消耗请在主 Agent 协调会话中查看，成员汇总请查看成员概览。"
    />
    <PanelState
      v-else-if="!pairs.length"
      :icon="ArrowLeftRight"
      title="暂无双人会话"
      description="成员之间产生 pair 会话后，这里可查看双方各自的执行消耗。"
    />
    <PanelState
      v-else-if="query.isPending.value"
      loading
      title="正在读取双方会话遥测"
      description="等待服务端返回双方 executor 汇总与批次。"
    />
    <Alert v-else-if="query.error.value" variant="destructive">
      <AlertDescription
        >读取双方会话遥测失败：{{ query.error.value.message }}</AlertDescription
      >
    </Alert>
    <template v-else-if="data">
      <section class="flex min-w-0 flex-col gap-2">
        <h4 class="text-xs font-semibold">参与者</h4>
        <div class="flex flex-wrap gap-1">
          <Badge
            v-for="participant in data.conversation.participants"
            :key="participant.memberId"
            variant="outline"
            >{{ participant.name }} · {{ participant.host }}</Badge
          >
        </div>
      </section>

      <TelemetryExecutorCard
        v-for="entry in data.executors"
        :key="entry.executor.memberId"
        :executor="entry.executor"
        :totals="entry.totals"
        :context-reference="entry.contextReference"
        :physical-sessions="entry.physicalSessions"
        :batch-count="entry.batchCount"
        :coverage="entry.coverage"
      />

      <section class="flex flex-wrap items-center gap-1 text-xs">
        <Badge variant="outline"
          >单一来源 {{ summary?.singleSourceBatchIds.length ?? 0 }}</Badge
        >
        <Badge variant="outline"
          >合并投递 {{ summary?.mergedBatchIds.length ?? 0 }}</Badge
        >
        <Badge variant="default"
          >共同批次 {{ summary?.sharedSourceBatchIds.length ?? 0 }}</Badge
        >
      </section>

      <details class="text-xs text-muted-foreground">
        <summary class="w-fit cursor-pointer">来源归因与去重口径</summary>
        <div class="mt-3">
      <TelemetrySourceSubtotals
        v-if="summary"
        :subtotals="summary.sourceSubtotals"
        :merged-batch-ids="summary.mergedBatchIds"
        :shared-source-batch-ids="summary.sharedSourceBatchIds"
      />

        </div>
      </details>

      <TelemetryBatchList
        v-if="summary"
        :batches="query.batches.value"
        :shared-source-batch-ids="summary.sharedSourceBatchIds"
        :merged-batch-ids="summary.mergedBatchIds"
        :source-subtotals="summary.sourceSubtotals"
        :next-cursor="data.nextCursor"
        :fetching-next-page="query.isFetchingNextPage.value"
        empty-title="暂无双方会话批次"
        empty-description="该双人会话尚无宿主执行回合并上报指标。"
        @load-more="loadMore"
      />
    </template>
  </div>
</template>
