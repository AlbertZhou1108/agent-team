export interface Group {
  id: string;
  name: string;
  workspace: string;
  lead: string | null;
  created: string;
  state?: 'open' | 'archived';
  revision?: number;
}

export interface Member {
  id: string;
  group_id: string;
  name: string;
  host: string;
  role: 'lead' | 'member';
  profile: string;
  removed: string | null;
  model_provider: string | null;
  model: string | null;
  reasoning_effort: string | null;
}

export interface ModelObservation {
  seq: number;
  created: string;
  turnId: string | null;
  type: 'framework.model';
  phase: string;
  model?: string | null;
  models?: string[];
  provider?: string | null;
  reasoningEffort?: string | null;
  source: string;
}

export interface ModelSummary {
  model?: string | null;
  models?: string[];
  reasoningEffort?: string | null;
  phase?: string;
  source?: string;
  seq?: number;
  turnId?: string;
}

export interface ModelState {
  currentModel: ModelSummary | null;
  currentReasoningEffort: ModelSummary | null;
}

export interface CatalogReasoningEffort {
  id: string;
  label: string;
  description?: string;
}

export interface CatalogModel {
  key: string;
  id: string;
  label: string;
  provider?: string;
  description?: string;
  inputModalities?: string[];
  contextWindow?: number;
  reasoningEfforts: CatalogReasoningEffort[];
  defaultReasoningEffort?: string;
  isDefault: boolean;
}

export interface HostModelCatalog {
  version: number;
  host: string;
  source: string;
  defaultModel: string | null;
  reasoningEfforts: CatalogReasoningEffort[];
  models: CatalogModel[];
}

export interface ModelCatalogResponse {
  version: number;
  generatedAt: string;
  cached: boolean;
  hosts: Array<{
    host: string;
    ok: boolean;
    catalog?: HostModelCatalog;
    error?: string;
  }>;
}

export interface ModelPolicy {
  mode: 'smart' | 'user';
  rules: string;
  /** 激活策略的来源配置 id;手动编辑规则时为 null。 */
  preset_id?: string | null;
  created: string;
  updated: string;
}

export interface ModelPolicyPreset {
  id: string;
  name: string;
  mode: 'smart' | 'user';
  rules: string;
  created: string;
  updated: string;
}

/** 服务端存储的主题包:light/dark 是 JSON 字符串,由 client 层解析后交付。 */
export interface ThemePackRecord {
  id: string;
  name: string;
  light: string;
  dark: string;
  created: string;
  updated: string;
}

export interface ModelPolicyDefaults {
  smart: {
    performance: string;
    cost: string;
  };
  user: string;
}

/** 附件上传设置:API 始终传字节/像素/个数,前端负责 MiB/MP 单位换算;从未保存时 updated 为 null。 */
export interface AttachmentSettings {
  maxFileBytes: number;
  maxFilesPerMessage: number;
  maxImagePixels: number;
  updated: string | null;
}

/** 附件上传响应:只含展示元数据,不含本机路径或存储名。 */
export interface UploadedAttachment {
  id: string;
  name: string;
  mediaType: string;
  size: number;
}

/** 消息附件 DTO:服务端按文件现状给出 availability;不含路径或存储名。 */
export interface MessageAttachment {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  availability: 'available' | 'missing';
}

export interface PanelMessage {
  seq: number;
  id: string;
  panel_agent_id: string;
  context: 'private' | 'coordination';
  role: 'user' | 'assistant' | 'system';
  text: string;
  active_team_id: string | null;
  created: string;
  attachments?: MessageAttachment[];
}

export interface SessionEndpoint {
  id: string;
  group_id: string;
  member_id: string;
  context: string;
  peer: string | null;
  session: string | null;
  modelState?: ModelState;
}

export type PanelAccess = 'read-only' | 'workspace-write' | 'full-access';

export interface PanelAgent {
  id: string;
  name: string;
  host: string;
  model_provider: string | null;
  model: string | null;
  reasoning_effort: string | null;
  workspace: string | null;
  access: PanelAccess;
  created: string;
  updated: string;
}

