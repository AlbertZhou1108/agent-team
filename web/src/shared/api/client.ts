import type { PanelMessagePage } from './raw-types';
import type { UnreadProjection, RuntimeEndpoint, GroupDetail, SessionEndpoint, AgentTaskEntry } from './raw-types';
import type {
  AttachmentSettings,
  HostStatus,
  UploadedAttachment,
  Group,
  GroupCommunicationSummary,
  HistoryRow,
  Interaction,
  InteractionAnswer,
  Member,
  MessageTrace,
  ModelCatalogResponse,
  ModelPolicy,
  ModelPolicyPreset,
  MessageRow,
  ModelsPage,
  Overview,
  PanelAccess,
  PanelAgentState,
  Snapshot,
  TeamDirectiveReceipt,
  TelemetryCapabilityResponse,
  TelemetryConversationResponse,
  TelemetryCoordinationResponse,
  TelemetryMembersResponse,
  TelemetryManagerConversationResponse,
  ThemePackRecord,
  TurnTrace,
} from './raw-types';
import type { UserThemePack } from '@/theme/tokens';

/** 服务端主题包行 → 前端包:light/dark JSON 字符串解析失败时丢弃该行(运行时回落内置主题)。 */
function parseThemePackRecord(record: ThemePackRecord): UserThemePack | null {
  try {
    const light = JSON.parse(record.light) as UserThemePack['light'];
    const dark = JSON.parse(record.dark) as UserThemePack['dark'];
    if (!light || typeof light !== 'object' || !dark || typeof dark !== 'object') return null;
    return { id: record.id, name: record.name, light, dark, created: record.created, updated: record.updated };
  } catch {
    return null;
  }
}

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function jsonRequest<T>(path: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
  const timeoutMs = path.includes('/install') || path.includes('/directory-picker') ? 330000
    : path.includes('/model-catalog') ? 60000 : init.method === 'POST' ? 60000 : 15000;
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort(signal?.reason);
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetch(path, { credentials: 'same-origin', ...init, signal: controller.signal });
    if (!response.ok) throw new ApiError(response.status, await response.text());
    return await response.json() as T;
  } catch (error) {
    if (timedOut) throw new Error(init.method === 'POST'
      ? '请求超时，操作可能仍在执行。请刷新状态确认结果，避免重复提交。'
      : '读取超时，请检查本机服务连接后重试。');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  return jsonRequest<T>(path, { headers: { Accept: 'application/json' } }, signal);
}

async function mutate<T>(path: string, body: unknown): Promise<T> {
  return jsonRequest<T>(path, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function throwAttachmentError(response: Response): Promise<never> {
  let message = `请求失败(${response.status})`;
  try {
    const payload = (await response.json()) as { code?: string; error?: string };
    if (payload && typeof payload.error === 'string' && payload.error) message = payload.error;
  } catch {
    // 错误体不是 JSON 时保持默认消息。
  }
  throw new ApiError(response.status, message);
}

function query(path: string, values: Record<string, string | number | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value != null && value !== '') params.set(key, String(value));
  }
  return `${path}?${params.toString()}`;
}

