<script setup lang="ts">
import { Disclosure } from '@/components/ui/disclosure';
import { computed, ref } from 'vue';
import { Clock3, AlertTriangle, CheckCircle2, CircleDot, LoaderCircle } from '@lucide/vue';
import PanelState from '@/components/panel/PanelState.vue';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { buildTurns } from '@/features/traces/reducer';
import { useMessageTraceQuery } from '@/features/messages/trace-query';
import type { TurnStatus } from '@/shared/models/view-types';
import TraceStepCard from './TraceStepCard.vue';

type Host = 'codex' | 'claude' | 'dsh' | 'unknown';

const props = defineProps<{
  messageId: string;
  hosts: Record<string, string>;
}>();

const expanded = ref(false);
// 一条消息对应一段事件:后端按该消息的 call_id 切好段,不需要再拉整轮事件。
const traceQuery = useMessageTraceQuery(() => props.messageId, expanded);

const segment = computed(() => traceQuery.data.value?.segment ?? null);
const turn = computed(() => traceQuery.data.value?.turn ?? null);

const turns = computed(() => {
  if (!segment.value) return [];
  const endpointId = turn.value?.endpoint_id ?? '';
  // 宿主以回合自身为准:会话列表是右侧栏按需加载的,拿不到时会把全部事件
  // 判成 unknown 而退化成"未识别事件"。props.hosts 只在服务端缺失时兜底。
  const host = (turn.value?.host ?? props.hosts[endpointId] ?? 'unknown') as Host;
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
</script>

<template>
  <Disclosure class="inline-trace" @update:open="expanded = $event">
    <template #summary><Clock3 class="size-3.5" />执行轨迹</template>
    <template v-if="expanded">
      <PanelState v-if="traceQuery.isPending.value" loading title="正在读取执行轨迹" />
      <PanelState v-else-if="traceQuery.isError.value" title="轨迹加载失败">
        <Button variant="outline" size="sm" @click="traceQuery.refetch()">重试</Button>
      </PanelState>
      <PanelState v-else-if="!trace" title="此消息没有可用的执行轨迹" />
      <!-- 一张卡片承载整条轨迹:用时、步数与状态都在卡片头部,步骤直接铺开。
           行内轨迹只含一条消息的一段,所以不需要「本回合」这类区分标签,
           也不再套一层可折叠容器。 -->
      <Card v-else size="compact" class="inline-trace-content mt-2">
        <CardContent class="flex min-w-0 flex-col gap-1">
          <div class="message-head gap-2">
            <span class="min-w-0 flex-1 text-xs tabular-nums text-muted-foreground">
              用时 {{ duration }} · {{ trace.steps.length }} 步
            </span>
            <Badge
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
              /><CheckCircle2
                v-else-if="trace.status === 'completed'"
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
          <Disclosure v-if="trace.id !== 'unknown'">
            <template #summary>回合标识</template>
            <p class="mt-2 break-all font-mono">{{ trace.id }}</p>
          </Disclosure>
        </CardContent>
      </Card>
    </template>
  </Disclosure>
</template>