export interface PanelTeamView extends Group {
  relation: 'observer' | 'main';
  controller: {
    kind: 'member' | 'panel_agent';
    id: string;
    name: string;
    assignment?: {
      revision: number;
      state: 'active' | 'suspended';
      original_lead_id: string | null;
    } | null;
  };
}

export interface PanelMessage {
  seq: number;
  id: string;
  panel_agent_id: string;
  context: 'private' | 'coordination';
  role: 'user' | 'assistant' | 'system';
  text: string;
  active_team_id: string | null;
  created: string;
}

export interface TeamRequestReceipt {
  seq: number; id: string; text: string; sourceMessageIds: string[]; created: string; isSourceCopy?: boolean;
}
export interface TeamRequest {
  id: string; group_id: string; source_user_message_id: string; message_id: string; text: string;
  delivery: TeamDirectiveReceipt; receipts: TeamRequestReceipt[];
}

export interface PanelAgentState {
  bootId?: string;
  bootSeq?: number;
  requests?: TeamRequest[];
  teamPendingInteractions?: Record<string, number>;
  notifications?: Array<{ id: string; group_id: string; text: string; sourceMessageIds: string[] }>;
  agent: PanelAgent | null;
  sessions: Array<{
    id: string;
    context: 'private' | 'coordination';
    group_id: string | null;
    session: string | null;
    updated: string;
  }>;
  teams: PanelTeamView[];
  conversation: PanelMessage[];
  streaming?: PanelStream[];
  running: Array<{ endpoint: string; groupId: string | null; turnId: string; created?: string | null }>;
  unknown: Array<{ turn_id: string; group_id: string | null; detail?: string }>;
}

/** 与当前团队无关的全局数据;切换团队不会重新加载。 */
export interface Overview {
  groups: Group[];
  members: Member[];
  panelAgent: PanelAgent | null;
  panelTeams: PanelTeamView[];
  actors: Array<{
    id: string;
    name: string;
    host?: string;
    model_provider?: string | null;
    model?: string | null;
    reasoning_effort?: string | null;
  }>;
  modelPolicy: ModelPolicy;
  modelPolicyDefaults: ModelPolicyDefaults;
  groupStates: GroupStateRow[];
}

export interface Snapshot extends Overview {
  endpoints: SessionEndpoint[];
  sessionBindings: SessionBinding[];
  runningEndpoints: string[];
  panelRunning: Array<{ endpoint: string; groupId: string | null; turnId: string }>;
  panelUnknown: Array<{ turn_id: string; group_id: string | null; detail?: string }>;
  agentTasks: AgentTaskEntry[];
}

export type AgentTaskState = 'doing' | 'done' | 'dropped';

export interface AgentTask {
  text: string;
  state: AgentTaskState;
}

export interface AgentTaskEntry {
  owner_id: string;
  group_id: string;
  owner_kind: 'member' | 'panel_agent';
  tasks: AgentTask[];
  updated: string;
}

export interface SessionBinding {
  endpoint_id: string;
  session_key: string;
  session: string;
  updated: string;
}

export interface GroupStateRow {
  id: string;
  state: 'archived' | null;
  charter: string | null;
  policy: string;
  allow_shell: number;
}

export interface GroupCommunicationSummary {
  communicationOpen: boolean;
  unknown: Array<{ turn_id: string; endpoint_id: string; detail: string }>;
  runningCount: number;
}

export interface MessageRow {
  seq: number;
  id: string;
  group_id: string;
  sender: string;
  recipient: string;
  kind: 'send' | 'note' | 'system';
  text: string;
  reply_to: string | null;
  created: string;
  /** 产出这条消息的回合;用户/系统消息为 null。一个回合可产出多条消息。 */
  turn_id?: string | null;
}

export type InteractionKind =
  | 'choice'
  | 'input'
  | 'flow'
  | 'takeover'
  | 'handback'
  | 'group_create'
  | 'group_add'
  | 'group_delete'
  | 'member_model';

