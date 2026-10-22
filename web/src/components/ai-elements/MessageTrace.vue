<script setup lang="ts">
import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { Clock3, LoaderCircle } from '@lucide/vue';
import { api } from '@/shared/api/client';
import { buildTurns } from '@/features/traces/reducer';
import TraceTimeline from './TraceTimeline.vue';

type Host = 'codex' | 'claude' | 'dsh' | 'unknown';

const props = defineProps<{
  messageId: string;
  hosts: Record<string, string>;
}>();

const traceQuery = useQuery({
  queryKey: computed(() => ['message-trace', props.messageId] as const),
  queryFn: ({ signal }) => api.messageTrace(props.messageId, signal),
  staleTime: 10_000,
  retry: 0,
});

const turnId = computed(() => (
  traceQuery.data.value?.source.kind === 'group'
    ? traceQuery.data.value.source.turnId
    : undefined
));

const turnQuery = useQuery({
  queryKey: computed(() => ['turn', turnId.value] as const),
  queryFn: ({ signal }) => api.turn(turnId.value!, 0, signal),
  enabled: computed(() => Boolean(turnId.value)),
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
    ...trace.events.map(event => new Date(event.created).getTime()),
  );
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
});

const stepCount = computed(() => turns.value.reduce((total, turn) => total + turn.steps.length, 0));
</script>

<template>
  <div
    v-if="turnId"
    class="inline-trace"
  >
    <div v-if="turnQuery.isPending.value" class="inline-trace-loading">
      <LoaderCircle :size="12" class="animate-spin" />
      正在读取执行轨迹
    </div>
    <details v-else-if="turns.length">
      <summary>
        <Clock3 :size="12" />
        <span>执行轨迹</span>
        <span v-if="duration" class="text-dim">用时 {{ duration }}</span>
        <span class="text-dim">· {{ stepCount }} 步</span>
      </summary>
      <div class="inline-trace-content">
        <TraceTimeline :turns="turns" />
      </div>
    </details>
  </div>
</template>
