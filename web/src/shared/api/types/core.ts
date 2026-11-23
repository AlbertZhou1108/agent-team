/**
 * 核心团队域 API 类型:团队、成员、会话、消息、互动、任务、回合轨迹与概览快照。
 * 面板(panel)与设置(settings)域的展示型类型见同目录 peer 文件,此处按需类型导入。
 */
import type { PanelAgent, PanelTeamView, StreamPhase, StreamTool } from './panel';
import type {
  ModelObservation,
  ModelPolicy,
  ModelPolicyDefaults,
  ModelState,
} from './settings';

export interface Group {
  id: string;
  name: string;
  workspace: string;
  lead: string | null;
  created: string;
  state?: 'open' | 'archived';
  revision?: number;
  /** 待生效的工作目录:有成员回合在跑时,切换目录会先挂起。 */
  workspace_pending?: string | null;
  /** 群级文件访问范围(communication / read-only / workspace-write);旧后端可能不返回。 */
  policy?: string | null;
  /** 群级是否允许执行命令(1/0);仅作群上限,成员级还可再收敛。 */
  allow_shell?: number | null;
  /** 团队说明文本（可选）。 */
  charter?: string | null;
  /** 研发工作流引导模板 ID（可选，仅提示与预设，无状态机）。 */
  workflow_template?: string | null;
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
  /** 成员策略上限;null/缺省表示继承群策略,只能比群策略更严。 */
  policy_ceiling?: string | null;
  /** 成员级命令执行授权:1 允许(仍需群级放行),0 拒绝,null 表示继承。 */
  allow_shell?: number | null;
  /** 成员级浏览器 / Computer Use 授权:1 允许,0 或未返回表示未授权。 */
  allow_browser?: number;
  /** 成员工作区隔离模式：inherit 共享群主工作区，worktree 为受管独立工作树。 */
  workspace_mode?: 'inherit' | 'worktree';
  /** 受管 git worktree 路径（仅 worktree 模式有效）。 */
  worktree_path?: string | null;
  /** 受管 git worktree 分支名（仅 worktree 模式有效）。 */
  worktree_branch?: string | null;
  /** 只读能力名片;由服务端按真实模型目录与有效策略投影,前端不自行推断。 */
  capabilityCard?: CapabilityCard;
}

export interface WorkflowTemplatePresetMember {
  name: string;
  roleHint: string;
  preferredHost?: string;
  policyCeiling: string;
  allowShell: boolean;
  allowBrowser: boolean;
  workspaceMode: 'inherit' | 'worktree';
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  summary: string;
  charter: string;
  presetMembers: WorkflowTemplatePresetMember[];
}

export interface MemberWorktreeStatus {
  memberId: string;
  memberName: string;
  host: string;
  path: string | null;
  branch: string | null;
  branchExists: boolean;
  exists: boolean;
  dirtyCount: number;
  untrackedCount: number;
  aheadCount: number;
  headCommit: string | null;
  baseCommit: string | null;
  changedFiles: string[];
  diffStat: string;
  error: string | null;
}

export interface WorktreeMergeResult {
  memberId: string;
  memberName: string;
  merged: boolean;
  alreadyUpToDate: boolean;
  branch: string;
  commit: string | null;
}

export interface WorktreeRemoveResult {
  memberId: string;
  memberName: string;
  removed: boolean;
  retained: boolean;
  path: string | null;
  branch: string | null;
  dirtyCount?: number;
  untrackedCount?: number;
  aheadCount?: number;
  reason?: string;
}

export interface FilePreviewResult {
  path: string;
  rootKind: 'workspace' | 'worktree';
  memberId: string | null;
  memberName: string | null;
  size: number;
  truncated: boolean;
  content: string;
}

/** 能力名片里的模型维投影:未在实时目录中命中时 knownInCatalog=false,未知字段保持 null。 */
export interface CapabilityModelView {
  id: string | null;
  provider: string | null;
  label: string | null;
  knownInCatalog: boolean;
  inputModalities: string[] | null;
  contextWindow: number | null;
  reasoningEffort: string | null;
  reasoningEfforts: string[];
}

/** 模型摘要:宿主 + 供应商 + 模型,只表达事实,不含推断。 */
export interface CapabilityModelSummary {
  host: string | null;
  provider: string | null;
  model: string | null;
  label: string | null;
  knownInCatalog: boolean;
}

