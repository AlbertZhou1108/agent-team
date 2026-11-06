import { computed, type MaybeRefOrGetter, toValue } from 'vue';
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/vue-query';
import { api } from '@/shared/api/client';
import { queryKeys } from './query-keys';
import type {
  HistoryRow,
  MessageRow,
  TelemetryBatch,
  TelemetryConversationResponse,
  TelemetryCoordinationResponse,
  TelemetryManagerBatch,
  TelemetryManagerConversationResponse,
} from '@/shared/api/raw-types';

// 页面级轮询预算:团队页默认布局只允许 3 个 2 秒查询(消息头/互动卡/运行状态),
// 其它查询按 5s/10s/30s 降频或按需。新增轮询必须从这里选桶,不要在调用点写数字。
export const QUERY_POLLING = {
  fast: 2000,
  slow: 5000,
  ambient: 10000,
  rare: 30000,
} as const;
const refreshInterval = QUERY_POLLING.fast;

export function useCollaborationQuery(groupId: MaybeRefOrGetter<string | undefined>) {
  return useQuery({
    queryKey: computed(() => queryKeys.collaboration(toValue(groupId))),
    queryFn: ({ signal }) => api.collaboration(toValue(groupId)!, signal),
    enabled: computed(() => Boolean(toValue(groupId))),
    refetchInterval: QUERY_POLLING.slow,
    refetchOnWindowFocus: false,
  });
}

export function useCharterQuery(groupId: MaybeRefOrGetter<string | undefined>) {
  return useQuery({
    queryKey: computed(() => queryKeys.charter(toValue(groupId))),
    queryFn: ({ signal }) => api.charter(toValue(groupId)!, signal),
    enabled: computed(() => Boolean(toValue(groupId))),
    refetchOnWindowFocus: false,
  });
}

export function usePanelAgentQuery(full: MaybeRefOrGetter<boolean> = true) {
  return useQuery({
    queryKey: queryKeys.panelState,
    enabled: computed(() => toValue(full)),
    queryFn: ({ signal }) => api.panelAgent(signal),
    refetchInterval: QUERY_POLLING.slow,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}

export function useMessagesQuery(groupId: MaybeRefOrGetter<string | undefined>, endpoint: MaybeRefOrGetter<string | undefined> = undefined) {
  const client = useQueryClient();
  const key = computed(() => queryKeys.messages(toValue(groupId), toValue(endpoint) ?? null));
  // Head and history caches are written independently and restored separately
  // by the tab cache, so a mounted view verifies their seam against a fresh
  // server page once before either is trusted for incremental polling.
  const verifiedSeams = new Set<string>();
  const head = useQuery({
    queryKey: key,
    queryFn: async ({ signal, queryKey }) => {
      const identity = JSON.stringify(queryKey);
      const previous = client.getQueryData<MessageRow[]>(queryKey) ?? [];
      const older = client.getQueryData<{ pages: MessageRow[][] }>(queryKeys.messageHistory(queryKey[1] as string, queryKey[2] as string | null))?.pages.flat() ?? [];
      const rows = [...new Map([...previous, ...older].map(row => [row.seq, row])).values()].sort((a, b) => a.seq - b.seq);
      if (rows.length && !verifiedSeams.has(identity)) {
        const fresh = await api.messages(queryKey[1]!, undefined, signal, queryKey[2] ?? undefined);
        const cachedFloor = rows[0]!.seq;
        rows.push(...fresh);
        // Page backwards from the fresh window down to the cached floor,
        // bridging every gap a partial restore left inside the caches — the
        // cache may hold several disconnected islands, not just one seam.
        let floor = fresh[0]?.seq;
        for (let guard = 0; guard < 40 && floor !== undefined && floor > cachedFloor; guard += 1) {
          const page = await api.messages(queryKey[1]!, floor, signal, queryKey[2] ?? undefined);
          if (!page.length || page[0]!.seq >= floor) break;
          rows.push(...page);
          floor = page[0]!.seq;
        }
      } else {
        // Drain new records independently of the frozen history pages.
        let after = rows.at(-1)?.seq;
        while (true) {
          const batch = await api.messages(queryKey[1]!, undefined, signal, queryKey[2] ?? undefined, after);
          rows.push(...batch);
          if (after === undefined || batch.length < 200) break;
          after = batch.at(-1)!.seq;
        }
      }
      verifiedSeams.add(identity);
      return [...new Map(rows.map(row => [row.seq, row])).values()].sort((a, b) => a.seq - b.seq);
    },
    staleTime: 0,
    refetchOnMount: 'always',
    enabled: computed(() => Boolean(toValue(groupId))),
    refetchInterval: refreshInterval,
    refetchOnWindowFocus: false,
  });
  const history = useInfiniteQuery({
    queryKey: computed(() => queryKeys.messageHistory(toValue(groupId), toValue(endpoint) ?? null)),
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam, signal, queryKey }) => api.messages(queryKey[1]!, pageParam ?? head.data.value?.[0]?.seq, signal, queryKey[2] ?? undefined),
    getNextPageParam: (last: MessageRow[]) => last.length === 50 ? last[0]?.seq : undefined,
    enabled: false,
    staleTime: Infinity,
  });
  const rows = computed(() => [...new Map([
    ...(history.data.value?.pages.flat() ?? []), ...(head.data.value ?? []),
  ].map(row => [row.seq, row])).values()].sort((a, b) => a.seq - b.seq));
  const hasNextPage = computed(() => history.data.value ? history.hasNextPage.value : (head.data.value?.length ?? 0) >= 50);
  return { ...head, rows, hasNextPage, fetchNextPage: history.fetchNextPage, isFetchingNextPage: history.isFetchingNextPage };
}

