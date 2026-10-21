import { computed, type MaybeRefOrGetter, toValue } from 'vue';
import {
  useInfiniteQuery,
  useQuery,
} from '@tanstack/vue-query';
import { api } from '@/shared/api/client';
import type { HistoryRow, MessageRow } from '@/shared/api/raw-types';

const refreshInterval = 2000;

export function useCollaborationQuery(groupId: MaybeRefOrGetter<string | undefined>) {
  const query = useInfiniteQuery({
    queryKey: computed(() => ['collaboration', toValue(groupId)] as const),
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => api.collaboration(toValue(groupId)!, pageParam, signal),
    getNextPageParam: last => last.records.length === 100 ? last.nextAfter : undefined,
    enabled: computed(() => Boolean(toValue(groupId))),
    refetchInterval: refreshInterval,
    refetchOnWindowFocus: false,
  });
  const state = computed(() => query.data.value?.pages[0]);
  const records = computed(() => [...new Map((query.data.value?.pages.flatMap(p => p.records) ?? []).map(r => [r.seq, r])).values()].sort((a, b) => a.seq - b.seq));
  return { ...query, state, records };
}

export function useSnapshotQuery() {
  return useQuery({
    queryKey: ['snapshot'],
    queryFn: ({ signal }) => api.snapshot(signal),
    refetchInterval: refreshInterval,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}

export function useMessagesQuery(groupId: MaybeRefOrGetter<string | undefined>) {
  const query = useInfiniteQuery({
    queryKey: computed(() => ['messages', toValue(groupId)] as const),
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => api.messages(toValue(groupId)!, pageParam, signal),
    getNextPageParam: (lastPage: MessageRow[]) => (
      lastPage.length === 200 ? lastPage.at(-1)?.seq : undefined
    ),
    enabled: computed(() => Boolean(toValue(groupId))),
    refetchInterval: refreshInterval,
    refetchOnWindowFocus: false,
  });

  const rows = computed(() => {
    const pages = query.data.value?.pages.flat() ?? [];
    return [...new Map(pages.map(row => [row.seq, row])).values()]
      .sort((a, b) => a.seq - b.seq);
  });

  return { ...query, rows };
}

export function useHistoryQuery(
  endpointId: MaybeRefOrGetter<string | undefined>,
) {
  const query = useInfiniteQuery({
    queryKey: computed(() => ['history', toValue(endpointId)] as const),
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => api.history(toValue(endpointId)!, pageParam, signal),
    getNextPageParam: (lastPage: HistoryRow[]) => (
      lastPage.length === 200 ? lastPage.at(-1)?.seq : undefined
    ),
    enabled: computed(() => Boolean(toValue(endpointId))),
    refetchInterval: refreshInterval,
    refetchOnWindowFocus: false,
  });

  const rows = computed(() => {
    const pages = query.data.value?.pages.flat() ?? [];
    return [...new Map(pages.map(row => [row.seq, row])).values()]
      .sort((a, b) => a.seq - b.seq);
  });

  return { ...query, rows };
}

export function useModelsQuery(
  endpointId: MaybeRefOrGetter<string | undefined>,
) {
  const query = useInfiniteQuery({
    queryKey: computed(() => ['models', toValue(endpointId)] as const),
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => api.models(toValue(endpointId)!, pageParam, signal),
    getNextPageParam: lastPage => (
      lastPage.observations.length === 200 ? lastPage.nextAfter : undefined
    ),
    enabled: computed(() => Boolean(toValue(endpointId))),
    refetchInterval: refreshInterval,
    refetchOnWindowFocus: false,
  });

  const observations = computed(() => {
    const pages = query.data.value?.pages ?? [];
    return [...new Map(pages.flatMap(page => page.observations).map(item => [item.seq, item])).values()]
      .sort((a, b) => a.seq - b.seq);
  });

  const state = computed(() => query.data.value?.pages.at(-1) ?? null);

  return { ...query, observations, state };
}