/** 有效策略:ceiling 是请求上限,mode 是实际生效档位,reason/browserReason 说明收敛原因。 */
export interface CapabilityEffectivePolicy {
  ceiling: string | null;
  mode: string | null;
  reason?: string | null;
  browserReason?: string | null;
}

/** 执行维与模型模态的真实能力;modal.image 为 unknown 表示宿主目录未声明,不能当作支持。 */
export interface CapabilityEffectiveCapabilities {
  'exec.read': boolean;
  'exec.write': boolean;
  'exec.shell': boolean;
  'modal.image': boolean | 'unknown';
  'tool.browser': boolean;
}

/** 成员只读能力名片(快照 / API 返回)。 */
export interface CapabilityCard {
  memberId: string | null;
  model: CapabilityModelView;
  modelSummary: CapabilityModelSummary;
  effectivePolicy: CapabilityEffectivePolicy;
  effectiveCapabilities: CapabilityEffectiveCapabilities;
  controller?: { kind: string; id: string; name: string | null };
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

export interface TeamRequestReceipt {
  seq: number; id: string; text: string; sourceMessageIds: string[]; created: string; isSourceCopy?: boolean;
}
export interface TeamRequest {
  id: string; group_id: string; source_user_message_id: string; message_id: string; text: string;
  delivery: TeamDirectiveReceipt; receipts: TeamRequestReceipt[];
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
  runningByGroup?: Record<string, number>;
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
  /** 计划步骤的身份；成员任务没有 id。 */
  id?: string;
  text: string;
  state: AgentTaskState;
  /** 成员任务挂靠的计划步骤。 */
  parent?: { planId: string; stepId: string };
}

export interface AgentPlanStep {
  id: string;
  text: string;
  state: AgentTaskState;
}

export interface AgentPlanView {
  plan_id: string;
  group_id: string;
  owner_id: string;
  owner_kind: 'member' | 'panel_agent' | 'external_agent';
  revision: number;
  updated?: string;
  frozen_at?: string;
  steps: AgentPlanStep[];
}

export interface AgentCancelledStep {
  id: string;
  plan_id: string;
  step_id: string;
  text: string;
  source: 'dropped' | 'removed';
  created: string;
  affected: Array<{ owner_id: string; owner_kind: 'member' | 'panel_agent' | 'external_agent' }>;
}

export interface AgentTasksView {
  currentPlan: AgentPlanView | null;
  historicalPlans: AgentPlanView[];
  memberTasks: AgentTaskEntry[];
  cancelledSteps: AgentCancelledStep[];
}

export interface AgentTaskEntry {
  owner_id: string;
  group_id: string;
  owner_kind: 'member' | 'panel_agent' | 'external_agent';
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
  | 'member_model'
  | 'member_policy';

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
  kind: 'takeover' | 'handback' | 'group_create' | 'group_add' | 'group_delete' | 'member_model' | 'member_policy';
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

/** /api/turns 的回合摘要:轨迹页按回合分页的数据源,事件体走 /api/turn 懒加载。 */
export interface TurnSummary {
  id: string;
  state: string;
  created: string;
  ended: string | null;
  /** 全会话稳定序号(最旧=1):向前翻页时编号不漂移。 */
  ordinal: number;
  eventCount: number;
  firstSeq: number;
  lastSeq: number;
  /** 仅失败回合可选返回：从失败事件提取的单行错误摘要。 */
  errorSummary?: string;
}

export interface TurnSummariesResponse {
  /** 最旧在前的一页回合摘要;轨迹页从第一回合正向翻页。 */
  turns: TurnSummary[];
  /** 无回合归属的宿主输出(目前只有会话轮换),量小,随摘要一并返回。 */
  unaffiliated: HistoryRow[];
  /** 还有靠后的回合时,下一页的 after 游标(本页最后一回合的 id)。 */
  nextAfter: string | null;
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

export interface TeamDirectiveReceipt {
  operationId: string;
  messageId: string;
  seq: number;
  /** 接收者 id，不是给人看的。展示名见 recipientName。 */
  recipient: string;
  /** 接收者显示名：接口只给 id，由消息流按同一个 id 补出，不落库。 */
  recipientName?: string | null;
  created: string;
  status: 'queued' | 'delivered' | 'failed' | 'unknown';
  error: string | null;
}

export type RuntimeEndpoint = { id: string; group_id: string; member_id: string };
export type GroupDetail = Group & { controller: PanelTeamView['controller'] };
