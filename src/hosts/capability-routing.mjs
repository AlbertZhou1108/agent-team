// 统一成员能力路由：把「模型维能力」与「执行维有效能力」投影成同一份只读事实，
// 供能力名片、派工门禁与回合上下文复用。
//
// 红线：
// - 只使用宿主实时模型目录与群/宿主策略的真实字段；未声明就是未声明，不推断、
//   不按模型名硬编码，也不从自然语言正文猜测需求。
// - 不确定的能力保守拒绝（modal.image = 'unknown'、contextWindow = null）。
// - 能力要求只来自结构化参数（requiredCapabilities / minContextWindow）与结构化媒体事实，
//   不隐式代选成员。
import { LEGACY_MEMBER_CAPABILITIES, canonicalMemberCapabilityId } from './capabilities.mjs';

/** 统一能力词表：执行维三位 + 模型模态位 + 浏览器工具位。 */
export const ROUTING_CAPABILITY_IDS = Object.freeze([
  'exec.read',
  'exec.write',
  'exec.shell',
  'modal.image',
  'tool.browser',
]);

const EXEC_CAPABILITY_IDS = Object.freeze(['exec.read', 'exec.write', 'exec.shell']);

/** 工具 schema 允许的原始值：统一 ID 加旧别名（file.* 等历史入口仍可用）。 */
export const ROUTING_CAPABILITY_ENUM = Object.freeze([
  ...ROUTING_CAPABILITY_IDS,
  ...Object.keys(LEGACY_MEMBER_CAPABILITIES),
]);

/** 策略等级：成员上限只能在群上限内向下收敛。full-access 仅面板私有场景，按最高级处理。 */
export const POLICY_RANK = Object.freeze({ communication: 0, 'read-only': 1, 'workspace-write': 2, 'full-access': 3 });

export function policyRank(mode) {
  return Number.isInteger(POLICY_RANK[mode]) ? POLICY_RANK[mode] : 0;
}

/** 成员有效策略上限 = min(群上限, 成员 policy_ceiling)；NULL 表示继承群策略。 */
export function memberPolicyCeiling(group, member = null) {
  const ceiling = group?.policy ?? 'communication';
  const requested = member?.policy_ceiling ?? null;
  if (!requested) return ceiling;
  return policyRank(requested) < policyRank(ceiling) ? requested : ceiling;
}

/**
 * 成员级收敛请求：策略上限、shell 与浏览器授权。
 * - allowShell 只会在群允许的前提下由成员开关进一步收敛，绝不越级打开；
 * - allowBrowser 仅是策略授权，真实工具是否存在由宿主执行能力报告（toolBrowser）。
 */
export function memberPolicyRequest(group, member = null) {
  const ceiling = memberPolicyCeiling(group, member);
  const groupShell = group?.allow_shell === 1;
  const memberShell = member?.allow_shell;
  return {
    ceiling,
    allowShell: groupShell && (memberShell === null || memberShell === undefined || memberShell === 1),
    allowBrowser: member?.allow_browser === 1 && ceiling !== 'communication',
  };
}

/** 成员策略上限的合法取值：NULL 表示继承群策略，其余只能向下收敛。 */
export const MEMBER_POLICY_CEILINGS = Object.freeze(['communication', 'read-only', 'workspace-write']);

/**
 * 归一化成员策略补丁（建群行、加人、运行期调整共用）：
 * 只处理显式传入的字段；缺省字段不出现，交由调用方保留现值。
 * 越级 policyCeiling 直接拒绝，不做静默截断（调用方必须明确知道被拒）。
 */
