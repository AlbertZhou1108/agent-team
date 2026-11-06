import { computed, type MaybeRefOrGetter, toValue } from 'vue';
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/vue-query';
import { api } from '@/shared/api/client';
import { queryKeys } from './query-keys';
import type {
  MessageRow,
  TurnSummariesResponse,
  TurnTrace,
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

export function useTurnsQuery(
  endpointId: MaybeRefOrGetter<string | undefined>,
  enabled: MaybeRefOrGetter<boolean> = true,
) {
  // 回合摘要:从第一回合起正向翻页,已加载页保持冻结、不轮询——
  // 收起回合的状态以摘要为准,展开中的回合由自身事件查询刷新。
  const query = useInfiniteQuery({
    queryKey: computed(() => queryKeys.turns(toValue(endpointId))),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => api.turns(toValue(endpointId)!, pageParam, signal),
    getNextPageParam: (lastPage: TurnSummariesResponse) => lastPage.nextAfter ?? undefined,
    enabled: computed(() => Boolean(toValue(endpointId)) && toValue(enabled)),
    refetchOnWindowFocus: false,
  });
  // 服务端最旧在前、页间连续;按稳定序号排序兜底,输出即正序展示序。
  const turns = computed(() =>
    [...new Map(
      (query.data.value?.pages ?? []).flatMap(page => page.turns).map(turn => [turn.id, turn]),
    ).values()].sort((a, b) => a.ordinal - b.ordinal),
  );
  const unaffiliated = computed(() => query.data.value?.pages[0]?.unaffiliated ?? []);
  return { ...query, turns, unaffiliated };
}

/** 单回合事件(懒加载):游标增量累积——展开/加载更多/运行中轮询都只拉上次之后的增量,页冻结不再整取。 */
export function useTurnTraceQuery(
  turnId: MaybeRefOrGetter<string | undefined>,
  enabled: MaybeRefOrGetter<boolean>,
  running: MaybeRefOrGetter<boolean> = false,
) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: computed(() => queryKeys.turn(toValue(turnId) ?? '')),
    queryFn: async ({ signal, queryKey }): Promise<TurnTrace> => {
      const previous = client.getQueryData<TurnTrace>(queryKey);
      const after = previous?.events.at(-1)?.seq ?? 0;
      const page = await api.turn(toValue(turnId)!, after, signal);
      if (!previous || !previous.events.length) return page;
      return {
        ...page,
        events: [...new Map([...previous.events, ...page.events].map(row => [row.seq, row])).values()]
          .sort((a, b) => a.seq - b.seq),
      };
    },
    enabled: computed(() => Boolean(toValue(turnId)) && toValue(enabled)),
    // 回合运行中且被展开时快轮询:增量只取新事件,重取成本与增量成正比。
    refetchInterval: computed(() => (toValue(running) ? QUERY_POLLING.fast : false)),
    refetchOnWindowFocus: false,
  });
  const events = computed(() => query.data.value?.events ?? []);
  // 回合级事实(state/eventCount)以最新一页为准。
  const trace = computed(() => query.data.value ?? null);
  // 超长回合(>200 事件)续页:每次 refetch 都从已累积的最高 seq 继续拉。
  const hasMore = computed(() =>
    Boolean(query.data.value && query.data.value.eventCount > query.data.value.events.length),
  );
  return { ...query, events, trace, hasMore, loadMore: query.refetch };
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

/** 用量视图只剩总览:head 一页(含 summary)就够,不再按批次翻页。 */
export function useConversationTelemetryQuery(
  groupId: MaybeRefOrGetter<string | undefined>,
  memberId: MaybeRefOrGetter<string | undefined>,
  peerId: MaybeRefOrGetter<string | undefined>,
  enabled: MaybeRefOrGetter<boolean> = true,
) {
  return useTelemetryHead(
    computed(() => queryKeys.telemetryConversation(toValue(groupId), toValue(memberId), toValue(peerId))),
    signal => api.telemetryConversation(
      toValue(groupId)!,
      toValue(memberId)!,
      toValue(peerId)!,
      {},
      signal,
    ),
    computed(() => Boolean(toValue(groupId)) && Boolean(toValue(memberId)) && Boolean(toValue(peerId)) && toValue(enabled)),
  );
}

export function useCoordinationTelemetryQuery(
  groupId: MaybeRefOrGetter<string | undefined>,
  enabled: MaybeRefOrGetter<boolean> = true,
) {
  return useTelemetryHead(
    computed(() => queryKeys.telemetryCoordination(toValue(groupId))),
    signal => api.telemetryCoordination(toValue(groupId)!, {}, signal),
    computed(() => Boolean(toValue(groupId)) && toValue(enabled)),
  );
}

export function useManagerConversationTelemetryQuery(
  groupId: MaybeRefOrGetter<string | undefined>,
  memberId: MaybeRefOrGetter<string | undefined>,
  enabled: MaybeRefOrGetter<boolean> = true,
) {
  return useTelemetryHead(
    computed(() => queryKeys.telemetryManagerConversation(toValue(groupId), toValue(memberId))),
    signal => api.telemetryManagerConversation(
      toValue(groupId)!,
      toValue(memberId)!,
      {},
      signal,
    ),
    computed(() => Boolean(toValue(groupId)) && Boolean(toValue(memberId)) && toValue(enabled)),
  );
}

export function useMembersTelemetryQuery(
  groupId: MaybeRefOrGetter<string | undefined>,
) {
  // 成员视图打开时才挂载(标签页按需渲染);5s 桶让出 2s 预算给消息/互动/运行状态。
  return useQuery({
    queryKey: computed(() => queryKeys.telemetryMembers(toValue(groupId))),
    queryFn: ({ signal }) => api.telemetryMembers(toValue(groupId)!, {}, signal),
    enabled: computed(() => Boolean(toValue(groupId))),
    refetchInterval: QUERY_POLLING.slow,
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
