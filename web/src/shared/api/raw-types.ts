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

export interface PanelAgent {
  id: string;
  name: string;
  host: string;
  model_provider: string | null;
  model: string | null;
  reasoning_effort: string | null;
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

export interface PanelPreparation {
  id: string;
  spec: {
    name: string;
    workspace: string;
    panelAgentId: string;
    members: Array<{ name: string; host: string }>;
    modelMode?: 'smart' | 'user';
    modelRules?: string;
  };
  contract: {
    goal: string;
    scope: string;
    boundary: string;
    confirmation: string;
    delivery: string;
    policy: string;
    allowShell: boolean;
    criteria: Array<{ id: string; text: string }>;
  } | null;
  revision: number;
  hash: string | null;
  group_id: string | null;
  created: string;
  rolePlan: { roles: Array<{ name: string; model_provider: string | null; model: string; reasoning_effort: string }> } | null;
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
  running: Array<{ endpoint: string; groupId: string | null; turnId: string }>;
  preparations: PanelPreparation[];
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

export type GoalState = 'queued' | 'active' | 'finalizing' | 'completed' | 'terminated' | 'cancelled';

export interface GoalEligibility {
  eligible: boolean;
  blockers: Array<{ code: string; detail: string }>;
}

export interface GoalBody {
  contract: NonNullable<PanelPreparation['contract']>;
  requirements: { requiredMemberIds: string[] };
}

export interface GoalView {
  id: string;
  number: number;
  state: GoalState;
  queuePosition: number | null;
  revision: number;
  cutoffSeq: number | null;
  unconsumedInboxCount: number | null;
  outcome: string | null;
  final: string | null;
  finishReason: string | null;
  originDraftId: string | null;
  contract: GoalBody | null;
  contractHash: string | null;
  created: string;
  started: string | null;
  ended: string | null;
  waitingForCurrent?: boolean;
  eligibility?: GoalEligibility;
}

export interface GoalDraftView {
  id: string;
  revision: number;
  body: GoalBody;
  hash: string;
  state: 'draft' | 'confirmed' | 'deleted';
  goalId: string | null;
  created: string;
  updated: string;
}

export interface TeamGoalsState {
  team: {
    id: string;
    name: string;
    workspace: string;
    state: 'open' | 'archived';
    revision: number;
  };
  current: GoalView | null;
  drafts: GoalDraftView[];
  queue: GoalView[];
  history: GoalView[];
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
