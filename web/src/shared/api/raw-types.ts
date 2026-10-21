export interface Group {
  id: string;
  name: string;
  workspace: string;
  lead: string | null;
  created: string;
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

export interface TeamModelPolicy {
  group_id: string;
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

export interface Snapshot {
  groups: Group[];
  members: Member[];
  endpoints: SessionEndpoint[];
  sessionBindings: SessionBinding[];
  modelPolicies: TeamModelPolicy[];
  modelPolicyDefaults: ModelPolicyDefaults;
  runningEndpoints: string[];
}

export interface SessionBinding {
  endpoint_id: string;
  session_key: string;
  session: string;
  updated: string;
}

export interface CollaborationState {
  legacy: boolean;
  contract: { version: number; hash: string; body: { goal: string; scope: string; boundary: string; confirmation: string; delivery: string; policy: string; allowShell: boolean; criteria: Array<{ id: string; text: string }> } } | null;
  state: { revision: number; goal_version: number; phase: string; outcome: string | null; final: string | null; finish_reason: string | null } | null;
  communicationOpen: boolean;
  items: Array<{ id: string; goalVersion: number; revision: number; state: string; title: string; purpose: string; standard: string; policy: string; allowShell: boolean; reviewRequired: boolean; participants: Array<{ memberId: string; role: string }>; artifact: string | null; evidence: string[]; reviews: Array<{ messageId: string; artifact: string }> }>;
  requests: Array<{ id: string; kind: string; state: string; base_version: number; body: unknown }>;
  records: Array<{ seq: number; work_item_id: string | null; type: string; body: unknown; created: string }>;
  nextAfter?: number;
  unknown: Array<{ turn_id: string; endpoint_id: string; detail: string }>;
  pendingMessages?: Array<{ id: string; text: string }>;
  runningCount?: number;
  outputs?: Array<{ id: string; goalVersion: number; body: string; created: string }>;
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
  kind: 'group' | 'private' | 'system' | 'unknown';
  turnId?: string;
  endpointId?: string;
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
