<script setup lang="ts">
import { computed, watch } from 'vue';
import { AlertTriangle, CircleDot, LoaderCircle } from '@lucide/vue';
import PanelState from '@/components/panel/PanelState.vue';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Disclosure } from '@/components/ui/disclosure';
import { buildTurns } from '@/features/traces/reducer';
import { useMessageTraceQuery } from '@/features/messages/trace-query';
import type { TurnStatus } from '@/shared/models/view-types';
import TraceStepCard from './TraceStepCard.vue';

/**
 * 气泡上方的行内执行轨迹（无外框折叠列表，先轨迹、后正文）。
 * 开关归外层触发条（见 MessageFeed），收起时零占位，展开才按消息段拉取事件并铺开步骤。
 */
const props = defineProps<{
  messageId: string;
  hosts: Record<string, string>;
  expanded: boolean;
  /** 轨迹跟随消息气泡的一侧:用户的提问在右,其他人的发言在左。 */
  align?: 'start' | 'end';
  /**
   * 归属标注。群发指令下同一次下发有多条轨迹堆叠,头部带上接收者,
   * 否则分不清哪段是谁的产出。
   */
  label?: string;
}>();

const emit = defineEmits<{
  summary: [text: string];
}>();

// 一条消息对应一段事件:后端按该消息的 call_id 切好段,不需要再拉整轮事件。
const traceQuery = useMessageTraceQuery(() => props.messageId, () => props.expanded);

const segment = computed(() => traceQuery.data.value?.segment ?? null);
const turn = computed(() => traceQuery.data.value?.turn ?? null);

const turns = computed(() => {
  if (!segment.value) return [];
  const endpointId = turn.value?.endpoint_id ?? '';
  // 宿主以回合自身为准:会话列表是右侧栏按需加载的,拿不到时会把全部事件
  // 判成 unknown 而退化成"未识别事件"。props.hosts 只在服务端缺失时兜底。
  const host = turn.value?.host ?? props.hosts[endpointId] ?? 'unknown';
  return buildTurns(segment.value.events, {
    hosts: { [endpointId]: host },
    // 段只覆盖这条消息的产出过程,不含回合结束事件;状态取服务端记录。
    turn: { state: turn.value?.state },
  });
});

// 行内轨迹永远是单条消息的一段,只取第一个回合。
const trace = computed(() => turns.value[0] ?? null);

const statusLabels: Record<TurnStatus, string> = {
  running: '运行中',
  completed: '已完成',
  error: '失败',
  cancelled: '已取消',
  stopped: '已停止',
  unknown: '状态未知',
};

// 用时是「这条消息从开始处理到发出」:段内首尾事件时间。没有段时退回回合跨度。
const duration = computed(() => {
  if (!traceQuery.data.value) return '';
  const events = segment.value?.events ?? [];
  const start = events.length
    ? new Date(events[0]!.created).getTime()
    : turn.value ? new Date(turn.value.created).getTime() : null;
  const end = events.length
    ? new Date(events[events.length - 1]!.created).getTime()
    : turn.value?.ended ? new Date(turn.value.ended).getTime() : null;
  if (start === null || end === null) return '';
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
});

const summaryText = computed(() => {
  if (!trace.value) return '';
  const timePart = duration.value ? `用时 ${duration.value} · ` : '';
  return `${timePart}${trace.value.steps.length} 步 · ${statusLabels[trace.value.status]}`;
});

watch(
  summaryText,
  (value) => {
    if (value) emit('summary', value);
  },
  { immediate: true },
);
</script>

<template>
  <div
    v-if="expanded"
    class="inline-trace"
    :class="align === 'end' && 'inline-trace--end'"
  >
    <PanelState v-if="traceQuery.isPending.value" loading title="正在读取执行轨迹" />
    <PanelState v-else-if="traceQuery.isError.value" title="轨迹加载失败">
      <Button variant="outline" size="sm" @click="traceQuery.refetch()">重试</Button>
    </PanelState>
    <PanelState v-else-if="!trace" title="此消息没有可用的执行轨迹" />
    <div v-else class="inline-trace-content flex min-w-0 flex-col gap-0.5 border-l border-border/70 pl-3">
      <div v-if="label || trace.status !== 'completed'" class="flex items-center gap-2 pb-1">
        <span v-if="label" class="min-w-0 flex-1 text-xs tabular-nums text-muted-foreground">
          {{ label }} · {{ summaryText }}
        </span>
        <Badge
          v-if="trace.status !== 'completed'"
          :variant="
            trace.status === 'error'
              ? 'destructive'
              : trace.status === 'running'
                ? 'secondary'
                : 'outline'
          "
        >
          <LoaderCircle
            v-if="trace.status === 'running'"
            class="animate-spin"
          /><AlertTriangle v-else-if="trace.status === 'error'" /><CircleDot
            v-else
          />
          {{ statusLabels[trace.status] }}
        </Badge>
      </div>
      <div class="flex min-w-0 flex-col">
        <TraceStepCard
          v-for="step in trace.steps"
          :key="step.id"
          :step="step"
          data-record-row
        />
      </div>
      <Disclosure v-if="trace.id !== 'unknown'" class="trace-step">
        <template #summary>
          <span class="text-xs text-muted-foreground">回合标识</span>
        </template>
        <p class="mt-1 break-all pl-5 font-mono text-xs text-muted-foreground">{{ trace.id }}</p>
      </Disclosure>
    </div>
  </div>
</template>
