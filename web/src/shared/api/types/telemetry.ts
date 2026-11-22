/**
 * 宿主遥测域 API 类型:只读观测(schemaVersion 1)、批次、覆盖度、来源小计与能力矩阵。
 * 不含聚合计算,仅描述 /api/telemetry/* 系列的响应形状。
 */

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
