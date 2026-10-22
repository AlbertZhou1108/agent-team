import type {
  CollaborationState,
  Group,
  HistoryRow,
  MessageTrace,
  ModelCatalogResponse,
  ModelPolicy,
  MessageRow,
  ModelsPage,
  PanelAgentState,
  Snapshot,
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
  collaboration(group: string, after = 0, signal?: AbortSignal) {
    return request<CollaborationState>(query('/api/collaboration', { group, after }), signal);
  },
  snapshot(signal?: AbortSignal) {
    return request<Snapshot>('/api/snapshot', signal);
  },
  modelCatalog(refresh = false, signal?: AbortSignal) {
    return request<ModelCatalogResponse>(query('/api/model-catalog', { refresh: refresh ? 1 : undefined }), signal);
  },
  updateModelPolicy(mode: ModelPolicy['mode'], rules: string) {
    return mutate<ModelPolicy>('/api/model-policy', { mode, rules });
  },
  panelAgent(signal?: AbortSignal) {
    return request<PanelAgentState>('/api/panel-agent', signal);
  },
  createPanelAgent(body: {
    name: string;
    host: string;
    model_provider?: string | null;
    model: string;
    reasoning_effort?: string | null;
  }) {
    return mutate<PanelAgentState>('/api/panel-agent', body);
  },
  updatePanelAgent(body: {
    name?: string;
    host?: string;
    model_provider?: string | null;
    model?: string;
    reasoning_effort?: string | null;
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
  approvePreparation(id: string, revision: number, hash: string) {
    return mutate<Group>('/api/preparations/' + encodeURIComponent(id) + '/approve', { revision, hash });
  },
  takeoverTeam(groupId: string, revision: number) {
    return mutate('/api/teams/' + encodeURIComponent(groupId) + '/takeover', { revision });
  },
  handbackTeam(groupId: string, revision: number) {
    return mutate('/api/teams/' + encodeURIComponent(groupId) + '/handback', { revision });
  },
  decidePanelAction(id: string, approved: boolean) {
    return mutate('/api/panel-actions/' + encodeURIComponent(id) + '/decide', { approved });
  },
  messages(group: string, after = 0, signal?: AbortSignal) {
    return request<MessageRow[]>(query('/api/messages', { group, after }), signal);
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
};
