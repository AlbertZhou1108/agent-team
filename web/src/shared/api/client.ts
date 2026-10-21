import type {
  CollaborationState,
  HistoryRow,
  MessageTrace,
  MessageRow,
  ModelsPage,
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
