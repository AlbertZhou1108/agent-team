import {
  computed,
  onBeforeUnmount,
  ref,
  watch,
  type MaybeRefOrGetter,
  toValue,
} from 'vue';
import { openEventStream, type EventStreamHandle } from '@/features/streams/use-event-stream';
import type { MessageRow, TeamStream } from '@/shared/api/raw-types';

export type TeamStreamEvent = {
  type:
    | 'snapshot'
    | 'start'
    | 'delta'
    | 'reasoning-delta'
    | 'phase'
    | 'complete'
    | 'cancelled'
    | 'error';
  stream?: TeamStream;
  streams?: TeamStream[];
  delta?: string;
  replace?: boolean;
};

export type TeamStreamingState = Record<string, TeamStream>;

/**
 * 团队流纯状态迁移（行为与原页面内联实现一致）：
 * - snapshot 重建当前团队的全部在飞流；
 * - delta / reasoning-delta 累积正文与思考，阶段事件保留已累积内容；
 * - complete 标记终态；cancelled / error 丢弃。
 * 刷新消息、落库后清理等副作用由 `useTeamStream` 负责，方便单测 reducer。
 */
export function reduceTeamStream(
  state: TeamStreamingState,
  event: TeamStreamEvent,
  groupId: string,
): TeamStreamingState {
  if (event.type === 'snapshot') {
    return Object.fromEntries(
      (event.streams ?? [])
        .filter((stream) => stream.groupId === groupId)
        .map((stream) => [stream.id, stream]),
    );
  }
  const stream = event.stream;
  if (!stream || stream.groupId !== groupId) return state;
  const current = state[stream.id];
  if (event.type === 'delta' && typeof event.delta === 'string') {
    return {
      ...state,
      [stream.id]: {
        ...stream,
        text: event.replace ? event.delta : (current?.text ?? '') + event.delta,
      },
    };
  }
  if (event.type === 'reasoning-delta' && typeof event.delta === 'string') {
    return {
      ...state,
      [stream.id]: {
        ...stream,
        text: current?.text ?? '',
        reasoning: (current?.reasoning ?? '') + event.delta,
      },
    };
  }
  if (event.type === 'phase') {
    return {
      ...state,
      [stream.id]: {
        ...stream,
        text: current?.text ?? '',
        reasoning: current?.reasoning ?? '',
      },
    };
  }
  if (event.type === 'cancelled' || event.type === 'error') {
    if (!current) return state;
    const next = { ...state };
    delete next[stream.id];
    return next;
  }
  if (event.type === 'complete') {
    return { ...state, [stream.id]: { ...stream, phase: 'complete' } };
  }
  return { ...state, [stream.id]: stream };
}

export type UseTeamStreamOptions = {
  groupId: MaybeRefOrGetter<string | undefined>;
  /** 已加载消息行：完成态在消息落库后从在飞列表移除。 */
  rows: () => MessageRow[];
  refetch: () => Promise<unknown>;
  schedule?: (run: () => void) => number;
  cancel?: (id: number) => void;
};

/**
 * 团队流（`/api/teams/:id/events`）：独立 URL，每次切换团队重建连接。
 * 批帧、解析、关闭都交给统一流层；这里只保留团队特有的状态迁移与失效。
 */
export function useTeamStream(options: UseTeamStreamOptions) {
  const streaming = ref<TeamStreamingState>({});
  let source: EventStreamHandle | null = null;

  function remove(id: string) {
    if (!(id in streaming.value)) return;
    const next = { ...streaming.value };
    delete next[id];
    streaming.value = next;
  }

  function accept(event: TeamStreamEvent) {
    const next = reduceTeamStream(
      streaming.value,
      event,
      toValue(options.groupId) ?? '',
    );
    if (next !== streaming.value) streaming.value = next;
    if (event.type === 'cancelled' || event.type === 'error') {
      void options.refetch();
      return;
    }
    if (event.type !== 'complete') return;
    const completed = event.stream
      ? streaming.value[event.stream.id]
      : undefined;
    if (!completed) return;
    void options
      .refetch()
      .then(() => {
        if (
          !completed.messageId ||
          options.rows().some((message) => message.id === completed.messageId)
        )
          remove(completed.id);
      })
      .catch(() => {
        // 保留完成视图，直到后续刷新拿到持久化消息，避免提前丢内容。
      });
  }

  function connect(id: string) {
    source = openEventStream<TeamStreamEvent>({
      url: `/api/teams/${encodeURIComponent(id)}/events`,
      eventName: 'team-stream',
      onEvent: accept,
      schedule: options.schedule,
      cancel: options.cancel,
      flushImmediately: (event) =>
        ['complete', 'cancelled', 'error', 'snapshot'].includes(event.type),
    });
  }

  watch(
    () => toValue(options.groupId),
    (id) => {
      source?.close();
      source = null;
      streaming.value = {};
      if (!id) return;
      connect(id);
    },
    { immediate: true },
  );

  // 落库后的消息本身就是权威：对应的在飞流不再需要渲染。
  watch(
    () => options.rows().map((message) => message.id).join('|'),
    () => {
      const persisted = new Set(options.rows().map((message) => message.id));
      const next = { ...streaming.value };
      let changed = false;
      for (const [id, stream] of Object.entries(next)) {
        if (stream.messageId && persisted.has(stream.messageId)) {
          delete next[id];
          changed = true;
        }
      }
      if (changed) streaming.value = next;
    },
  );

  onBeforeUnmount(() => {
    source?.close();
    source = null;
  });

  const activeStreams = computed(() => Object.values(streaming.value));
  return { streaming, activeStreams };
}
