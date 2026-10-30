<script setup lang="ts">
import HelpPopover from '@/components/panel/HelpPopover.vue';
import { computed, ref } from 'vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LoaderCircle, UsersRound } from '@lucide/vue';
import PanelState from '@/components/panel/PanelState.vue';
import { useManagerConversationTelemetryQuery } from '@/features/queries';
import type { Member } from '@/shared/api/raw-types';
import TelemetryManagerSideCard from './TelemetryManagerSideCard.vue';
import TelemetryManagerBatchCard from './TelemetryManagerBatchCard.vue';
import { formatTimestamp } from './format';

const props = defineProps<{
  groupId: string;
  memberId: string;
  members: Member[];
}>();

const fromInput = ref('');
const toInput = ref('');
const limit = ref('20');

function toIso(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

const from = computed(() => toIso(fromInput.value));
const to = computed(() => toIso(toInput.value));

const query = useManagerConversationTelemetryQuery(
  () => props.groupId || undefined,
  () => props.memberId || undefined,
  {
    from: () => from.value,
    to: () => to.value,
    limit: () => Number(limit.value),
  },
);
const data = computed(() => query.firstPage.value);

const memberNames = computed<Record<string, string>>(() => {
  const names: Record<string, string> = {};
  for (const member of props.members) {
    if (!member.removed) names[member.id] = member.name;
  }
  if (data.value) {
    names[data.value.member.memberId] = data.value.member.name;
    names[data.value.manager.memberId] = data.value.manager.name;
  }
  return names;
});

const otherInvolvedNames = computed(() => {
  if (!data.value) return [];
  return data.value.managerSide.involvedMemberIds
    .filter(id => id !== data.value!.member.memberId)
    .map(id => memberNames.value[id] ?? id);
});

const managerBadges = computed(() => {
  if (!data.value) return [];
  const badges = [
    `独占 ${data.value.managerSide.exclusiveBatchIds.length}`,
    `共享 ${data.value.managerSide.sharedBatchIds.length}`,
  ];
  if (data.value.managerSide.involvedMemberIds.length > 1) {
    badges.push(`涉及其他成员 ${otherInvolvedNames.value.length}`);
  }
  return badges;
});

const errorMessage = computed(() => {
  const raw = query.error.value?.message;
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw) as { error?: string };
    return parsed.error ?? raw;
  } catch {
    return raw;
  }
});

async function loadMore() {
  await query.fetchNextPage();
}

function clearFilters() {
  fromInput.value = '';
  toInput.value = '';
  limit.value = '20';
}
</script>

