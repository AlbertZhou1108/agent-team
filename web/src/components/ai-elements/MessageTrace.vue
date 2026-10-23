<script setup lang="ts">
import { computed, ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { Clock3 } from '@lucide/vue';
import PanelState from '@/components/panel/PanelState.vue';
import { Button } from '@/components/ui/button';
import { api } from '@/shared/api/client';
import { buildTurns } from '@/features/traces/reducer';
import TraceTimeline from './TraceTimeline.vue';

type Host = 'codex' | 'claude' | 'dsh' | 'unknown';

const props = defineProps<{
  messageId: string;
  hosts: Record<string, string>;
}>();

const expanded = ref(false);
const traceQuery = useQuery({
  queryKey: computed(() => ['message-trace', props.messageId] as const),
  queryFn: ({ signal }) => api.messageTrace(props.messageId, signal),
  enabled: expanded,
  staleTime: 60_000,
  retry: 0,
});

const turnId = computed(() =>
  traceQuery.data.value?.source.kind === 'group'
    ? traceQuery.data.value.source.turnId
    : undefined,
);

const turnQuery = useQuery({
  queryKey: computed(() => ['turn', turnId.value] as const),
  queryFn: ({ signal }) => api.turn(turnId.value!, 0, signal),
  enabled: computed(() => expanded.value && Boolean(turnId.value)),
  staleTime: 10_000,
  retry: 0,
});

const turns = computed(() => {
  const trace = turnQuery.data.value;
  if (!trace) return [];
  const host = (props.hosts[trace.turn.endpoint_id] ?? 'unknown') as Host;
  return buildTurns(trace.events, {
    hosts: { [trace.turn.endpoint_id]: host },
  });
});

const duration = computed(() => {
  const trace = turnQuery.data.value;
  if (!trace) return '';
  const start = new Date(trace.turn.created).getTime();
  const end = Math.max(
    start,
    ...trace.events.map((event) => new Date(event.created).getTime()),
  );
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
});

const stepCount = computed(() =>
  turns.value.reduce((total, turn) => total + turn.steps.length, 0),
);
</script>

<template>
  <details class="inline-trace text-xs text-muted-foreground" @toggle="expanded = ($event.target as HTMLDetailsElement).open">
    <summary><Clock3 class="size-3.5" />执行轨迹</summary>
    <template v-if="expanded">
      <PanelState v-if="traceQuery.isPending.value || (turnId && turnQuery.isPending.value)" loading title="正在读取执行轨迹" />
      <PanelState v-else-if="traceQuery.isError.value || turnQuery.isError.value" title="轨迹加载失败">
        <Button variant="outline" size="sm" @click="traceQuery.refetch(); turnId && turnQuery.refetch()">重试</Button>
      </PanelState>
      <div v-else-if="turns.length" class="inline-trace-content">
        <p>用时 {{ duration }} · {{ stepCount }} 步</p>
        <TraceTimeline :turns="turns" />
      </div>
      <p v-else>暂无执行轨迹</p>
    </template>
  </details>
</template>
