<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useQueryClient } from '@tanstack/vue-query';
import { AlertTriangle, CheckCircle2, CircleDot, LoaderCircle } from '@lucide/vue';
import { Disclosure } from '@/components/ui/disclosure';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import PanelState from '@/components/panel/PanelState.vue';
import { buildTurns, serverStatus } from '@/features/traces/reducer';
import { useTurnTraceQuery } from '@/features/queries';
import { queryKeys } from '@/features/query-keys';
import type { TurnSummary } from '@/shared/api/raw-types';
import type { Host, TurnStatus } from '@/shared/models/view-types';
import TraceStepCard from './TraceStepCard.vue';

/**
 * 一个回合的折叠区块:摘要行常驻(状态/步数/源事件范围),事件体在展开时才经
 * /api/turn 懒加载。回合运行中且展开时快轮询,合上或结束即停。
 */
const props = defineProps<{
  turn: TurnSummary;
  endpointId: string;
}>();

const open = ref(false);
const queryClient = useQueryClient();
const running = computed(() => props.turn.state === 'running');
const query = useTurnTraceQuery(() => props.turn.id, open, running);
const trace = computed(() => query.trace.value);

const status = computed<TurnStatus>(() => serverStatus(props.turn.state));const statusMeta = computed(() => {
  if (status.value === 'running') return { label: '运行中', variant: 'secondary' as const, icon: LoaderCircle };
  if (status.value === 'completed') return { label: '已完成', variant: 'outline' as const, icon: CheckCircle2 };
  if (status.value === 'error') return { label: '失败', variant: 'destructive' as const, icon: AlertTriangle };
  if (status.value === 'cancelled') return { label: '已取消', variant: 'outline' as const, icon: CircleDot };
  if (status.value === 'stopped') return { label: '已停止', variant: 'outline' as const, icon: CircleDot };
  return { label: '状态未知', variant: 'outline' as const, icon: CircleDot };
});

const steps = computed(() => {
  if (!trace.value) return [];
  const [view] = buildTurns(query.events.value, {
    hosts: { [props.endpointId]: (trace.value.turn.host ?? 'unknown') as Host },
    // 状态与事件数以回合摘要为准:事件按页返回,超长回合的结束事件可能不在已加载页里。
    turn: { state: props.turn.state, eventCount: props.turn.eventCount },
  });
  return view?.steps ?? [];
});

// 轮询随运行中回合停止后,最后一次快照可能还差收尾事件;状态翻转时补一次失效。
watch(
  () => trace.value?.turn.state,
  (now, before) => {
    if (before === 'running' && now && now !== 'running') {
      void queryClient.invalidateQueries({ queryKey: queryKeys.turn(props.turn.id) });
    }
  },
);
</script>

<template>
  <!-- 状态徽章放在 summary 里:整行(标题+步数+状态)同属触发器,hover 高亮一致。 -->
  <Disclosure v-model:open="open">
    <template #summary>
      <span class="min-w-0 flex-1 truncate">回合 {{ turn.ordinal }}</span>
      <Badge variant="outline">{{ turn.eventCount }} 步</Badge>
      <Badge :variant="statusMeta.variant">
        <component :is="statusMeta.icon" :class="{ 'animate-spin': status === 'running' }" />
        {{ statusMeta.label }}
      </Badge>
    </template>
    <p class="text-xs text-muted-foreground">源事件 #{{ turn.firstSeq }}–#{{ turn.lastSeq }}</p>
    <PanelState
      v-if="open && query.isPending.value"
      loading
      title="正在读取回合事件"
    />
    <template v-else>
      <div class="flex min-w-0 flex-col">
        <TraceStepCard
          v-for="step in steps"
          :key="step.id"
          :step="step"
          data-record-row
        />
      </div>
      <PanelState
        v-if="trace && !steps.length"
        title="本回合没有可解析的步骤"
        description="事件已记录,但没有映射出执行步骤。"
      />
      <Button
        v-if="query.hasMore.value"
        variant="outline"
        size="sm"
        class="mt-2 w-full"
        :disabled="query.isFetching.value"
        @click="query.loadMore()"
      >
        <LoaderCircle v-if="query.isFetching.value" class="animate-spin" />
        {{ query.isFetching.value ? '正在加载' : '加载更多事件' }}
      </Button>
      <Disclosure>
        <template #summary>回合标识</template>
        <p class="mt-2 break-all font-mono">{{ turn.id }}</p>
      </Disclosure>
    </template>
  </Disclosure>
</template>