<template>
  <div
    class="flex min-w-0 flex-col gap-4"
    data-manager-conversation
    :data-manager-member-id="memberId"
    :data-manager-manager-id="data?.manager.memberId ?? ''"
    :data-manager-readonly="data?.readOnly ?? true"
  >
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex flex-wrap items-center gap-1">
        <h3 class="text-sm font-semibold">成员 ↔ 主 Agent</h3>
        <Badge variant="outline">仅成员端</Badge>
        <Badge variant="secondary">成员侧 ≠ 管理者侧</Badge>
        <Badge variant="outline">管理者侧 ≠ 协调总量</Badge>
      </div>
      <span class="text-[11px] text-muted-foreground"
        >更新 {{ formatTimestamp(data?.generatedAt ?? null) }}</span
      >
    </div>

    <div class="flex items-center gap-1" data-manager-non-additive><p class="text-xs text-muted-foreground">成员侧与管理侧不可相加；管理侧不可与主 Agent 协调总量相加。</p><HelpPopover title="统计口径"><p>成员侧与管理侧并排展示，互不相加；管理者侧是相关性视图，不能与主 Agent 协调会话总量相加。本页不提供任何合计数字；共享批次整批展示一次、不拆分。</p></HelpPopover></div>

    <div class="grid gap-2 sm:grid-cols-2">
      <label class="flex flex-col gap-1 text-[11px] text-muted-foreground">
        开始时间（包含）
        <Input v-model="fromInput" type="datetime-local" data-manager-from />
      </label>
      <label class="flex flex-col gap-1 text-[11px] text-muted-foreground">
        结束时间（不包含）
        <Input v-model="toInput" type="datetime-local" data-manager-to />
      </label>
      <label class="flex flex-col gap-1 text-[11px] text-muted-foreground">
        每页批次数（1–100）
        <Input
          v-model="limit"
          type="number"
          min="1"
          max="100"
          step="1"
          inputmode="numeric"
          data-manager-limit
        />
      </label>
      <div class="flex items-end">
        <Button
          variant="outline"
          size="sm"
          class="w-full"
          data-manager-clear
          @click="clearFilters"
          >清除时间范围</Button
        >
      </div>
    </div>
    <p v-if="data" class="text-[11px] text-muted-foreground">
      范围：{{ formatTimestamp(data.range.from) }} 至
      {{ formatTimestamp(data.range.to) }}（结束不包含）
    </p>

    <PanelState
      v-if="query.isPending.value"
      loading
      title="正在读取成员 ↔ 主 Agent 遥测"
      description="等待服务端返回成员侧与管理者侧双栏数据。"
    />
    <Alert v-else-if="query.error.value" variant="destructive">
      <AlertDescription data-manager-error
        >读取成员 ↔ 主 Agent 遥测失败：{{ errorMessage }}</AlertDescription
      >
    </Alert>
    <template v-else-if="data">
      <div
        class="grid grid-cols-1 gap-3 lg:grid-cols-2"
        data-manager-columns
      >
        <TelemetryManagerSideCard
          side="member"
          title="成员执行（独占）"
          :executor="{
            kind: 'member',
            memberId: data.member.memberId,
            name: data.member.name,
            host: data.member.host,
          }"
          :totals="data.memberSide.totals"
          :context-reference="data.memberSide.contextReference"
          :coverage="data.memberSide.coverage"
          :batch-count="data.memberSide.batchCount"
          :physical-sessions="data.memberSide.physicalSessions"
          :badges="[`成员侧批次 ${data.memberSide.batchCount}`]"
          note="成员侧为 pair 批次的独占小计，可在本栏内部相加；不得与管理者侧、协调会话或成员概览的数值相加。"
        />
        <TelemetryManagerSideCard
          side="manager"
          title="主 Agent 执行（相关性）"
          :executor="data.manager"
          :totals="data.managerSide.involvementTotals"
          :context-reference="data.managerSide.contextReference"
          :coverage="data.managerSide.coverage"
          :batch-count="data.managerSide.batchCount"
          :physical-sessions="data.managerSide.physicalSessions"
          :badges="managerBadges"
          note="管理者侧包含输入发送者=该成员与输出收件人=该成员的相关批次；共享批次整批计一次，不能跨成员相加，也不能与协调会话总量相加。"
        />
      </div>

      <section class="flex min-w-0 flex-col gap-3" data-manager-batches>
        <div class="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          <Badge variant="outline">成员侧批次 {{ data.summary.memberBatchIds.length }}</Badge>
          <Badge variant="outline">管理者侧批次 {{ data.summary.managerBatchIds.length }}</Badge>
          <Badge variant="secondary">独占 {{ data.summary.exclusiveManagerBatchIds.length }}</Badge>
          <Badge variant="secondary">共享 {{ data.summary.sharedManagerBatchIds.length }}</Badge>
          <Badge variant="outline">共享批次整批展示</Badge>
        </div>
        <p class="text-[11px] text-muted-foreground">
          {{ data.summary.note }}
        </p>

        <PanelState
          v-if="!query.batches.value.length"
          :icon="UsersRound"
          title="暂无成员 ↔ 主 Agent 批次"
          description="成员侧 pair 批次与管理侧相关批次尚未产生遥测；缺失不补零，显示无观测。"
        />
        <TelemetryManagerBatchCard
          v-for="batch in query.batches.value"
          :key="batch.batchId"
          :batch="batch"
          :member-names="memberNames"
        />

        <Button
          v-if="query.hasNextPage.value"
          variant="outline"
          size="sm"
          class="w-full"
          :disabled="query.isFetchingNextPage.value"
          data-manager-load-more
          @click="loadMore"
        >
          <LoaderCircle
            v-if="query.isFetchingNextPage.value"
            class="animate-spin"
          />
          {{
            query.isFetchingNextPage.value ? '正在加载' : '加载更多批次'
          }}
        </Button>
      </section>
    </template>
  </div>
</template>