/** 卡片即唯一展示面:锚点消息只为答复线程与群记录存在,不再渲染正文。 */
interface InteractionCardFlag {
  cardOnly?: boolean;
}

export interface InteractionChoicePayload extends InteractionCardFlag {
  kind: 'choice';
  text: string;
  options: string[];
}

export interface InteractionInputPayload extends InteractionCardFlag {
  kind: 'input';
  text: string;
}

/** 多步提问:步骤自上而下推进,已答步骤带 answer。 */
export interface InteractionFlowStep {
  kind: 'choice' | 'input';
  text: string;
  options?: string[];
  answer?: { selected?: string; value?: string } | null;
}

export interface InteractionFlowPayload extends InteractionCardFlag {
  kind: 'flow';
  text: string;
  steps: InteractionFlowStep[];
}

export interface InteractionActionPayload extends InteractionCardFlag {
  kind: 'takeover' | 'handback' | 'group_create' | 'group_add' | 'group_delete' | 'member_model';
  text: string;
  groupId?: string;
  baseRevision?: number;
  /** 动作参数原样回传给执行器(member_model / group_add / group_create 用)。 */
  args?: Record<string, unknown>;
}

export type InteractionPayload =
  | InteractionChoicePayload
  | InteractionInputPayload
  | InteractionFlowPayload
  | InteractionActionPayload;

export type InteractionAnswer =
  | { selected: string }
  | { value: string }
  | { approved: boolean }
  | { answers: Array<{ selected?: string; value?: string }> };

/** 多步卡片的整卡提交:answers 与 steps 一一对应,缺一或越界都由后端整体拒绝。 */
export interface InteractionFlowSubmission {
  answers: Array<{ selected: string } | { value: string }>;
}

export interface Interaction {
  id: string;
  group_id: string | null;
  member_id: string | null;
  panel_agent_id: string | null;
  endpoint_id: string | null;
  context: string;
  turn_id: string;
  call_id: string;
  /** 卡片锚点消息:成员/协作互动为群消息 id,Panel 私聊互动为 panel_messages id。 */
  message_id: string | null;
  panel_message_id: string | null;
  kind: InteractionKind;
  payload: InteractionPayload;
  state: 'pending' | 'answered' | 'cancelled' | 'failed';
  answer: InteractionAnswer | null;
  detail: string | null;
  answer_message_id: string | null;
  created: string;
  answered: string | null;
}

export interface HistoryRow {
  seq: number;
  /** 服务端字段名(v7 起 history 表按会话归属,列名 conversation_id)。 */
  conversation_id: string;
  event: string;
  created: string;
  turn_id: string | null;
}

export interface ModelsPage extends ModelState {
  observations: ModelObservation[];
  nextAfter: number;
}

export interface MessageSource {
  kind: 'group' | 'panel' | 'private' | 'system' | 'unknown';
  turnId?: string;
  endpointId?: string | null;
  panelAgentId?: string;
  groupId?: string;
  eventSeq?: number;
  callId?: string;
  nativeCallId?: string | null;
}

export interface MessageTrace {
  messageId: string;
  source: MessageSource;
  inputAttempts: Array<{
    id: string;
    endpoint_id: string;
    session: string | null;
    created: string;
  }>;
  /** 产出这条消息的事件段;仅 segment=1 时返回。 */
  segment?: {
    startSeq: number;
    endSeq: number;
    events: HistoryRow[];
  } | null;
  /** 该消息所属回合的级事实;仅 segment=1 且有回合时返回。 */
  turn?: {
    id: string;
    state: string;
    created: string;
    ended: string | null;
    host: string | null;
    group_id: string | null;
    endpoint_id: string | null;
  } | null;
}

