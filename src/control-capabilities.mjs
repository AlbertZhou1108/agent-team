/**
 * 外部主控能力契约。
 *
 * 外部宿主只有在“适配器声明”和“连接时实测”都成立时才能获得相应能力。
 * 空 patch 视为未知，不回退成允许；这避免新适配器因为漏填字段而意外获得主控权。
 */

export const CONTROL_PROTOCOL_VERSION = 1;

export const CONTROL_CAPABILITIES = Object.freeze({
  sessionIdentity: 'session.identity',
  messageDelivery: 'session.deliver',
  sessionWake: 'session.wake',
  statusObservation: 'session.status',
  turnObservation: 'turn.observe',
  userElicitation: 'user.elicit',
  nativeNotification: 'notification.native',
});

export const CONTROL_CAPABILITY_IDS = Object.freeze(Object.values(CONTROL_CAPABILITIES));

export const CONTROLLER_REQUIRED_CAPABILITIES = Object.freeze([
  CONTROL_CAPABILITIES.sessionIdentity,
  CONTROL_CAPABILITIES.messageDelivery,
  CONTROL_CAPABILITIES.statusObservation,
  CONTROL_CAPABILITIES.turnObservation,
]);

const POLICY_MODES = new Set(['communication', 'read-only', 'workspace-write']);

function uniqueStrings(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label}必须是数组`);
  const normalized = value.map(item => {
    if (typeof item !== 'string' || !item.trim()) throw new Error(`${label}包含无效值`);
    return item.trim();
  });
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label}包含重复值`);
  return normalized;
}

/**
 * 规范化适配器声明的能力。capabilities 接受稳定 ID 数组；workspaceRoots 是
 * 主控会话可创建团队的绝对路径根，policies 是该连接允许选择的策略上限。
 */
export function normalizeControlCapabilities(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('宿主能力必须是对象');
  const capabilities = value.capabilities === undefined
    ? []
    : uniqueStrings(value.capabilities, 'capabilities');
  const unknown = capabilities.filter(id => !CONTROL_CAPABILITY_IDS.includes(id));
  if (unknown.length) throw new Error(`未知宿主能力: ${unknown.join(', ')}`);
  const workspaceRoots = value.workspaceRoots === undefined
    ? []
    : uniqueStrings(value.workspaceRoots, 'workspaceRoots');
  for (const root of workspaceRoots) {
    if (!root.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(root)) throw new Error('workspaceRoots 必须是绝对路径');
  }
  const policies = value.policies === undefined
    ? ['communication', 'read-only']
    : uniqueStrings(value.policies, 'policies');
  if (policies.some(mode => !POLICY_MODES.has(mode))) throw new Error('policies 包含未知策略');
  return {
    version: CONTROL_PROTOCOL_VERSION,
    capabilities: [...new Set(capabilities)].sort(),
    workspaceRoots,
    policies,
  };
}

/** 有效能力是声明与实测的交集；workspace 和策略也分别取交集。 */
export function effectiveControlCapabilities(declaredValue, probedValue = {}) {
  const declared = normalizeControlCapabilities(declaredValue);
  const probed = normalizeControlCapabilities({
    capabilities: probedValue.capabilities ?? [],
    workspaceRoots: probedValue.workspaceRoots ?? declared.workspaceRoots,
    policies: probedValue.policies ?? declared.policies,
  });
  return {
    version: CONTROL_PROTOCOL_VERSION,
    capabilities: declared.capabilities.filter(id => probed.capabilities.includes(id)),
    workspaceRoots: declared.workspaceRoots.filter(root => probed.workspaceRoots.includes(root)),
    policies: declared.policies.filter(mode => probed.policies.includes(mode)),
  };
}

export function controllerCapabilityGaps(value) {
  const capabilities = normalizeControlCapabilities(value).capabilities;
  return CONTROLLER_REQUIRED_CAPABILITIES.filter(id => !capabilities.includes(id));
}

export function assertControllerCapabilities(value) {
  const gaps = controllerCapabilityGaps(value);
  if (gaps.length) throw new Error(`宿主不能成为主控，缺少能力: ${gaps.join(', ')}`);
  return normalizeControlCapabilities(value);
}

export function supportsControlCapability(value, capability) {
  if (!CONTROL_CAPABILITY_IDS.includes(capability)) throw new Error(`未知宿主能力: ${capability}`);
  return normalizeControlCapabilities(value).capabilities.includes(capability);
}

/** 以规范化后的根目录做边界判断，不把前缀相同的兄弟目录误认为子目录。 */
export function workspaceWithinRoot(workspace, root) {
  if (typeof workspace !== 'string' || typeof root !== 'string') return false;
  const child = workspace.replace(/\\/g, '/').replace(/\/+$/, '');
  const parent = root.replace(/\\/g, '/').replace(/\/+$/, '');
  return child === parent || child.startsWith(`${parent}/`);
}

export function assertControlWorkspace(value, workspace) {
  const capabilities = normalizeControlCapabilities(value);
  if (!capabilities.workspaceRoots.some(root => workspaceWithinRoot(workspace, root))) {
    throw new Error('工作目录不在外部主控已注册的 workspace roots 中');
  }
  return workspace;
}

export function assertControlPolicy(value, mode) {
  const capabilities = normalizeControlCapabilities(value);
  if (!capabilities.policies.includes(mode)) throw new Error(`外部主控连接不允许策略: ${mode}`);
  return mode;
}