export function useHistoryQuery(
  endpointId: MaybeRefOrGetter<string | undefined>,
) {
  // 历史页不再轮询:视图打开时按需拉取,已加载页保持冻结,避免每 2 秒重取全部页。
  const query = useInfiniteQuery({
    queryKey: computed(() => queryKeys.history(toValue(endpointId))),
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => api.history(toValue(endpointId)!, pageParam, signal),
    getNextPageParam: (lastPage: HistoryRow[]) => (
      lastPage.length === 200 ? lastPage.at(-1)?.seq : undefined
    ),
    enabled: computed(() => Boolean(toValue(endpointId))),
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
  // 同 history:模型观察列表只在打开模型页时按需拉取,不再全量轮询。
  const query = useInfiniteQuery({
    queryKey: computed(() => queryKeys.models(toValue(endpointId))),
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => api.models(toValue(endpointId)!, pageParam, signal),
    getNextPageParam: lastPage => (
      lastPage.observations.length === 200 ? lastPage.nextAfter : undefined
    ),
    enabled: computed(() => Boolean(toValue(endpointId))),
    refetchOnWindowFocus: false,
  });

  const observations = computed(() => {
    const pages = query.data.value?.pages ?? [];
    return [...new Map(
      pages.flatMap(page => page.observations).map(item => [item.seq, item]),
    ).values()]
      .sort((a, b) => a.seq - b.seq);
  });

  const state = computed(() => query.data.value?.pages.at(-1) ?? null);

  return { ...query, observations, state };
}

/** infinite query 的历史页保持冻结,只轮询最新一页(head)。 */
function useTelemetryHead<T>(
  key: MaybeRefOrGetter<readonly unknown[]>,
  load: (signal: AbortSignal) => Promise<T>,
  enabled: MaybeRefOrGetter<boolean>,
) {
  return useQuery({
    queryKey: computed(() => [...toValue(key), 'head']),
    queryFn: ({ signal }) => load(signal),
    enabled: computed(() => toValue(enabled)),
    refetchInterval: QUERY_POLLING.fast,
    refetchOnWindowFocus: false,
  });
}

/** 按 batchId 合并 head 与历史页,避免首屏与历史页重复项。 */
function mergeBatches<T extends { batchId: string }>(...groups: Array<T[] | undefined>): T[] {
  return [
    ...new Map(
      groups.flatMap(group => group ?? []).map(batch => [batch.batchId, batch]),
    ).values(),
  ];
}

export function useConversationTelemetryQuery(
  groupId: MaybeRefOrGetter<string | undefined>,
  memberId: MaybeRefOrGetter<string | undefined>,
  peerId: MaybeRefOrGetter<string | undefined>,
) {
  const enabled = computed(
    () =>
      Boolean(toValue(groupId)) &&
      Boolean(toValue(memberId)) &&
      Boolean(toValue(peerId)),
  );
  const key = computed(() =>
    queryKeys.telemetryConversation(toValue(groupId), toValue(memberId), toValue(peerId)),
  );
  const head = useTelemetryHead(
    key,
    signal => api.telemetryConversation(
      toValue(groupId)!,
      toValue(memberId)!,
      toValue(peerId)!,
      {},
      signal,
    ),
    enabled,
  );
  const query = useInfiniteQuery({
    queryKey: key,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.telemetryConversation(
        toValue(groupId)!,
        toValue(memberId)!,
        toValue(peerId)!,
        { cursor: pageParam },
        signal,
      ),
    getNextPageParam: last => last.nextCursor ?? undefined,
    enabled,
    refetchOnWindowFocus: false,
  });
  const firstPage = computed<TelemetryConversationResponse | undefined>(
    () => head.data.value ?? query.data.value?.pages[0],
  );
  const batches = computed<TelemetryBatch[]>(() => mergeBatches(
    head.data.value?.batches,
    query.data.value?.pages.flatMap(page => page.batches),
  ));
  return { ...query, firstPage, batches, head };
}

export function useCoordinationTelemetryQuery(
  groupId: MaybeRefOrGetter<string | undefined>,
) {
  const enabled = computed(() => Boolean(toValue(groupId)));
  const key = computed(() => queryKeys.telemetryCoordination(toValue(groupId)));
  const head = useTelemetryHead(
    key,
    signal => api.telemetryCoordination(toValue(groupId)!, {}, signal),
    enabled,
  );
  const query = useInfiniteQuery({
    queryKey: key,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.telemetryCoordination(
        toValue(groupId)!,
        { cursor: pageParam },
        signal,
      ),
    getNextPageParam: last => last.nextCursor ?? undefined,
    enabled,
    refetchOnWindowFocus: false,
  });
  const firstPage = computed<TelemetryCoordinationResponse | undefined>(
    () => head.data.value ?? query.data.value?.pages[0],
  );
  const batches = computed<TelemetryBatch[]>(() => mergeBatches(
    head.data.value?.batches,
    query.data.value?.pages.flatMap(page => page.batches),
  ));
  return { ...query, firstPage, batches, head };
}

export function useManagerConversationTelemetryQuery(
  groupId: MaybeRefOrGetter<string | undefined>,
  memberId: MaybeRefOrGetter<string | undefined>,
  options: {
    from?: MaybeRefOrGetter<string | undefined>;
    to?: MaybeRefOrGetter<string | undefined>;
    limit?: MaybeRefOrGetter<number | undefined>;
  } = {},
) {
  const enabled = computed(
    () => Boolean(toValue(groupId)) && Boolean(toValue(memberId)),
  );
  const key = computed(() =>
    queryKeys.telemetryManagerConversation(
      toValue(groupId),
      toValue(memberId),
      toValue(options.from),
      toValue(options.to),
      toValue(options.limit),
    ),
  );
  const head = useTelemetryHead(
    key,
    signal => api.telemetryManagerConversation(
      toValue(groupId)!,
      toValue(memberId)!,
      {
        from: toValue(options.from),
        to: toValue(options.to),
        limit: toValue(options.limit),
      },
      signal,
    ),
    enabled,
  );
  const query = useInfiniteQuery({
    queryKey: key,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.telemetryManagerConversation(
        toValue(groupId)!,
        toValue(memberId)!,
        {
          cursor: pageParam,
          from: toValue(options.from),
          to: toValue(options.to),
          limit: toValue(options.limit),
        },
        signal,
      ),
    getNextPageParam: last => last.nextCursor ?? undefined,
    enabled,
    refetchOnWindowFocus: false,
  });
  const firstPage = computed<TelemetryManagerConversationResponse | undefined>(
    () => head.data.value ?? query.data.value?.pages[0],
  );
  const batches = computed<TelemetryManagerBatch[]>(() => mergeBatches(
    head.data.value?.batches,
    query.data.value?.pages.flatMap(page => page.batches),
  ));
  return { ...query, firstPage, batches, head };
}

export function useMembersTelemetryQuery(
  groupId: MaybeRefOrGetter<string | undefined>,
) {
  return useQuery({
    queryKey: computed(() => queryKeys.telemetryMembers(toValue(groupId))),
    queryFn: ({ signal }) => api.telemetryMembers(toValue(groupId)!, {}, signal),
    enabled: computed(() => Boolean(toValue(groupId))),
    refetchInterval: QUERY_POLLING.fast,
    refetchOnWindowFocus: false,
  });
}

export function useTelemetryCapabilitiesQuery(
  groupId: MaybeRefOrGetter<string | undefined>,
) {
  return useQuery({
    queryKey: computed(() => queryKeys.telemetryCapabilities(toValue(groupId))),
    queryFn: ({ signal }) =>
      api.telemetryCapabilities(toValue(groupId)!, signal),
    enabled: computed(() => Boolean(toValue(groupId))),
    refetchInterval: QUERY_POLLING.ambient,
    refetchOnWindowFocus: false,
  });
}

export function useTeamDirectivesQuery(groupId: MaybeRefOrGetter<string | undefined>) {
  return useQuery({
    queryKey: computed(() => queryKeys.teamDirectives(toValue(groupId))),
    queryFn: ({ signal }) => api.teamDirectives(toValue(groupId)!, signal),
    enabled: computed(() => Boolean(toValue(groupId))),
    refetchInterval: QUERY_POLLING.slow,
    refetchOnWindowFocus: false,
  });
}

export function useInteractionsQuery(groupId: MaybeRefOrGetter<string | undefined>) {
  return useQuery({
    queryKey: computed(() => queryKeys.interactions(toValue(groupId))),
    queryFn: ({ signal }) => api.interactions(toValue(groupId)!, signal),
    enabled: computed(() => Boolean(toValue(groupId))),
    refetchInterval: QUERY_POLLING.fast,
    refetchOnWindowFocus: false,
  });
}

export function usePanelInteractionsQuery() {
  return useQuery({
    queryKey: queryKeys.panelInteractions,
    queryFn: ({ signal }) => api.panelInteractions(signal),
    refetchInterval: QUERY_POLLING.slow,
    refetchOnWindowFocus: false,
  });
}

export function useResourceQuery<T>(key: MaybeRefOrGetter<readonly unknown[]>, load: (signal: AbortSignal) => Promise<T>, enabled: MaybeRefOrGetter<boolean> = true, interval: number | false = QUERY_POLLING.slow) {
  return useQuery({ queryKey: computed(() => toValue(key)), queryFn: ({ signal }) => load(signal), enabled: computed(() => toValue(enabled)), refetchInterval: interval, refetchOnWindowFocus: false, retry: 1 });
}
