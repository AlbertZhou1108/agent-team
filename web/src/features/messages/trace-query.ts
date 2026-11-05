import { computed, toValue, type MaybeRefOrGetter } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { api } from '@/shared/api/client';

/**
 * 一条消息的产出事件段。
 *
 * 轨迹的单位是消息:一个回合里每发出一次消息,都是一段独立的 思考→工具→产出
 * 过程。后端按 call_id 切好段,前端不再拉整轮事件再自己归组。
 */
export function useMessageTraceQuery(messageId: MaybeRefOrGetter<string>, expanded: MaybeRefOrGetter<boolean>) {
  return useQuery({
    queryKey: computed(() => ['message-trace', toValue(messageId)] as const),
    queryFn: ({ signal }) => api.messageTrace(toValue(messageId), signal, { segment: true }),
    enabled: computed(() => toValue(expanded)),
    staleTime: 60_000,
    retry: 0,
  });
}
