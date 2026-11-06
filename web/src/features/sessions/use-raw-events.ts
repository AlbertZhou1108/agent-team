import { computed, type MaybeRefOrGetter, toValue } from 'vue';
import { useInfiniteQuery } from '@tanstack/vue-query';
import { api } from '@/shared/api/client';
import { queryKeys } from '@/features/query-keys';
import type { HistoryRow } from '@/shared/api/raw-types';

/**
 * 原始事件平铺流(调试视图):执行轨迹页底部的折叠区展开时才拉取,
 * 已加载页保持冻结,区内自行向前翻页。回合化轨迹不再复用这条查询。
 */
export function useRawEventsQuery(
  endpointId: MaybeRefOrGetter<string | undefined>,
  enabled: MaybeRefOrGetter<boolean>,
) {
  const query = useInfiniteQuery({
    queryKey: computed(() => queryKeys.history(toValue(endpointId))),
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => api.history(toValue(endpointId)!, pageParam, signal),
    getNextPageParam: (lastPage: HistoryRow[]) => (
      lastPage.length === 200 ? lastPage.at(-1)?.seq : undefined
    ),
    enabled: computed(() => Boolean(toValue(endpointId)) && toValue(enabled)),
    refetchOnWindowFocus: false,
  });

  const rows = computed(() => {
    const pages = query.data.value?.pages.flat() ?? [];
    return [...new Map(pages.map(row => [row.seq, row])).values()]
      .sort((a, b) => a.seq - b.seq);
  });

  return { ...query, rows };
}
