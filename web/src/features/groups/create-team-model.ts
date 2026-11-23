import type { CreateGroupBody, GroupMemberInput } from '@/shared/api/client';
import type { AvailableHost } from '@/features/panel-agent/types';
import type { Group, WorkflowTemplate } from '@/shared/api/raw-types';
import { policyLabel } from './team-summary';

/**
 * /groups/new 建群矩阵的纯逻辑:草稿形状、策略上限收敛、预设成员与提交体。
 * 组件只负责交互与展示,提交 payload 与钳位规则集中在这里,便于单测直接断言。
 */

export type PolicyMode = 'communication' | 'read-only' | 'workspace-write';

/** 策略等级:communication 最严,workspace-write 最松;成员上限只能向下收敛。 */
const POLICY_RANKS: Record<PolicyMode, number> = {
  communication: 0,
  'read-only': 1,
  'workspace-write': 2,
};

export const POLICY_MODES: PolicyMode[] = ['communication', 'read-only', 'workspace-write'];

export function isPolicyMode(value: unknown): value is PolicyMode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(POLICY_RANKS, value);
}

export function policyRank(policy: string): number {
  return isPolicyMode(policy) ? POLICY_RANKS[policy] : -1;
}

/** 契约中的成员行:空字符串表示继承(继承默认宿主 / 继承群策略 / 宿主默认模型)。 */
export interface DraftMember {
  id: string;
  name: string;
  host: string;
  model_provider: string;
  model: string;
  reasoning_effort: string;
  policyCeiling: string;
  allowBrowser: boolean;
  workspaceMode: 'inherit' | 'worktree';
}

export interface TeamDraft {
  operationId: string;
  name: string;
  text: string;
  charter: string;
  workflowTemplate: string;
  workspace: string;
  host: string;
  policy: string;
  allowShell: boolean;
  lead: DraftMember;
  members: DraftMember[];
}

export interface DraftState extends TeamDraft {
  submitted: boolean;
  group: Group | null;
}

let memberIdSeed = 0;
function memberId(): string {
  const value = globalThis.crypto?.randomUUID?.();
  if (value) return value;
  memberIdSeed += 1;
  return `draft-member-${memberIdSeed}`;
}

export function newDraftMember(overrides: Partial<DraftMember> = {}): DraftMember {
  return {
    id: memberId(),
    name: '',
    host: '',
    model_provider: '',
    model: '',
    reasoning_effort: '',
    policyCeiling: '',
    allowBrowser: false,
    workspaceMode: 'inherit',
    ...overrides,
  };
}

export function createEmptyDraft(): TeamDraft {
  return {
    operationId: memberId(),
    name: '',
    text: '',
    charter: '',
    workflowTemplate: '',
    workspace: '',
    host: '',
    policy: 'workspace-write',
    allowShell: true,
    lead: newDraftMember({ name: '主 Agent' }),
    // 保持旧版默认组合:主 Agent + 一位协作助手;删掉该行即可只建主 Agent。
    members: [newDraftMember({ name: '协作助手' })],
  };
}

/** 成员上限超出群策略时回到继承(空字符串);未超出的更严档位原样保留。 */
export function clampPolicyCeiling(ceiling: string, groupPolicy: string): string {
  if (!ceiling || !isPolicyMode(ceiling)) return '';
  if (policyRank(ceiling) > policyRank(groupPolicy)) return '';
  return ceiling;
}

/** 可选成员上限:只出现严格严于群策略的档位,默认项「继承群策略」由组件补上。 */
export function policyCeilingOptions(groupPolicy: string): PolicyMode[] {
  const rank = policyRank(groupPolicy);
  return POLICY_MODES.filter(mode => policyRank(mode) < rank).reverse();
}

/** 当前行的生效策略:显式上限与群策略取更严者。 */
export function effectivePolicy(row: DraftMember, groupPolicy: string): string {
  return clampPolicyCeiling(row.policyCeiling, groupPolicy) || groupPolicy;
}

/** 群策略为仅沟通时浏览器 / Computer Use 一律不可授权。 */
export function browserRestrictedReason(groupPolicy: string): string | null {
  return groupPolicy === 'communication' ? '仅沟通策略下不能开启浏览器 / Computer Use' : null;
}

/** 仅普通协作成员且允许读写文件时可开启 git worktree 隔离。 */
export function worktreeRestrictedReason(rowEffectivePolicy: string, isLead = false): string | null {
  if (isLead) return '主 Agent 与协调席必须共享主工作区，不支持 worktree 隔离';
  if (rowEffectivePolicy === 'communication') return '仅沟通策略下不读写文件，不需要 worktree 隔离';
  return null;
}

export function resolveMemberHost(row: DraftMember, defaultHost: string): string {
  return row.host || defaultHost;
}

/**
 * 只在用户显式选择模型时返回 selection。
 * 后端 resolveSelection 拒绝只带 model_provider / reasoning_effort 的部分选择,
 * 因此未选模型时必须整体省略,交由后端使用宿主默认。
 */