export function normalizeMemberPolicyPatch(groupPolicy, patch = {}) {
  const next = {};
  if (patch.policyCeiling !== undefined) {
    const ceiling = patch.policyCeiling;
    if (ceiling !== null && !MEMBER_POLICY_CEILINGS.includes(ceiling)) throw new Error('成员策略上限无效');
    if (ceiling !== null && policyRank(ceiling) > policyRank(groupPolicy)) throw new Error('成员策略上限不能超过群策略');
    next.policyCeiling = ceiling;
  }
  if (patch.allowShell !== undefined) {
    if (patch.allowShell !== null && typeof patch.allowShell !== 'boolean') throw new Error('成员命令开关无效');
    next.allowShell = patch.allowShell;
  }
  if (patch.allowBrowser !== undefined) {
    if (typeof patch.allowBrowser !== 'boolean') throw new Error('成员浏览器授权无效');
    next.allowBrowser = patch.allowBrowser;
  }
  return next;
}

export function canonicalRoutingCapabilityId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  return canonicalMemberCapabilityId(id);
}

export function isRoutingCapabilityId(value) {
  return ROUTING_CAPABILITY_IDS.includes(canonicalRoutingCapabilityId(value));
}

/**
 * 归一化结构化能力要求：旧别名归一化、去重保序；未知 ID 单独返回。
 * 入口 schema 已用枚举拦住未知 ID，这里保留 unknown 供防御与测试断言。
 */
export function normalizeRequiredCapabilities(values = []) {
  const required = [];
  const unknown = [];
  for (const value of Array.isArray(values) ? values : []) {
    const id = canonicalRoutingCapabilityId(value);
    if (!id) continue;
    if (!ROUTING_CAPABILITY_IDS.includes(id)) {
      if (!unknown.includes(id)) unknown.push(id);
      continue;
    }
    if (!required.includes(id)) required.push(id);
  }
  return { required, unknown };
}

/** 结构化媒体事实 → 自动并入的能力要求（只认 mediaType，不解析正文）。 */
export function mediaCapabilityRequirements(mediaTypes = []) {
  const image = Array.isArray(mediaTypes)
    && mediaTypes.some(type => typeof type === 'string' && type.startsWith('image/'));
  return image ? ['modal.image'] : [];
}

/** 合并显式能力要求与结构化媒体要求；minContextWindow 仅接受正整数。 */
export function dispatchRequirements({ requiredCapabilities = [], minContextWindow = null, mediaTypes = [] } = {}) {
  const { required, unknown } = normalizeRequiredCapabilities(requiredCapabilities);
  for (const id of mediaCapabilityRequirements(mediaTypes)) {
    if (!required.includes(id)) required.push(id);
  }
  return {
    requiredCapabilities: required,
    unknownCapabilities: unknown,
    minContextWindow: Number.isInteger(minContextWindow) && minContextWindow > 0 ? minContextWindow : null,
  };
}

export function hasDispatchRequirements(requirements = {}) {
  return (requirements.requiredCapabilities?.length ?? 0) > 0 || Number.isInteger(requirements.minContextWindow);
}

/** 从实时目录里解析成员当前生效模型：显式选择优先，否则宿主默认模型。 */
export function resolveCatalogModel(catalog, selection = null) {
  if (!catalog || !Array.isArray(catalog.models) || catalog.models.length === 0) return null;
  const requested = typeof selection?.model === 'string' && selection.model.trim() ? selection.model.trim() : null;
  const provider = typeof selection?.model_provider === 'string' && selection.model_provider.trim() ? selection.model_provider.trim() : null;
  if (requested) {
    return catalog.models.find(item => item.id === requested && (!provider || item.provider === provider)) ?? null;
  }
  const configured = catalog.defaultModel
    ? catalog.models.find(item => item.key === catalog.defaultModel)
    : null;
  return configured
    ?? catalog.models.find(item => item.isDefault)
    ?? catalog.models[0]
    ?? null;
}

function effortIds(model) {
  if (!Array.isArray(model?.reasoningEfforts)) return [];
  return model.reasoningEfforts
    .map(item => (typeof item === 'string' ? item : item?.id))
    .filter(value => typeof value === 'string' && value.trim());
}

/**
 * 模型维投影：knownInCatalog 只取决于实时目录是否有该模型记录。
 * - inputModalities 未返回 → null（modal.image = 'unknown'）
 * - 明确返回模态数组 → 含 image 为 true，不含为 false
 * - contextWindow 只接受正整数，否则 null
 */