export const api = {
  groups(signal?: AbortSignal) { return request<Group[]>('/api/groups', signal); },
  archivedGroups(signal?: AbortSignal) { return request<Group[]>('/api/groups?archived=1', signal); },
  directory(signal?: AbortSignal) { return request<Pick<Overview, 'members' | 'actors' | 'panelAgent'>>('/api/directory', signal); },
  group(group: string, signal?: AbortSignal) { return request<GroupDetail>(query('/api/group', { group }), signal); },
  sessions(group: string, signal?: AbortSignal) { return request<Pick<Snapshot, 'endpoints' | 'sessionBindings'>>(query('/api/sessions', { group }), signal); },
  session(group: string, endpoint: string, signal?: AbortSignal) { return request<SessionEndpoint>(query('/api/session', { group, endpoint }), signal); },
  sessionTarget(group: string, member: string, context: string) { return request<SessionEndpoint | null>(query('/api/session-target', { group, member, context })); },
  runtime(group: string, signal?: AbortSignal) { return request<RuntimeEndpoint[]>(query('/api/group-runtime', { group }), signal); },
  homeSummary(signal?: AbortSignal) { return request<RuntimeEndpoint[]>('/api/home-summary', signal); },
  tasks(group: string, signal?: AbortSignal) { return request<AgentTaskEntry[]>(query('/api/agent-tasks', { group }), signal); },
  unread(signal?: AbortSignal) { return request<UnreadProjection>('/api/panel-agent/unread', signal); },
  modelPolicy(signal?: AbortSignal) { return request<Overview['modelPolicy']>('/api/model-policy', signal); },
  modelDefaults(signal?: AbortSignal) { return request<Overview['modelPolicyDefaults']>('/api/model-policy/defaults', signal); },

  hostStatuses() { return request<HostStatus[]>('/api/hosts'); },
  hostInstallations() { return request<Array<Pick<HostStatus, 'name' | 'installing' | 'installation'>>>('/api/hosts/installations'); },
  installHost(name: string) { return mutate<HostStatus>(`/api/hosts/${encodeURIComponent(name)}/install`, {}); },
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
  overview(signal?: AbortSignal) {
    return request<Overview>('/api/overview', signal);
  },
  snapshot(signal?: AbortSignal, group?: string) {
    return request<Snapshot>(query('/api/snapshot', { group, scoped: 1 }), signal);
  },
  modelCatalog(refresh = false, signal?: AbortSignal) {
    return request<ModelCatalogResponse>(query('/api/model-catalog', { refresh: refresh ? 1 : undefined }), signal);
  },
  updateModelPolicy(mode: ModelPolicy['mode'], rules: string, presetId?: string | null) {
    return mutate<ModelPolicy>('/api/model-policy', { mode, rules, ...(presetId ? { presetId } : {}) });
  },
  modelPolicyPresets(signal?: AbortSignal) {
    return request<ModelPolicyPreset[]>('/api/model-policy/presets', signal);
  },
  createModelPolicyPreset(body: { name: string; mode: ModelPolicy['mode']; rules: string }) {
    return mutate<ModelPolicyPreset>('/api/model-policy/presets', body);
  },
  renameModelPolicyPreset(id: string, name: string) {
    return mutate<ModelPolicyPreset>(`/api/model-policy/presets/${encodeURIComponent(id)}/rename`, { name });
  },
  saveModelPolicyPreset(id: string, body: { mode: ModelPolicy['mode']; rules: string }) {
    return mutate<ModelPolicyPreset>(`/api/model-policy/presets/${encodeURIComponent(id)}/save`, body);
  },
  deleteModelPolicyPreset(id: string) {
    return mutate<{ deleted: string }>(`/api/model-policy/presets/${encodeURIComponent(id)}/delete`, {});
  },
  themePacks(signal?: AbortSignal) {
    return request<ThemePackRecord[]>('/api/theme-packs', signal).then(rows =>
      rows
        .map(parseThemePackRecord)
        .filter((pack): pack is UserThemePack => pack !== null),
    );
  },
  createThemePack(body: { name: string; light: string; dark: string }) {
    return mutate<ThemePackRecord>('/api/theme-packs', body);
  },
  deleteThemePack(id: string) {
    return mutate<{ deleted: string }>(`/api/theme-packs/${encodeURIComponent(id)}/delete`, {});
  },
  attachmentSettings(signal?: AbortSignal) {
    return request<AttachmentSettings>('/api/settings/attachments', signal);
  },
  updateAttachmentSettings(body: { maxFileBytes: number; maxFilesPerMessage: number; maxImagePixels: number }) {
    return mutate<AttachmentSettings>('/api/settings/attachments', body);
  },
  // 附件路由返回稳定 {code,error};这里安全解析,前端只展示 error 文本。
  attachmentUrl(id: string) {
    return `/api/panel-agent/attachments/${encodeURIComponent(id)}`;
  },
  async uploadAttachment(file: File, signal?: AbortSignal): Promise<UploadedAttachment> {
    const response = await fetch('/api/panel-agent/attachments', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        'X-Agent-Team-Filename': encodeURIComponent(file.name),
      },
      body: file,
      signal,
    });
    if (!response.ok) await throwAttachmentError(response);
    return (await response.json()) as UploadedAttachment;
  },
  async discardAttachment(id: string): Promise<void> {
    const response = await fetch(this.attachmentUrl(id), { method: 'DELETE', credentials: 'same-origin' });
    if (!response.ok) await throwAttachmentError(response);
  },
  panelAgent(signal?: AbortSignal, summary = false) {
    return request<PanelAgentState>(query('/api/panel-agent', { summary: summary ? 1 : undefined, current: 1 }), signal);
  },
  panelRecords(history: boolean, before?: number, signal?: AbortSignal) { return request<PanelMessagePage>(query('/api/panel-agent/records', { history: history ? 1 : undefined, before }), signal); },
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
  panelMessage(text: string, activeTeamId?: string | null, options: { clientMessageId?: string; attachmentIds?: string[] } = {}) {
    return mutate<{ reply: unknown; result: unknown; activeTeamId?: string | null; message?: unknown }>('/api/panel-agent/messages', {
      text,
      activeTeamId: activeTeamId ?? null,
      ...(options.clientMessageId ? { clientMessageId: options.clientMessageId } : {}),
      ...(options.attachmentIds?.length ? { attachmentIds: options.attachmentIds } : {}),
    });
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
  interactions(group: string, signal?: AbortSignal) {
    return request<Interaction[]>(query('/api/interactions', { group }), signal);
  },
  updateMemberModel(groupId: string, memberId: string, body: { model_provider?: string | null; model?: string | null; reasoning_effort?: string | null }) {
    return mutate<Member>(`/api/teams/${encodeURIComponent(groupId)}/members/${encodeURIComponent(memberId)}/model`, body);
  },
  panelInteractions(signal?: AbortSignal) {
    return request<Interaction[]>(query('/api/interactions', { panel: 1 }), signal);
  },
  answerInteraction(id: string, answer: InteractionAnswer) {
    return mutate<Interaction>('/api/interactions/' + encodeURIComponent(id) + '/answer', { answer });
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
