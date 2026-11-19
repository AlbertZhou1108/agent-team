/**
 * 宿主能力的统一清单与角色推导（ADR 0009）。
 *
 * 清单描述"框架需要适配器提供什么"，不是"某个宿主碰巧有什么"。
 * 所有能力位都是布尔值；原本多档位的能力拆成独立布尔位。
 *
 * 这里只做描述层：声明、归一化、角色推导。执行路径仍由各宿主实现，
 * 运行时不做能力探测——声明即开发期已验证的结论。
 */

/** 能力清单。顺序即分组展示顺序。 */
export const CAPABILITY_GROUPS = Object.freeze({
  session: Object.freeze(['session.spawn', 'session.deliver', 'session.wake', 'turn.observe']),
  exec: Object.freeze(['exec.read', 'exec.write', 'exec.shell']),
  user: Object.freeze(['user.elicit', 'user.notify']),
  telemetry: Object.freeze([
    'telemetry.tokens.direct',
    'telemetry.tokens.derived',
    'telemetry.turn_time',
    'telemetry.context_window',
  ]),
});

export const CAPABILITY_IDS = Object.freeze(Object.values(CAPABILITY_GROUPS).flat());

const CAPABILITY_SET = new Set(CAPABILITY_IDS);

export function isCapabilityId(id) {
  return CAPABILITY_SET.has(id);
}

function emptyDeclaration() {
  return Object.fromEntries(CAPABILITY_IDS.map(id => [id, false]));
}

/**
 * 校验并补全能力声明。未声明按全部 false 处理，让外部模块与旧数据都能通过；
 * 但显式写下的未知位或非布尔值一律报错——声明出错应当尽早暴露。
 */
export function normalizeDeclaration(value) {
  if (value === undefined || value === null) return Object.freeze(emptyDeclaration());
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('能力声明必须是对象');
  const result = emptyDeclaration();
  for (const [id, enabled] of Object.entries(value)) {
    if (!CAPABILITY_SET.has(id)) throw new Error(`未知能力位: ${id}`);
    if (typeof enabled !== 'boolean') throw new Error(`能力位 ${id} 必须是布尔值`);
    result[id] = enabled;
  }
  return Object.freeze(result);
}

export function hasCapability(declaration, id) {
  if (!CAPABILITY_SET.has(id)) throw new Error(`未知能力位: ${id}`);
  return declaration?.[id] === true;
}

/**
 * 角色由能力推导，不存储、不声明。同一宿主可同时是 controller 与 member。
 *
 * 主控资格只看 `deliver + observe`：能收消息、能看回合状态，就代表用户做决定。
 * `session.wake` 不参与——它只决定框架能否主动拉起会话，是送达手段，不是身份。
 * 只有 `member` 来自 `spawn`，而 `spawn` 又由"有没有成员工厂"推导。
 */
export function deriveRoles(declaration) {
  const roles = [];
  if (hasCapability(declaration, 'session.deliver') && hasCapability(declaration, 'turn.observe')) roles.push('controller');
  if (hasCapability(declaration, 'session.spawn')) roles.push('member');
  return roles;
}

/**
 * 把"自动推导项"与手写声明合成完整清单。
 *
 * `session.spawn` 由成员工厂决定，`session.wake` 由唤醒驱动决定——两者都是代码事实，
 * 不手写，避免"声明说能、实际没有"的两套真相。
 */
export function resolveCapabilities({ declaration, hasFactory = false, hasWake = false } = {}) {
  return Object.freeze({
    ...normalizeDeclaration(declaration),
    'session.spawn': Boolean(hasFactory),
    'session.wake': Boolean(hasWake),
  });
}

/**
 * 该声明能作为外部主控使用的能力 ID 列表。
 * connect 用它替代过去"必需四项 + wake 探测"的硬编码默认值（S3 接入）。
 */
export function controllerCapabilityIds(declaration) {
  const ids = [];
  if (hasCapability(declaration, 'session.deliver') || hasCapability(declaration, 'session.wake')) ids.push('session.deliver');
  if (hasCapability(declaration, 'session.wake')) ids.push('session.wake');
  if (hasCapability(declaration, 'turn.observe')) ids.push('turn.observe');
  if (hasCapability(declaration, 'user.elicit')) ids.push('user.elicit');
  return ids;
}

/** 合并多份声明，任一为真即为真；用于宿主默认值与外部覆盖的组合。 */
export function mergeDeclarations(...declarations) {
  const merged = emptyDeclaration();
  for (const declaration of declarations) {
    const normalized = normalizeDeclaration(declaration);
    for (const id of CAPABILITY_IDS) if (normalized[id]) merged[id] = true;
  }
  return Object.freeze(merged);
}

/**
 * 旧执行能力词汇 → 新词汇。`filesystem.boundary` 并入 `exec.write`：
 * 能写就意味着知道写到哪，边界不是独立开关。
 */
const LEGACY_MEMBER_CAPABILITIES = Object.freeze({
  'file.read': 'exec.read',
  'file.write': 'exec.write',
  'shell.exec': 'exec.shell',
  'filesystem.boundary': 'exec.write',
});

export function canonicalMemberCapabilityId(value) {
  return LEGACY_MEMBER_CAPABILITIES[value] ?? value;
}

/** 归一化一组能力要求，去重并保留未知项（由调用方按缺失能力报错）。 */
export function canonicalMemberCapabilityIds(values) {
  if (!Array.isArray(values)) return [];
  const out = [];
  for (const value of values) {
    const id = canonicalMemberCapabilityId(value);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * 失败归因文案：只说明本次回合声明了哪些执行能力，不推断失败原因。
 * 没有声明时返回空串，调用方直接拼接即可。
 */
export function describeDeclaredCapabilities(capabilities) {
  return Array.isArray(capabilities) && capabilities.length
    ? `（宿主声明支持: ${capabilities.join(', ')}）`
    : '';
}
