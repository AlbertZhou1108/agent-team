<script setup lang="ts">
import { computed } from 'vue';
import { LoaderCircle } from '@lucide/vue';
import { Disclosure } from '@/components/ui/disclosure';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import PanelState from '@/components/panel/PanelState.vue';
import { buildTurns } from '@/features/traces/reducer';
import type { HistoryRow, TurnSummary } from '@/shared/api/raw-types';
import type { Host } from '@/shared/models/view-types';
import TurnTraceSection from './TurnTraceSection.vue';
import TraceStepCard from './TraceStepCard.vue';

/**
 * 执行轨迹:按回合分页,正序(旧→新)展示,全部默认收起。
 * 首屏从第一回合开始;「加载更多回合」取靠后的回合,按钮在列表末尾。
 */
const props = defineProps<{
  turns: TurnSummary[];
  unaffiliated: HistoryRow[];
  endpointId?: string;
  /** 游离事件解释宿主 schema 用;回合自身的事件由回合区块按 /api/turn 的 host 解释。 */
  host?: string;
  loading?: boolean;
  hasNextPage?: boolean;
  fetchingNextPage?: boolean;
}>();

const emit = defineEmits<{ loadMore: [] }>();

const unaffiliatedSteps = computed(() => {
  if (!props.unaffiliated.length || !props.endpointId) return [];
  const [view] = buildTurns(props.unaffiliated, {
    hosts: { [props.endpointId]: (props.host ?? 'unknown') as Host },
  });
  return view?.steps ?? [];
});
</script>

<template>
  <div class="flex min-w-0 flex-col gap-3">
    <PanelState
      v-if="!turns.length && !loading"
      title="暂无执行轨迹"
      description="会话开始执行后，回合会显示在这里。"
    />
    <TurnTraceSection
      v-for="turn in turns"
      :key="turn.id"
      :turn="turn"
      :endpoint-id="endpointId ?? ''"
    />
    <Button
      v-if="hasNextPage"
      variant="outline"
      size="sm"
      :disabled="fetchingNextPage"
      @click="emit('loadMore')"
    >
      <LoaderCircle v-if="fetchingNextPage" class="animate-spin" />
      {{ fetchingNextPage ? '正在加载' : '加载更多回合' }}
    </Button>
    <Disclosure v-if="unaffiliatedSteps.length">
      <template #summary>
        <span class="min-w-0 flex-1 truncate">未关联回合</span>
        <Badge variant="outline">{{ unaffiliated.length }} 条</Badge>
      </template>
      <p class="text-xs text-muted-foreground">以下事件不属于任何回合（如宿主会话轮换）。</p>
      <div class="flex min-w-0 flex-col">
        <TraceStepCard
          v-for="step in unaffiliatedSteps"
          :key="step.id"
          :step="step"
          data-record-row
        />
      </div>
    </Disclosure>
  </div>
</template>
