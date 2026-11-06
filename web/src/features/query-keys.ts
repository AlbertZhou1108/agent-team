import type { QueryClient } from '@tanstack/vue-query';

// query key 的单一来源:页面/组合式函数不再各自内联 key。
// 注意与 shared/api/tab-cache.ts 的持久化 key 形状保持一致（messages / message-history）。
export const queryKeys = {
  groups: ['groups'] as const,
  directory: ['directory'] as const,
  home: ['home-summary'] as const,
  policy: ['model-policy'] as const,
  defaults: ['model-policy-defaults'] as const,
  themePacks: ['theme-packs'] as const,
  attachmentSettings: ['attachment-settings'] as const,
  panelState: ['panel-agent', 'state'] as const,
  panelInteractions: ['interactions', 'panel'] as const,
  unread: ['panel-agent', 'unread'] as const,
  collaboration: (id: string | undefined) => ['collaboration', id] as const,
  charter: (id: string | undefined) => ['charter', id] as const,
  messages: (id: string | undefined, endpoint: string | null = null) => ['messages', id, endpoint] as const,
  messageHistory: (id: string | undefined, endpoint: string | null = null) => ['message-history', id, endpoint] as const,
  history: (endpoint: string | undefined) => ['history', endpoint] as const,
  turns: (endpoint: string | undefined) => ['turns', endpoint] as const,
  turn: (id: string) => ['turn', id] as const,
  models: (endpoint: string | undefined) => ['models', endpoint] as const,
  telemetryConversation: (group: string | undefined, member: string | undefined, peer: string | undefined) =>
    ['telemetry-conversation', group, member, peer] as const,
  telemetryCoordination: (group: string | undefined) => ['telemetry-coordination', group] as const,
  telemetryManagerConversation: (group: string | undefined, member: string | undefined) =>
    ['telemetry-manager-conversation', group, member] as const,
  telemetryMembers: (group: string | undefined) => ['telemetry-members', group] as const,
  teamDirectives: (group: string | undefined) => ['team-directives', group] as const,
  interactions: (group: string | undefined) => ['interactions', group] as const,
  panelRecords: (bootId: string | undefined, history: boolean) => ['panel-agent', 'records', bootId, history] as const,
  resource: (id: string, resource: string) => ['group', id, resource] as const,
  session: (id: string, endpoint: string) => ['group', id, 'session', endpoint] as const,
};

/** Refresh all active projections after changes spanning team membership or configuration. */
export function invalidateWorkspaceResources(client: QueryClient) {
  return client.invalidateQueries({ predicate: query => ['groups', 'directory', 'group', 'home-summary', 'model-policy', 'panel-agent'].includes(String(query.queryKey[0])) });
}