export interface PanelStream {
  homeSummary?: boolean;
  sourceUserMessageId?: string | null;
  agentId: string;
  sessionId: string;
  turnId: string;
  context: 'private' | 'coordination';
  activeTeamId: string | null;
  text: string;
  reasoning?: string;
  /** 服务端维护的回合阶段;旧服务端缺失时前端回落到内容判断。 */
  runPhase?: StreamPhase;
  tool?: StreamTool | null;
  created: string;
  updatedAt: string;
}

export type StreamPhase = 'accepted' | 'thinking' | 'writing' | 'tool';

export interface StreamTool {
  name: string;
  groupId?: string | null;
}

export interface TeamStream {
  id: string;
  groupId: string;
  endpointId: string;
  memberId: string;
  memberName: string;
  recipientName: string;
  pairKey: string;
  kind: 'reply' | 'message';
  messageKind?: 'send' | 'note';
  host: string;
  context: string;
  turnId: string;
  toolCallId?: string;
  messageId?: string;
  messageSeq?: number;
  phase?: 'streaming' | 'complete';
  /** 回合阶段(思考/输出/工具);与上面的 streaming/complete 生命周期独立。 */
  runPhase?: StreamPhase;
  tool?: StreamTool | null;
  text: string;
  reasoning?: string;
  created: string;
  updatedAt: string;
}

export interface TurnTrace extends ModelState {
  turn: {
    id: string;
    endpoint_id: string;
    session: string | null;
    created: string;
    /** 回合结束时间;仍在运行时为 null。 */
    ended: string | null;
    /** 回合状态真值,不依赖事件是否被截断。 */
    state: string;
    group_id: string;
    member_id: string;
    context: string;
    peer: string | null;
    /** 执行者宿主:决定按哪套 schema 解释事件。 */
    host: string | null;
  };
  /** 该回合的事件总数;events 只含本页,二者不等即表示被截断。 */
  eventCount: number;
  nativeTurnRefs: string[];
  inputMessages: Array<{ id: string; kind: string; ordinal: number }>;
  outgoingMessages: Array<{
    message_id: string;
    event_seq: number | null;
    call_id: string;
    native_call_id: string | null;
  }>;
  modelObservations: ModelObservation[];
  events: HistoryRow[];
  nextAfter: number;
}

// ---- 宿主遥测只读观测（schemaVersion 1） ----

export type TelemetryQuality =
  | 'host_reported'
  | 'derived'
  | 'measured'
  | 'estimated'
  | 'unknown';

export type TelemetryCompleteness = 'complete' | 'partial' | 'unknown';

export type TelemetryMetricScope =
  | 'request'
  | 'step'
  | 'turn'
  | 'session'
  | 'query'
  | 'unknown';

export type TelemetryAggregation =
  | 'delta'
  | 'cumulative'
  | 'snapshot'
  | 'sum'
  | 'ratio'
  | 'unknown';

export type TelemetryMissingReason =
  | 'unsupported'
  | 'not_reported_by_host'
  | 'not_captured'
  | 'scope_mismatch'
  | 'dependency_missing'
  | 'not_applicable'
  | 'anomaly';

export interface TelemetryMetric {
  value: number | null;
  quality: TelemetryQuality;
  completeness: TelemetryCompleteness;
  scope: TelemetryMetricScope;
  aggregation: TelemetryAggregation;
  source: string;
  observedAt: string | null;
  formula?: string;
  missingReason?: TelemetryMissingReason | null;
}

export interface TelemetryMetrics {
  inputTokensTotal: TelemetryMetric;
  uncachedInputTokens: TelemetryMetric;
  cacheReadTokens: TelemetryMetric;
  cacheWriteTokens: TelemetryMetric;
  outputTokens: TelemetryMetric;
  totalTokens: TelemetryMetric;
  cacheReadRatio: TelemetryMetric;
  executionWallMs: TelemetryMetric;
  hostTurnWallMs: TelemetryMetric;
}

export interface TelemetryContextReference {
  lastRequestInputTokens: TelemetryMetric;
  contextWindowTokens: TelemetryMetric;
  lastRequestInputRatio: TelemetryMetric;
  sampledAt: string | null;
  sampleTurnId: string | null;
  model: {
    provider: string | null;
    model: string;
    source: string;
    observedAt: string;
  } | null;
}

