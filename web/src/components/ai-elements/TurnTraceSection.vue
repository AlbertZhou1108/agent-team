<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useQueryClient } from '@tanstack/vue-query';
import { AlertTriangle, Check, CheckCircle2, CircleDot, Copy, LoaderCircle } from '@lucide/vue';
import { Disclosure } from '@/components/ui/disclosure';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import PanelState from '@/components/panel/PanelState.vue';
import { buildTurns, serverStatus } from '@/features/traces/reducer';
import { useTurnTraceQuery } from '@/features/queries';
import { queryKeys } from '@/features/query-keys';
import type { TurnSummary } from '@/shared/api/raw-types';
import type { TurnStatus } from '@/shared/models/view-types';
import TraceStepCard from './TraceStepCard.vue';

/**
 * 一个回合的折叠区块:摘要行常驻(状态/步数/源事件范围/失败单行预览),事件体在展开时才经
 * /api/turn 懒加载。失败回合展开后在顶部置顶高亮错误摘要卡，无需层层展开 JSON。
 */
const props = defineProps<{
  turn: TurnSummary;
  endpointId: string;
  highlighted?: boolean;
}>();

const open = ref(false);
const copied = ref(false);
let copyTimer: ReturnType<typeof setTimeout> | null = null;
const queryClient = useQueryClient();
const running = computed(() => props.turn.state === 'running');
const query = useTurnTraceQuery(() => props.turn.id, open, running);
const trace = computed(() => query.trace.value);

const status = computed<TurnStatus>(() => serverStatus(props.turn.state));
const statusMeta = computed(() => {
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
    hosts: { [props.endpointId]: trace.value.turn.host ?? 'unknown' },
    // 状态与事件数以回合摘要为准:事件按页返回,超长回合的结束事件可能不在已加载页里。
    turn: { state: props.turn.state, eventCount: props.turn.eventCount },
  });
  return view?.steps ?? [];
});

const pinnedErrorDetail = computed(() => {
  if (status.value !== 'error') return '';
  const explicitError = steps.value.find(
    (step) => step.kind === 'error' && Boolean(step.detail || step.summary),
  );
  if (explicitError) return explicitError.detail || explicitError.summary || '';
  if (props.turn.errorSummary) return props.turn.errorSummary;
  const fallback = steps.value.find(
    (step) => step.status === 'error' && Boolean(step.detail || step.summary),
  );
  return fallback?.detail || fallback?.summary || '';
});

async function copyError() {
  if (!pinnedErrorDetail.value) return;
  try {
    await navigator.clipboard?.writeText(pinnedErrorDetail.value);
    copied.value = true;
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copied.value = false; }, 1600);
  } catch {
    // 剪贴板不可用时静默忽略，不打断查看。
  }
}

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
  <div
    :id="`turn-row-${turn.id}`"
    class="min-w-0 py-1.5 transition-colors"
    :class="highlighted ? 'rounded-(--component-card-radius) bg-accent/40 px-2' : ''"
    :data-turn-ordinal="turn.ordinal"
    :data-turn-state="turn.state"
  >
    <!-- 状态徽章放在 summary 里:整行(标题+步数+状态)同属触发器,hover 高亮一致。 -->
    <Disclosure v-model:open="open">
      <template #summary>
        <span class="min-w-0 flex-1 truncate">第 {{ turn.ordinal }} 轮</span>
        <Badge variant="outline">{{ turn.eventCount }} 步</Badge>
        <Badge :variant="statusMeta.variant">
          <component :is="statusMeta.icon" :class="{ 'animate-spin': status === 'running' }" />
          {{ statusMeta.label }}
        </Badge>
      </template>

      <div class="mt-2 flex min-w-0 flex-col gap-2">
        <div
          v-if="status === 'error' && pinnedErrorDetail"
          class="flex flex-col gap-1.5 rounded-(--component-card-radius) border border-destructive/30 bg-destructive/10 p-3"
          data-testid="turn-pinned-error"
        >
          <div class="flex items-center justify-between gap-2">
            <span class="inline-flex items-center gap-1.5 text-xs font-medium text-destructive">
              <AlertTriangle class="size-3.5 shrink-0" aria-hidden="true" />
              错误摘要
            </span>
            <Button
              variant="ghost"
              size="xs"
              class="h-6 px-2 text-xs text-destructive hover:bg-destructive/15 hover:text-destructive"
              @click="copyError"
            >
              <Check v-if="copied" class="size-3" />
              <Copy v-else class="size-3" />
              {{ copied ? '已复制' : '复制' }}
            </Button>
          </div>
          <pre class="max-h-36 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-foreground">{{ pinnedErrorDetail }}</pre>
        </div>

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
        </template>
      </div>
    </Disclosure>

    <!-- 失败回合折叠态直接展示一行错误摘要，点击可展开该回合。 -->
    <button
      v-if="!open && status === 'error' && turn.errorSummary"
      type="button"
      class="mt-1 block w-full truncate pl-5 text-left font-mono text-xs text-destructive/90 hover:text-destructive"
      :title="turn.errorSummary"
      data-testid="turn-error-preview"
      @click="open = true"
    >
      {{ turn.errorSummary }}
    </button>
  </div>
</template>