export function memberSelection(row: DraftMember): GroupMemberInput['selection'] {
  if (!row.model) return undefined;
  return {
    ...(row.model_provider ? { model_provider: row.model_provider } : {}),
    model: row.model,
    ...(row.reasoning_effort ? { reasoning_effort: row.reasoning_effort } : {}),
  };
}

function toMemberInput(row: DraftMember, form: TeamDraft, isLead = false): GroupMemberInput {
  const host = resolveMemberHost(row, form.host);
  const ceiling = clampPolicyCeiling(row.policyCeiling, form.policy);
  const rowEffectivePolicy = effectivePolicy(row, form.policy);
  const selection = memberSelection(row);
  const input: GroupMemberInput = {
    name: row.name.trim(),
    host,
    ...(selection ? { selection } : {}),
    ...(ceiling ? { policyCeiling: ceiling } : {}),
  };
  if (row.allowBrowser && !browserRestrictedReason(rowEffectivePolicy)) input.allowBrowser = true;
  if (!isLead && row.workspaceMode === 'worktree' && !worktreeRestrictedReason(rowEffectivePolicy, false)) {
    input.workspaceMode = 'worktree';
  }
  return input;
}

/** 提交体:协作者名留空视为不创建,其余行按解析后的宿主与覆写字段组装。 */
export function buildCreateGroupBody(form: TeamDraft): CreateGroupBody {
  const lead = toMemberInput(form.lead, form, true);
  lead.name = lead.name || '主 Agent';
  const members = form.members
    .map(row => toMemberInput(row, form, false))
    .filter(row => row.name !== '');
  const charter = form.charter.trim();
  return {
    operationId: form.operationId,
    name: form.name.trim(),
    workspace: form.workspace,
    policy: form.policy,
    allowShell: form.policy === 'communication' ? false : form.allowShell,
    lead,
    members,
    ...(charter ? { charter } : {}),
    ...(form.workflowTemplate ? { workflowTemplate: form.workflowTemplate } : {}),
  };
}

/** 会进入提交体的行:主 Agent 恒在,协作成员跳过空名称行。 */
export function activeRows(form: TeamDraft): DraftMember[] {
  return [form.lead, ...form.members.filter(row => row.name.trim() !== '')];
}

function memberName(row: DraftMember, isLead: boolean): string {
  const name = row.name.trim();
  if (name) return name;
  return isLead ? '主 Agent' : '未命名协作成员';
}

/** 模型显示名:优先实时目录标签,目录未加载时回落到选的模型 ID。 */
export function modelLabel(row: DraftMember, hosts: AvailableHost[], defaultHost: string): string {
  if (!row.model) return '宿主默认';
  const host = hosts.find(item => item.host === resolveMemberHost(row, defaultHost));
  const model = host?.catalog.models.find(item => item.id === row.model && (!row.model_provider || item.provider === row.model_provider));
  return model?.label ?? row.model;
}

export interface MemberSummaryContext {
  defaultHost?: string;
  hostLabel: (host: string) => string;
  modelLabel: (row: DraftMember, effectiveHost: string) => string;
}

export interface MemberSummary {
  id: string;
  name: string;
  isLead: boolean;
  host: string;
  hostLabel: string;
  modelLabel: string;
  policy: string;
  policyLabel: string;
  browserLabel: string;
  workspaceLabel: string;
}

function browserLabel(row: DraftMember, groupPolicy: string): string {
  if (browserRestrictedReason(groupPolicy)) return '不适用（仅沟通策略）';
  return row.allowBrowser ? '允许（实际工具由宿主能力决定）' : '未授权';
}

function workspaceSummaryLabel(row: DraftMember, groupPolicy: string, isLead: boolean): string {
  if (isLead) return '共享主工作区（主 Agent）';
  if (worktreeRestrictedReason(groupPolicy, false)) return '仅沟通（不读写文件）';
  return row.workspaceMode === 'worktree' ? '独立 git worktree' : '共享主工作区';
}

/** 确认卡汇总:每位成员的名称、宿主、模型、生效策略与浏览器授权,顺序与提交体一致。 */
export function buildMemberSummaries(form: TeamDraft, context: MemberSummaryContext): MemberSummary[] {
  const defaultHost = context.defaultHost ?? form.host;
  return [form.lead, ...form.members.filter(row => row.name.trim() !== '')].map((row, index) => {
    const host = resolveMemberHost(row, defaultHost);
    const policy = effectivePolicy(row, form.policy);
    const isLead = index === 0;
    return {
      id: row.id,
      name: memberName(row, isLead),
      isLead,
      host,
      hostLabel: context.hostLabel(host),
      modelLabel: context.modelLabel(row, host),
      policy,
      policyLabel: policyLabel(policy),
      browserLabel: browserLabel(row, policy),
      workspaceLabel: workspaceSummaryLabel(row, policy, isLead),
    };
  });
}

