import { computed, type MaybeRefOrGetter, toValue } from 'vue';
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/vue-query';
import { api } from '@/shared/api/client';
import type {
  HistoryRow,
  MessageRow,
  TelemetryBatch,
  TelemetryConversationResponse,
  TelemetryCoordinationResponse,
  TelemetryManagerBatch,
  TelemetryManagerConversationResponse,
} from '@/shared/api/raw-types';

const refreshInterval = 2000;

export function useCollaborationQuery(groupId: MaybeRefOrGetter<string | undefined>) {
  return useQuery({
    queryKey: computed(() => ['collaboration', toValue(groupId)] as const),
    queryFn: ({ signal }) => api.collaboration(toValue(groupId)!, signal),
    enabled: computed(() => Boolean(toValue(groupId))),
    refetchInterval: refreshInterval,
    refetchOnWindowFocus: false,
  });
}

export function useCharterQuery(groupId: MaybeRefOrGetter<string | undefined>) {
  return useQuery({
    queryKey: computed(() => ['charter', toValue(groupId)] as const),
    queryFn: ({ signal }) => api.charter(toValue(groupId)!, signal),
    enabled: computed(() => Boolean(toValue(groupId))),
    refetchOnWindowFocus: false,
  });
}

export function usePanelAgentQuery(full: MaybeRefOrGetter<boolean> = true) {
  return useQuery({
    queryKey: ['panel-agent', 'state'],
    enabled: computed(() => toValue(full)),
    queryFn: ({ signal }) => api.panelAgent(signal),
    refetchInterval: refreshInterval,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}

export function useMessagesQuery(groupId: MaybeRefOrGetter<string | undefined>, endpoint: MaybeRefOrGetter<string | undefined> = undefined) {
  const client = useQueryClient();
  const key = computed(() => ['messages', toValue(groupId), toValue(endpoint) ?? null] as const);
  // Head and history caches are written independently and restored separately
  // by the tab cache, so a mounted view verifies their seam against a fresh
  // server page once before either is trusted for incremental polling.
  const verifiedSeams = new Set<string>();
  const head = useQuery({
    queryKey: key,
    queryFn: async ({ signal, queryKey }) => {
      const identity = JSON.stringify(queryKey);
      const previous = client.getQueryData<MessageRow[]>(queryKey) ?? [];
      const older = client.getQueryData<{ pages: MessageRow[][] }>(['message-history', queryKey[1], queryKey[2]])?.pages.flat() ?? [];
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
    queryKey: computed(() => ['message-history', toValue(groupId), toValue(endpoint) ?? null] as const),
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

export function useConversationTelemetryQuery(
  groupId: MaybeRefOrGetter<string | undefined>,
  memberId: MaybeRefOrGetter<string | undefined>,
  peerId: MaybeRefOrGetter<string | undefined>,
) {
  const query = useInfiniteQuery({
    queryKey: computed(
      () =>
        [
          'telemetry-conversation',
          toValue(groupId),
          toValue(memberId),
          toValue(peerId),
        ] as const,
    ),
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
    enabled: computed(
      () =>
        Boolean(toValue(groupId)) &&
        Boolean(toValue(memberId)) &&
        Boolean(toValue(peerId)),
    ),
    refetchInterval: refreshInterval,
    refetchOnWindowFocus: false,
  });
  const firstPage = computed<TelemetryConversationResponse | undefined>(
    () => query.data.value?.pages[0],
  );
  const batches = computed<TelemetryBatch[]>(() =>
    [
      ...new Map(
        (query.data.value?.pages.flatMap(page => page.batches) ?? []).map(
          batch => [batch.batchId, batch],
        ),
      ).values(),
    ],
  );
  return { ...query, firstPage, batches };
}

export function useCoordinationTelemetryQuery(
  groupId: MaybeRefOrGetter<string | undefined>,
) {
  const query = useInfiniteQuery({
    queryKey: computed(
      () => ['telemetry-coordination', toValue(groupId)] as const,
    ),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.telemetryCoordination(
        toValue(groupId)!,
        { cursor: pageParam },
        signal,
      ),
    getNextPageParam: last => last.nextCursor ?? undefined,
    enabled: computed(() => Boolean(toValue(groupId))),
    refetchInterval: refreshInterval,
    refetchOnWindowFocus: false,
  });
  const firstPage = computed<TelemetryCoordinationResponse | undefined>(
    () => query.data.value?.pages[0],
  );
  const batches = computed<TelemetryBatch[]>(() =>
    [
      ...new Map(
        (query.data.value?.pages.flatMap(page => page.batches) ?? []).map(
          batch => [batch.batchId, batch],
        ),
      ).values(),
    ],
  );
  return { ...query, firstPage, batches };
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
  const query = useInfiniteQuery({
    queryKey: computed(
      () =>
        [
          'telemetry-manager-conversation',
          toValue(groupId),
          toValue(memberId),
          toValue(options.from),
          toValue(options.to),
          toValue(options.limit),
        ] as const,
    ),
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
    enabled: computed(
      () => Boolean(toValue(groupId)) && Boolean(toValue(memberId)),
    ),
    refetchInterval: refreshInterval,
    refetchOnWindowFocus: false,
  });
  const firstPage = computed<TelemetryManagerConversationResponse | undefined>(
    () => query.data.value?.pages[0],
  );
  const batches = computed<TelemetryManagerBatch[]>(() =>
    [
      ...new Map(
        (query.data.value?.pages.flatMap(page => page.batches) ?? []).map(
          batch => [batch.batchId, batch],
        ),
      ).values(),
    ],
  );
  return { ...query, firstPage, batches };
}

export function useMembersTelemetryQuery(
  groupId: MaybeRefOrGetter<string | undefined>,
) {
  return useQuery({
    queryKey: computed(
      () => ['telemetry-members', toValue(groupId)] as const,
    ),
    queryFn: ({ signal }) => api.telemetryMembers(toValue(groupId)!, {}, signal),
    enabled: computed(() => Boolean(toValue(groupId))),
    refetchInterval: refreshInterval,
    refetchOnWindowFocus: false,
  });
}

export function useTelemetryCapabilitiesQuery(
  groupId: MaybeRefOrGetter<string | undefined>,
) {
  return useQuery({
    queryKey: computed(
      () => ['telemetry-capabilities', toValue(groupId)] as const,
    ),
    queryFn: ({ signal }) =>
      api.telemetryCapabilities(toValue(groupId)!, signal),
    enabled: computed(() => Boolean(toValue(groupId))),
    refetchInterval: refreshInterval,
    refetchOnWindowFocus: false,
  });
}

export function useTeamDirectivesQuery(groupId: MaybeRefOrGetter<string | undefined>) {
  return useQuery({
    queryKey: computed(() => ['team-directives', toValue(groupId)]),
    queryFn: ({ signal }) => api.teamDirectives(toValue(groupId)!, signal),
    enabled: computed(() => Boolean(toValue(groupId))),
    refetchInterval: refreshInterval,
    refetchOnWindowFocus: false,
  });
}

export function useInteractionsQuery(groupId: MaybeRefOrGetter<string | undefined>) {
  return useQuery({
    queryKey: computed(() => ['interactions', toValue(groupId)]),
    queryFn: ({ signal }) => api.interactions(toValue(groupId)!, signal),
    enabled: computed(() => Boolean(toValue(groupId))),
    refetchInterval: refreshInterval,
    refetchOnWindowFocus: false,
  });
}

export function usePanelInteractionsQuery() {
  return useQuery({
    queryKey: ['interactions', 'panel'] as const,
    queryFn: ({ signal }) => api.panelInteractions(signal),
    refetchInterval: refreshInterval,
    refetchOnWindowFocus: false,
  });
}

export function useResourceQuery<T>(key: MaybeRefOrGetter<readonly unknown[]>, load: (signal: AbortSignal) => Promise<T>, enabled: MaybeRefOrGetter<boolean> = true, interval: number | false = 2000) {
  return useQuery({ queryKey: computed(() => toValue(key)), queryFn: ({ signal }) => load(signal), enabled: computed(() => toValue(enabled)), refetchInterval: interval, refetchOnWindowFocus: false, retry: 1 });
}