export type TelemetryExecutorKind = 'member' | 'panel_agent';

export interface TelemetryExecutor {
  kind: TelemetryExecutorKind;
  memberId: string;
  name: string;
  host: string;
}

export interface TelemetryPhysicalSession {
  instanceId: string;
  host: string;
  endpointId: string;
  memberId: string;
  context: 'pair' | 'coordination' | 'panel-coordination';
  peer: string | null;
  sessionKey: string;
  hostSessionNamespace: string;
  hostSessionId: string | null;
  firstObservedAt: string | null;
  resetAt: string | null;
}

export interface TelemetryCoverage {
  captureStartedAt: string | null;
  complete: boolean;
  reasons: Array<
    | 'no_observations'
    | 'partial_capture'
    | 'missing_usage'
    | 'failed_attempt'
    | 'session_reset'
    | 'anomaly'
    | 'model_route_mismatch'
  >;
  batchCount: number;
  completeBatchCount: number;
  partialBatchCount: number;
  unknownBatchCount: number;
}

export interface TelemetrySessionTelemetry extends TelemetryPhysicalSession {
  status: 'active' | 'ended' | 'reset' | 'unknown';
  consumption: TelemetryMetrics;
  contextReference: TelemetryContextReference;
  coverage: TelemetryCoverage;
}

export interface TelemetryProvenance {
  eventSeq: number | null;
  source: string;
  observedAt: string | null;
  scope: TelemetryMetricScope;
  aggregation: TelemetryAggregation;
  nativeTurnId: string | null;
  stepId: string | null;
  requestId: string | null;
}

export interface TelemetryAnomaly {
  code:
    | 'negative_value'
    | 'total_mismatch'
    | 'count_regression'
    | 'session_identity_ambiguous'
    | 'overlapping_sources';
  fields: string[];
  detail: string;
  observedAt: string | null;
  raw: Record<string, number | string | null>;
}

export interface TelemetryInputBatch {
  batchId: string;
  kind: 'single_source' | 'merged_delivery';
  messages: Array<{
    messageId: string;
    senderId: string;
    senderName: string;
    ordinal: number;
    role: 'primary' | 'additional' | 'note';
  }>;
  sourceActors: Array<{
    actorId: string;
    actorName: string;
    kind: TelemetryExecutorKind | 'user';
    messageIds: string[];
  }>;
  merge: {
    merged: boolean;
    sharedSources: boolean;
    sourceCount: number;
    countedOnce: true;
    splitBySource: false;
    exclusiveSubtotal: boolean;
  };
  allocation: 'whole_to_executor';
}

export interface TelemetryBatch {
  batchId: string;
  frameworkTurnId: string;
  executor: TelemetryExecutor;
  physicalSession: TelemetryPhysicalSession;
  inputBatch: TelemetryInputBatch;
  state: 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  startedAt: string | null;
  endedAt: string | null;
  attempts: Array<{
    attemptId: string;
    state: 'succeeded' | 'failed' | 'cancelled' | 'unknown';
    hostTurnRef: string | null;
    observedAt: string | null;
    completeness: TelemetryCompleteness;
    metrics: TelemetryMetrics | null;
  }>;
  metrics: TelemetryMetrics;
  contextReference: TelemetryContextReference;
  completeness: TelemetryCompleteness;
  anomalies: TelemetryAnomaly[];
  provenance: TelemetryProvenance[];
}

export interface TelemetrySourceSubtotal {
  sourceActorId: string;
  sourceActorName: string;
  totals: TelemetryMetrics;
  includedBatchIds: string[];
  excludedMergedBatchIds: string[];
}

