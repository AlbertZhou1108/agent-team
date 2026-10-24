import type {
  Group,
  GroupCommunicationSummary,
  HistoryRow,
  MessageTrace,
  ModelCatalogResponse,
  ModelPolicy,
  MessageRow,
  ModelsPage,
  PanelAccess,
  PanelAgentState,
  Snapshot,
  TeamDirectiveReceipt,
  TelemetryCapabilityResponse,
  TelemetryConversationResponse,
  TelemetryCoordinationResponse,
  TelemetryMembersResponse,
  TelemetryManagerConversationResponse,
  TurnTrace,
} from './raw-types';

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) {
    throw new ApiError(response.status, await response.text());
  }
  return response.json() as Promise<T>;
}

async function mutate<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new ApiError(response.status, await response.text());
  return response.json() as Promise<T>;
}

function query(path: string, values: Record<string, string | number | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  return `${path}?${params.toString()}`;
}

export const api = {
  chooseDirectory() { return mutate<{ path: string | null }>('/api/local/directory-picker', {}); },
  teamDirectives(groupId: string, signal?: AbortSignal) {
    return request<TeamDirectiveReceipt[]>(`/api/teams/${encodeURIComponent(groupId)}/directives`, signal);
  },
  sendTeamDirective(groupId: string, body: { text: string; operationId: string; controllerId: string }) {
    return mutate<TeamDirectiveReceipt>(`/api/teams/${encodeURIComponent(groupId)}/directives`, body);
  },
  collaboration(group: string, signal?: AbortSignal) {
    return request<GroupCommunicationSummary>(query('/api/collaboration', { group }), signal);
  },
  charter(group: string, signal?: AbortSignal) {
    return request<string | null>(query('/api/charter', { group }), signal);
  },
  snapshot(signal?: AbortSignal, group?: string) {
    return request<Snapshot>(query('/api/snapshot', { group, scoped: 1 }), signal);
  },
  modelCatalog(refresh = false, signal?: AbortSignal) {
    return request<ModelCatalogResponse>(query('/api/model-catalog', { refresh: refresh ? 1 : undefined }), signal);
  },
  updateModelPolicy(mode: ModelPolicy['mode'], rules: string) {
    return mutate<ModelPolicy>('/api/model-policy', { mode, rules });
  },
  panelAgent(signal?: AbortSignal, summary = false) {
    return request<PanelAgentState>(query('/api/panel-agent', { summary: summary ? 1 : undefined }), signal);
  },
  createPanelAgent(body: {
    name: string;
    host: string;
    model_provider?: string | null;
    model: string;
    reasoning_effort?: string | null;
    workspace?: string | null;
    access?: PanelAccess;
  }) {
    return mutate<PanelAgentState>('/api/panel-agent', body);
  },
  updatePanelAgent(body: {
    name?: string;
    host?: string;
    model_provider?: string | null;
    model?: string;
    reasoning_effort?: string | null;
    workspace?: string | null;
    access?: PanelAccess;
  }) {
    return mutate<PanelAgentState>('/api/panel-agent/update', body);
  },
  panelMessage(text: string, activeTeamId?: string | null) {
    return mutate<{ reply: unknown; result: string }>('/api/panel-agent/messages', { text, activeTeamId: activeTeamId ?? null });
  },
  stopPanel() {
    return mutate<{ stopped: string[] }>('/api/panel-agent/stop', {});
  },
  resolvePanelRuntime(turnId: string, reason: string) {
    return mutate<{ turnId: string; state: string }>('/api/panel-agent/resolve-runtime', { turnId, reason });
  },
  archiveTeam(teamId: string) {
    return mutate<Group>(`/api/teams/${encodeURIComponent(teamId)}/archive`, {});
  },
  restoreTeam(teamId: string) {
    return mutate<Group>(`/api/teams/${encodeURIComponent(teamId)}/restore`, {});
  },
  takeoverTeam(groupId: string, revision: number) {    return mutate('/api/teams/' + encodeURIComponent(groupId) + '/takeover', { revision });
  },
  handbackTeam(groupId: string, revision: number) {
    return mutate('/api/teams/' + encodeURIComponent(groupId) + '/handback', { revision });
  },
  decidePanelAction(id: string, approved: boolean) {
    return mutate('/api/panel-actions/' + encodeURIComponent(id) + '/decide', { approved });
  },
  messages(group: string, before: number | undefined, signal?: AbortSignal, endpoint?: string, after?: number) {
    return request<MessageRow[]>(query('/api/messages', { group, before, endpoint, after, latest: 1 }), signal);
  },
  history(endpoint: string, after = 0, signal?: AbortSignal) {
    return request<HistoryRow[]>(query('/api/history', { endpoint, after }), signal);
  },
  models(endpoint: string, after = 0, signal?: AbortSignal) {
    return request<ModelsPage>(query('/api/models', { endpoint, after }), signal);
  },
  messageTrace(message: string, signal?: AbortSignal) {
    return request<MessageTrace>(query('/api/message-trace', { message }), signal);
  },
  turn(turn: string, after = 0, signal?: AbortSignal) {
    return request<TurnTrace>(query('/api/turn', { turn, after }), signal);
  },
  telemetryConversation(
    group: string,
    member: string,
    peer: string,
    options: { cursor?: string; limit?: number; from?: string; to?: string } = {},
    signal?: AbortSignal,
  ) {
    return request<TelemetryConversationResponse>(
      query('/api/telemetry/conversation', {
        group,
        member,
        peer,
        cursor: options.cursor,
        limit: options.limit,
        from: options.from,
        to: options.to,
      }),
      signal,
    );
  },
  telemetryManagerConversation(
    group: string,
    member: string,
    options: { cursor?: string; limit?: number; from?: string; to?: string } = {},
    signal?: AbortSignal,
  ) {
    return request<TelemetryManagerConversationResponse>(
      query('/api/telemetry/manager-conversation', {
        group,
        member,
        cursor: options.cursor,
        limit: options.limit,
        from: options.from,
        to: options.to,
      }),
      signal,
    );
  },
  telemetryCoordination(
    group: string,
    options: { cursor?: string; limit?: number; from?: string; to?: string } = {},
    signal?: AbortSignal,
  ) {
    return request<TelemetryCoordinationResponse>(
      query('/api/telemetry/coordination', {
        group,
        cursor: options.cursor,
        limit: options.limit,
        from: options.from,
        to: options.to,
      }),
      signal,
    );
  },
  telemetryMembers(
    group: string,
    options: { from?: string; to?: string } = {},
    signal?: AbortSignal,
  ) {
    return request<TelemetryMembersResponse>(
      query('/api/telemetry/members', {
        group,
        from: options.from,
        to: options.to,
      }),
      signal,
    );
  },
  telemetryCapabilities(group: string, signal?: AbortSignal) {
    return request<TelemetryCapabilityResponse>(
      query('/api/telemetry/capabilities', { group }),
      signal,
    );
  },
};
