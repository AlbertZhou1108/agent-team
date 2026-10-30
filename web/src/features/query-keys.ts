import type { QueryClient } from '@tanstack/vue-query';

export const queryKeys = {
  groups: ['groups'] as const,
  directory: ['directory'] as const,
  home: ['home-summary'] as const,
  policy: ['model-policy'] as const,
  defaults: ['model-policy-defaults'] as const,
  panelState: ['panel-agent', 'state'] as const,
  unread: ['panel-agent', 'unread'] as const,
  group: (id: string) => ['group', id] as const,
  resource: (id: string, resource: string) => ['group', id, resource] as const,
  session: (id: string, endpoint: string) => ['group', id, 'session', endpoint] as const,
};

/** Refresh all active projections after changes spanning team membership or configuration. */
export function invalidateWorkspaceResources(client: QueryClient) {
  return client.invalidateQueries({ predicate: query => ['groups', 'directory', 'group', 'home-summary', 'model-policy', 'panel-agent'].includes(String(query.queryKey[0])) });
}