export function membersFromWorkflowTemplate(template: WorkflowTemplate, context: PresetContext): DraftMember[] {
  return template.presetMembers.map((item) => {
    const preferred = item.preferredHost && context.availableHosts.includes(item.preferredHost) ? item.preferredHost : '';
    const ceiling = policyRank(item.policyCeiling) < policyRank(context.groupPolicy) ? item.policyCeiling : '';
    const effective = ceiling || context.groupPolicy;
    return newDraftMember({
      name: item.name,
      host: preferred === context.defaultHost ? '' : preferred,
      policyCeiling: ceiling,
      allowBrowser: Boolean(item.allowBrowser) && !browserRestrictedReason(effective),
      workspaceMode: item.workspaceMode === 'worktree' && !worktreeRestrictedReason(effective, false) ? 'worktree' : 'inherit',
    });
  });
}

export type PresetKind = 'minimal' | 'dev-review';

export interface PresetContext {
  defaultHost: string;
  availableHosts: string[];
  groupPolicy: string;
}

/** 快捷预设:按当前可用宿主填成员行,只填结构化字段,名称与授权都可由用户再改。 */
export function presetMembers(kind: PresetKind, context: PresetContext): DraftMember[] {
  if (kind === 'minimal') return [newDraftMember({ name: '协作助手' })];
  const reviewHost = context.availableHosts.find(host => host && host !== context.defaultHost) ?? '';
  const reviewCeiling = policyRank('read-only') < policyRank(context.groupPolicy) ? 'read-only' : '';
  return [
    newDraftMember({ name: '研发', host: '' }),
    newDraftMember({ name: '只读验收', host: reviewHost, policyCeiling: reviewCeiling }),
  ];
}

/** 显式选了模型时做严格校对;仅当该宿主的实时目录已加载且找不到该模型才算错误。 */
export function unknownModelMemberNames(form: TeamDraft, hosts: AvailableHost[]): string[] {
  const names: string[] = [];
  for (const row of activeRows(form)) {
    if (!row.model) continue;
    const catalogHost = hosts.find(item => item.host === resolveMemberHost(row, form.host));
    if (!catalogHost) continue;
    const found = catalogHost.catalog.models.some(model => model.id === row.model
      && (!row.model_provider || model.provider === row.model_provider));
    if (!found) names.push(memberName(row, row.id === form.lead.id));
  }
  return names;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asMember(value: unknown, fallbackName: string): DraftMember {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return newDraftMember({
    id: typeof record.id === 'string' && record.id ? record.id : memberId(),
    name: asString(record.name) || fallbackName,
    host: asString(record.host),
    model_provider: asString(record.model_provider),
    model: asString(record.model),
    reasoning_effort: asString(record.reasoning_effort),
    policyCeiling: asString(record.policyCeiling),
    allowBrowser: record.allowBrowser === true,
    workspaceMode: record.workspaceMode === 'worktree' ? 'worktree' : 'inherit',
  });
}

export interface RestoredDraft {
  draft: TeamDraft;
  submitted: boolean;
  group: Group | null;
}

/**
 * 恢复 sessionStorage 草稿:新形状直接归一化;旧形状(worker 字符串、无 lead)迁移为
 * 主 Agent 行 + 单个协作成员,保证刷新后不丢用户输入。
 */
export function restoreDraft(saved: unknown): RestoredDraft {
  const draft = createEmptyDraft();
  if (!saved || typeof saved !== 'object') return { draft, submitted: false, group: null };
  const record = saved as Record<string, unknown>;
  if (typeof record.operationId !== 'string' || !record.operationId) return { draft, submitted: false, group: null };
  draft.operationId = record.operationId;
  draft.name = asString(record.name);
  draft.text = asString(record.text);
  draft.charter = asString(record.charter);
  draft.workflowTemplate = asString(record.workflowTemplate);
  draft.workspace = asString(record.workspace);
  draft.host = asString(record.host);
  if (isPolicyMode(record.policy)) draft.policy = record.policy;
  if (typeof record.allowShell === 'boolean') draft.allowShell = record.allowShell;
  if (record.lead && typeof record.lead === 'object') {
    draft.lead = asMember(record.lead, '主 Agent');
    draft.members = Array.isArray(record.members)
      ? record.members.filter(item => item && typeof item === 'object').map(item => asMember(item, ''))
      : [];
  } else {
    // 旧草稿只有单个 worker 字段:保留为一位协作成员,名称与主 Agent 重复时不迁移。
    const worker = asString(record.worker).trim();
    draft.lead = newDraftMember({ name: '主 Agent' });
    draft.members = worker && worker !== '主 Agent' ? [newDraftMember({ name: worker })] : [];
  }
  draft.lead.policyCeiling = clampPolicyCeiling(draft.lead.policyCeiling, draft.policy);
  draft.members = draft.members.map(row => ({ ...row, policyCeiling: clampPolicyCeiling(row.policyCeiling, draft.policy) }));
  if (draft.policy === 'communication') {
    draft.allowShell = false;
    draft.lead.allowBrowser = false;
    draft.members = draft.members.map(row => ({ ...row, allowBrowser: false, workspaceMode: 'inherit' }));
  }
  draft.lead.workspaceMode = 'inherit';
  const group = record.group && typeof record.group === 'object' && typeof (record.group as Group).id === 'string'
    ? record.group as Group
    : null;
  return { draft, submitted: record.submitted === true, group };
}