export function projectModelCapabilities({ catalog = null, selection = null, host = null } = {}) {
  const model = resolveCatalogModel(catalog, selection);
  const inputModalities = Array.isArray(model?.inputModalities) ? [...model.inputModalities] : null;
  const contextWindow = Number.isInteger(model?.contextWindow) && model.contextWindow > 0 ? model.contextWindow : null;
  const reasoningEfforts = effortIds(model);
  const requested = typeof selection?.model === 'string' && selection.model.trim() ? selection.model.trim() : null;
  const provider = typeof selection?.model_provider === 'string' && selection.model_provider.trim() ? selection.model_provider.trim() : null;
  const reasoningEffort = typeof selection?.reasoning_effort === 'string' && selection.reasoning_effort.trim()
    ? selection.reasoning_effort.trim()
    : (model?.defaultReasoningEffort ?? null);
  const knownInCatalog = Boolean(model);
  let modalImage = 'unknown';
  if (knownInCatalog && inputModalities) modalImage = inputModalities.includes('image') ? true : false;
  return {
    model: {
      id: model?.id ?? requested,
      provider: model?.provider ?? provider,
      label: model?.label ?? null,
      knownInCatalog,
      inputModalities,
      contextWindow,
      reasoningEffort,
      reasoningEfforts,
    },
    modelSummary: {
      host: host ?? catalog?.host ?? null,
      provider: model?.provider ?? provider,
      model: model?.id ?? requested,
      label: model?.label ?? null,
      knownInCatalog,
    },
    modalImage,
  };
}

/** 执行维投影：只认有效策略里真实存在的能力，不做推测。 */
export function executionCapabilityMap(policy = null) {
  const capabilities = new Set(Array.isArray(policy?.capabilities) ? policy.capabilities : []);
  return Object.fromEntries(EXEC_CAPABILITY_IDS.map(id => [id, capabilities.has(id)]));
}

/**
 * 只读能力名片：模型维与执行维的交集视图。
 * controller 可选块用于主控能力摘要（身份、模型与能力限制）。
 */
export function buildCapabilityCard({ member = null, selection = null, catalog = null, policy = null, controller = null } = {}) {
  const projection = projectModelCapabilities({ catalog, selection, host: member?.host ?? null });
  const exec = executionCapabilityMap(policy);
  const card = {
    memberId: member?.id ?? null,
    model: projection.model,
    modelSummary: projection.modelSummary,
    effectivePolicy: {
      ceiling: policy?.requested ?? null,
      mode: policy?.effective ?? null,
      reason: policy?.reason ?? null,
      browserReason: policy?.browserReason ?? null,
    },
    effectiveCapabilities: {
      'exec.read': exec['exec.read'],
      'exec.write': exec['exec.write'],
      'exec.shell': exec['exec.shell'],
      'modal.image': projection.modalImage,
      // 浏览器工具只认宿主执行能力报告的真实结果；communication 一律 false。
      'tool.browser': policy?.toolBrowser === true && policy?.effective !== 'communication',
    },
  };
  if (controller) card.controller = controller;
  return card;
}

function capabilityGapReason(card, id) {
  const mode = card.effectivePolicy.mode;
  if (id === 'modal.image') {
    const model = card.model;
    if (!model.knownInCatalog) return '宿主模型目录尚未探测或未返回该字段，可先刷新模型目录或切换已证实支持的模型';
    if (!model.inputModalities) return '当前模型未声明输入模态（未返回 inputModalities），无法证实支持 image';
    return `当前模型仅声明支持 ${model.inputModalities.join('/')}，未声明支持 image`;
  }
  if (id === 'tool.browser') return card.effectivePolicy.browserReason
    ?? '当前宿主未放行浏览器/Computer Use 工具';
  const ceiling = card.effectivePolicy.ceiling;
  const reason = card.effectivePolicy.reason;
  const policy = ceiling && mode && ceiling !== mode
    ? `群策略上限为 ${ceiling}，当前有效策略为 ${mode ?? '未知'}`
    : `当前有效策略为 ${mode ?? '未知'}`;
  return `${policy}，不支持 ${id}${reason ? `：${reason}` : ''}`;
}