export interface TelemetryConversationResponse {
  schemaVersion: 1;
  readOnly: true;
  groupId: string;
  generatedAt: string;
  range: { from: string | null; to: string | null };
  conversation: {
    participantIds: [string, string];
    participants: Array<{ memberId: string; name: string; host: string }>;
  };
  executors: Array<{
    executor: TelemetryExecutor;
    physicalSessions: TelemetrySessionTelemetry[];
    batchCount: number;
    totals: TelemetryMetrics;
    contextReference: TelemetryContextReference;
    coverage: TelemetryCoverage;
  }>;
  batches: TelemetryBatch[];
  nextCursor: string | null;
  summary: {
    singleSourceBatchIds: string[];
    mergedBatchIds: string[];
    sharedSourceBatchIds: string[];
    sourceSubtotals: TelemetrySourceSubtotal[];
    coverage: TelemetryCoverage;
  };
  provenance: TelemetryProvenance[];
}

// ---- 成员 ↔ 主 Agent（Panel Agent）用量视图（增量契约 base=a54a62） ----

export interface TelemetryOutgoingMessage {
  messageId: string;
  recipientId: string;
  recipientName: string;
  recipientKind: 'member' | 'user' | 'panel_agent' | 'other';
  kind: 'send' | 'note';
  createdAt: string | null;
}

export interface TelemetryManagerBatchInvolvement {
  involvedMemberIds: string[];
  exclusiveToMember: boolean;
  sharedWithOtherMembers: boolean;
}

export interface TelemetryManagerBatch extends TelemetryBatch {
  side: 'member' | 'manager';
  outgoingMessages: TelemetryOutgoingMessage[];
  involvement: TelemetryManagerBatchInvolvement | null;
}

export interface TelemetryManagerConversationResponse {
  schemaVersion: 1;
  readOnly: true;
  groupId: string;
  generatedAt: string;
  range: { from: string | null; to: string | null };
  member: {
    memberId: string;
    name: string;
    host: string;
  };
  manager: TelemetryExecutor;
  memberSide: {
    totals: TelemetryMetrics;
    contextReference: TelemetryContextReference;
    coverage: TelemetryCoverage;
    batchCount: number;
    physicalSessions: TelemetrySessionTelemetry[];
  };
  managerSide: {
    involvementTotals: TelemetryMetrics;
    exclusiveBatchIds: string[];
    sharedBatchIds: string[];
    involvedMemberIds: string[];
    batchCount: number;
    physicalSessions: TelemetrySessionTelemetry[];
    contextReference: TelemetryContextReference;
    coverage: TelemetryCoverage;
  };
  batches: TelemetryManagerBatch[];
  nextCursor: string | null;
  summary: {
    memberBatchIds: string[];
    managerBatchIds: string[];
    exclusiveManagerBatchIds: string[];
    sharedManagerBatchIds: string[];
    note: string;
  };
  provenance: TelemetryProvenance[];
}

export interface TelemetryCoordinationResponse {
  schemaVersion: 1;
  readOnly: true;
  groupId: string;
  generatedAt: string;
  range: { from: string | null; to: string | null };
  coordination: {
    executor: TelemetryExecutor;
    physicalSessions: TelemetrySessionTelemetry[];
  } | null;
  batches: TelemetryBatch[];
  nextCursor: string | null;
  summary: {
    executorTotals: TelemetryMetrics;
    contextReference: TelemetryContextReference;
    singleSourceBatchIds: string[];
    mergedBatchIds: string[];
    sharedSourceBatchIds: string[];
    sourceSubtotals: TelemetrySourceSubtotal[];
    coverage: TelemetryCoverage;
  };
  provenance: TelemetryProvenance[];
}

export interface TelemetryMembersResponse {
  schemaVersion: 1;
  readOnly: true;
  groupId: string;
  generatedAt: string;
  range: { from: string | null; to: string | null };
  members: Array<{
    executor: TelemetryExecutor;
    physicalSessions: TelemetrySessionTelemetry[];
    physicalSessionCount: number;
    batchCount: number;
    totals: TelemetryMetrics;
    contextReference: TelemetryContextReference;
    coverage: TelemetryCoverage;
  }>;
  sourceAnalysis: {
    note: string;
    actors: Array<{
      sourceActorId: string;
      sourceActorName: string;
      totals: TelemetryMetrics;
      includedBatchIds: string[];
      excludedMergedBatchIds: string[];
    }>;
    mergedBatchIds: string[];
    sharedSourceBatchIds: string[];
  };
  provenance: TelemetryProvenance[];
}

