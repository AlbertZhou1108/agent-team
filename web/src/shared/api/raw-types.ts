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

export interface SessionEndpoint {
  id: string;
  group_id: string;
  member_id: string;
  context: string;
  peer: string | null;
  session: string | null;
  modelState: ModelState;
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

export interface PanelAgentState {
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
  running: Array<{ endpoint: string; groupId: string | null; turnId: string }>;
  actions: Array<{
    id: string;
    panel_agent_id: string;
    group_id: string;
    action: 'takeover' | 'handback';
    base_revision: number;
    state: 'pending' | 'confirmed' | 'dismissed' | 'failed';
    detail: string | null;
    created: string;
    updated: string;
  }>;
  unknown: Array<{ turn_id: string; group_id: string | null; detail?: string }>;
}

export interface Snapshot {
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
  endpoints: SessionEndpoint[];
  sessionBindings: SessionBinding[];
  modelPolicy: ModelPolicy;
  modelPolicyDefaults: ModelPolicyDefaults;
  runningEndpoints: string[];
  panelRunning: Array<{ endpoint: string; groupId: string | null; turnId: string }>;
  panelUnknown: Array<{ turn_id: string; group_id: string | null; detail?: string }>;
  groupStates: GroupStateRow[];
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
}

export interface HistoryRow {
  seq: number;
  endpoint_id: string;
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
}

export interface PanelStream {
  agentId: string;
  sessionId: string;
  turnId: string;
  context: 'private' | 'coordination';
  activeTeamId: string | null;
  text: string;
  reasoning?: string;
  created: string;
  updatedAt: string;
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
    group_id: string;
    member_id: string;
    context: string;
    peer: string | null;
  };
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

// ---- 宿主遥测只读观测（docs/host-telemetry-api-contract.md, schemaVersion 1） ----

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