function contextWindowGapReason(card, minimum) {
  const window = card.model.contextWindow;
  if (window === null) return `当前模型上下文窗口未知或小于 ${minimum}（宿主模型目录未返回该字段）`;
  return `当前模型上下文窗口 ${window}，小于要求的 ${minimum}`;
}

/**
 * 派工门槛校验：缺一项即拒绝；modal.image 的 'unknown' 与 null contextWindow 都算不满足。
 */
export function evaluateDispatchRequirements(card, { requiredCapabilities = [], minContextWindow = null } = {}) {
  const missingCapabilities = [];
  const reasons = [];
  for (const id of requiredCapabilities) {
    if (!isRoutingCapabilityId(id)) continue;
    if (card.effectiveCapabilities[id] === true) continue;
    missingCapabilities.push(canonicalRoutingCapabilityId(id));
    reasons.push(capabilityGapReason(card, canonicalRoutingCapabilityId(id)));
  }
  if (Number.isInteger(minContextWindow) && minContextWindow > 0) {
    const window = card.model.contextWindow;
    if (!(Number.isInteger(window) && window >= minContextWindow)) {
      if (!missingCapabilities.includes('minContextWindow')) missingCapabilities.push('minContextWindow');
      reasons.push(contextWindowGapReason(card, minContextWindow));
    }
  }
  return { ok: missingCapabilities.length === 0, missingCapabilities, reasons };
}

/** 统一的门禁错误：三入口共用同一 code / details 语义。 */
export function capabilityRequirementError(memberName, evaluation, extra = {}) {
  const error = new Error(
    `capability_required: 成员 ${memberName} 缺少 ${evaluation.missingCapabilities.join(', ')}（${evaluation.reasons.join('；')}）`,
  );
  error.code = 'capability_required';
  error.details = {
    member: memberName,
    missingCapabilities: evaluation.missingCapabilities,
    reasons: evaluation.reasons,
    ...extra,
  };
  return error;
}

/** 安全读取消息上持久化的能力要求（旧消息无该列值视作无约束）。 */
export function parseRequiredCapabilities(serialized) {
  if (typeof serialized !== 'string' || !serialized.trim()) return [];
  try {
    return normalizeRequiredCapabilities(JSON.parse(serialized)).required;
  } catch {
    return [];
  }
}

/** 一条已持久化消息的能力要求。 */
export function messageRequirements(row) {
  const minimum = row?.min_context_window;
  return {
    requiredCapabilities: parseRequiredCapabilities(row?.required_capabilities),
    minContextWindow: Number.isInteger(minimum) && minimum > 0 ? minimum : null,
  };
}

/** 精简行：仅用于回合上下文的 teamCapabilities 投影。 */
export function capabilityRow(card, { id = null, name = null, role = null, kind = null } = {}) {
  const row = {
    id,
    name,
    role,
    model: card.model.id ?? card.model.label ?? null,
    provider: card.model.provider ?? null,
    knownInCatalog: card.model.knownInCatalog,
    modalImage: card.effectiveCapabilities['modal.image'],
    contextWindow: card.model.contextWindow,
    execRead: card.effectiveCapabilities['exec.read'],
    execWrite: card.effectiveCapabilities['exec.write'],
    execShell: card.effectiveCapabilities['exec.shell'],
    toolBrowser: card.effectiveCapabilities['tool.browser'],
  };
  if (kind) row.kind = kind;
  return row;
}

/** 回合上下文的 teamCapabilities：主控摘要 + 每活跃成员一行。 */
export function teamCapabilityView({ controller = null, controllerCard = null, members = [] } = {}) {
  return {
    ...(controllerCard ? { controller: capabilityRow(controllerCard, controller ?? {}) } : {}),
    members: members.map(entry => capabilityRow(entry.capabilityCard, entry)),
  };
}