export type TelemetryCapability = 'direct' | 'derived' | 'unsupported';

export interface TelemetryCapabilityResponse {
  schemaVersion: 1;
  readOnly: true;
  groupId: string;
  generatedAt: string;
  hosts: Array<{
    host: string;
    metrics: Record<
      keyof TelemetryMetrics | 'lastRequestInputTokens' | 'contextWindowTokens' | 'lastRequestInputRatio',
      {
        capability: TelemetryCapability;
        source: string;
        requires: string[];
        completenessConditions: string[];
        note: string | null;
      }
    >;
  }>;
}

export interface TeamDirectiveReceipt {
  operationId: string;
  messageId: string;
  seq: number;
  recipient: string;
  created: string;
  status: 'queued' | 'delivered' | 'failed' | 'unknown';
  error: string | null;
}
export interface HostStatus {
  name: string;
  status: 'available' | 'missing' | 'error' | 'checking' | 'unchecked';
  reason?: string;
  installing?: boolean;
  installation?: { phase: 'checking' | 'installing' | 'verifying' | 'completed' | 'failed'; reason?: string };
}

export type UnreadMessage = Pick<PanelMessage, 'seq' | 'role' | 'active_team_id'>;
export type UnreadReceipt = Pick<TeamRequestReceipt, 'id' | 'isSourceCopy' | 'sourceMessageIds'>;
export interface UnreadProjection { messages: UnreadMessage[]; receipts: UnreadReceipt[] }
export type RuntimeEndpoint = { id: string; group_id: string; member_id: string };
export type GroupDetail = Group & { controller: PanelTeamView['controller'] };

export interface PanelMessagePage { messages: PanelMessage[]; nextBefore: number | null; bootId: string }

export interface ArchiveSnapshot {
  id: string;
  group_id: string;
  created: string;
  summary: string | null;
  summary_created: string | null;
  error: string | null;
  generating: boolean;
  facts: {
    group: { name: string; charter: string | null };
    members: { id: string; name: string; host: string; role: string; profile: string | null; removed: string | null }[];
    panelAgent: { id: string; name: string } | null;
    tasks: { owner_id: string; tasks: { text: string; state: 'doing' | 'done' | 'dropped' }[]; updated: string }[];
    messages: { id: string; sender: string; recipient: string; kind: string; text: string; reply_to: string | null; expects_reply: number; created: string }[];
    panelMessages: { id: string; role: string; text: string; created: string }[];
    interactions: { id: string; state: string; payload: { text?: string; options?: string[] }; answer: { value?: string; selected?: string; approved?: boolean } | null; created: string }[];
  };
}

// 随心记：用户的私人想法。服务端只落内容与三态，不记录任何执行状态。
export type NoteState = 'active' | 'done' | 'archived';

export interface NoteTodo {
  text: string;
  done: boolean;
}

export interface Note {
  id: string;
  title: string;
  titleManual: boolean;
  body: string;
  todos: NoteTodo[];
  due: string | null;
  state: NoteState;
  /** 来源团队：记下这条笔记时所在的团队；null 表示无来源。不是归属，团队删了笔记还在。 */
  sourceTeamId: string | null;
  /** 团队当前名字；团队已删除时为 null，由界面显示「团队已删除」。 */
  sourceTeamName: string | null;
  revision: number;
  created: string;
  updated: string;
  completed: string | null;
  archived: string | null;
}

export interface NoteCounts {
  active: number;
  done: number;
  archived: number;
}

export interface NotePage {
  notes: Note[];
  nextCursor: string | null;
  counts: NoteCounts;
}
