import { computed, toValue, type MaybeRefOrGetter } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { api } from '@/shared/api/client';

export function useMessageTraceQuery(messageId: MaybeRefOrGetter<string>, expanded: MaybeRefOrGetter<boolean>) {
  return useQuery({
    queryKey: computed(() => ['message-trace', toValue(messageId)] as const),
    queryFn: ({ signal }) => api.messageTrace(toValue(messageId), signal),
    enabled: computed(() => toValue(expanded)),
    staleTime: 60_000,
    retry: 0,
  });
}
