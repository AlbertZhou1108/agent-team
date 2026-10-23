import { computed, type MaybeRefOrGetter, toValue } from 'vue';
import {
  useInfiniteQuery,
  useQuery,
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

export function useTeamGoalsQuery(teamId: MaybeRefOrGetter<string | undefined>) {
  return useQuery({
    queryKey: computed(() => ['team-goals', toValue(teamId)] as const),
    queryFn: ({ signal }) => api.teamGoals(toValue(teamId)!, signal),
    enabled: computed(() => Boolean(toValue(teamId))),
    refetchInterval: refreshInterval,
    refetchOnWindowFocus: false,
  });
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

export function usePanelAgentQuery() {
  return useQuery({
    queryKey: ['panel-agent'],
    queryFn: ({ signal }) => api.panelAgent(signal),
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
