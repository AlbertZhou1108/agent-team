// 统一能力域服务：把「有效执行策略 + 模型目录 + 能力名片 + 派工门禁」收在一处，
// 让成员工具、Panel 工具、无头控制面与消息调度共用同一份计算，不再各拼一套。
//
// 边界：
// - 能力事实只来自宿主实时 modelCatalog、Group policy、宿主执行能力与绑定声明；
// - 名片展示用已探测缓存（peek，不触发探测）；执行前二次复核才刷新目录；
// - 本模块不决定投递顺序与落账，调度层复用 setDeliveryError/emit 语义。
import * as routing from '../hosts/capability-routing.mjs';
import * as teamsAgg from '../aggregates/teams.mjs';
import * as conversationsAgg from '../aggregates/conversations.mjs';
import * as externalAgg from '../aggregates/external-control.mjs';
import { bindingCapabilities } from '../control/identity.mjs';

const COORDINATOR_REASON = '主控协调会话仅允许通信，不直接读写项目文件';
const PANEL_COORDINATOR_REASON = 'Panel 协调席仅允许通信，不直接读写项目文件';
const EXTERNAL_COORDINATOR_REASON = '外部主控通过绑定会话协调，不直接读写项目文件';

function memberSelection(member) {
  if (!member || typeof member.model !== 'string' || !member.model.trim()) return null;
  return {
    model_provider: member.model_provider ?? null,
    model: member.model,
    reasoning_effort: member.reasoning_effort ?? null,
  };
}

function controllerIdentity(controller) {
  return { kind: controller.kind, id: controller.id, name: controller.name };
}

export class CapabilityService {
  constructor(bus) {
    this.bus = bus;
  }

  /**
   * 成员有效执行策略：宿主真实能力 × Group policy 天花板，结果落库并在变化时清会话。
   * 从 ControlPlane 迁出后，三入口与消息调度共用同一计算。
   */
  async executionPolicyFor(group, member, { persist = true } = {}) {
    const host = this.bus.hosts.get(member.host);
    let report;
    if (host?.executionCapabilities) {
      report = await host.executionCapabilities({
        mode: group.policy,
        allowShell: group.allow_shell === 1,
        workspace: group.workspace,
      });
    } else {
      report = {
        effectivePolicy: group.policy === 'workspace-write' ? 'read-only' : group.policy,
        capabilities: group.policy === 'communication' ? [] : ['exec.read'],
        reason: group.policy === 'workspace-write' ? '宿主未声明工作区写边界保证' : null,
      };
    }
    let effective = report.effectivePolicy;
    let capabilities = [...new Set(report.capabilities ?? [])];
    let reason = report.reason ?? null;
    if (group.policy === 'communication') {
      effective = 'communication';
      capabilities = [];
      reason = '群策略仅允许通信';
    } else if (group.policy === 'read-only' && effective === 'workspace-write') {
      effective = 'read-only';
      capabilities = capabilities.filter(capability => capability === 'exec.read');
      reason = '群策略仅允许读取';
    }
    if (effective !== 'workspace-write') {
      capabilities = capabilities.filter(capability => capability === 'exec.read');
    }
    const policy = { requested: group.policy, effective, capabilities, reason };
    // 纯计算（名片/回合上下文）不写库、不清会话：避免"展示一次就把后续回合策略收窄"的副作用。
    if (!persist) return policy;
    const previousEffective = member.effective_policy ?? null;
    const previousCapabilities = member.capabilities ? JSON.parse(member.capabilities) : [];
    const capabilityChanged = previousEffective !== effective
      || JSON.stringify(previousCapabilities) !== JSON.stringify(capabilities);
    teamsAgg.updateMemberExecutionPolicy(this.bus.store, { memberId: member.id, effectivePolicy: effective, capabilities, reason });
    if (previousEffective !== null && capabilityChanged) {
      conversationsAgg.clearSessionsForMember(this.bus.store, member.id);
      this.bus.notify(group.id, member.id,
        `执行能力已更新为 ${effective}（${capabilities.join(', ') || '无项目能力'}）${reason ? `：${reason}` : ''}`);
    }
    return policy;
  }

  /** 展示用目录：只读已探测缓存，不在这里触发宿主探测。 */
  catalogFor(host) {
    if (!host) return null;
    try {
      return this.bus.models.peek(host);
    } catch {
      return null;
    }
  }

  /** 二次复核用目录：允许刷新（30 秒 TTL 内复用），失败返回 null 走保守拒绝。 */
  async freshCatalog(host) {
    if (!host || !this.bus.hosts.has(host)) return null;
    try {
      const list = await this.bus.modelCatalog({ host });
      const entry = list?.hosts?.find(item => item.host === host && item.ok);
      return entry?.catalog ?? null;
    } catch {
      return null;
    }
  }

  async memberCard(group, member, { policy = null, catalog = null, persist = true } = {}) {
    const effectivePolicy = policy ?? await this.executionPolicyFor(group, member, { persist });
    return routing.buildCapabilityCard({
      member,
      selection: memberSelection(member),
      catalog: catalog ?? this.catalogFor(member.host),
      policy: effectivePolicy,
    });
  }

  /**
   * 成员能力名片列表：保留既有成员字段，新增只读 capabilityCard 与执行策略字段。
   * 默认只读计算（不落库）；控制面快照/门禁显式传 persist:true 才更新成员有效策略。
   */
  async memberCards(group, { persist = false } = {}) {
    const members = this.bus.members(group.id);
    return Promise.all(members.map(async member => {
      const policy = await this.executionPolicyFor(group, member, { persist });
      const capabilityCard = routing.buildCapabilityCard({
        member,
        selection: memberSelection(member),
        catalog: this.catalogFor(member.host),
        policy,
      });
      return {
        ...member,
        capabilityCard,
        executionPolicy: policy,
        capabilities: policy.capabilities,
        effective_policy: policy.effective,
        capability_reason: policy.reason,
      };
    }));
  }

  /** 当前主控能力投影：成员主控与普通成员同构，但受协调会话 communication 边界。 */
  async controllerCard(group) {
    const controller = this.bus.teamController(group.id);
    if (controller.kind === 'member') {
      const member = controller.member ?? this.bus.store.member(controller.id);
      const policy = { requested: group.policy, effective: 'communication', capabilities: [], reason: COORDINATOR_REASON };
      return routing.buildCapabilityCard({
        member,
        selection: memberSelection(member),
        catalog: this.catalogFor(member.host),
        policy,
        controller: controllerIdentity(controller),
      });
    }
    if (controller.kind === 'panel_agent') {
      const agent = controller.agent ?? this.bus.panelAgent();
      const selection = agent?.model
        ? { model_provider: agent.model_provider ?? null, model: agent.model, reasoning_effort: agent.reasoning_effort ?? null }
        : null;
      const policy = { requested: group.policy, effective: 'communication', capabilities: [], reason: PANEL_COORDINATOR_REASON };
      return routing.buildCapabilityCard({
        member: { id: agent?.id ?? null, name: agent?.name ?? null, host: agent?.host ?? null },
        selection,
        catalog: this.catalogFor(agent?.host),
        policy,
        controller: controllerIdentity(controller),
      });
    }
    const bindingId = controller.assignment?.controller_binding_id ?? null;
    const binding = bindingId ? externalAgg.binding(this.bus.store, bindingId) : null;
    const declared = binding ? bindingCapabilities(binding) : { capabilities: [] };
    const policy = { requested: group.policy, effective: 'communication', capabilities: [], reason: EXTERNAL_COORDINATOR_REASON };
    return routing.buildCapabilityCard({
      member: { id: null, name: controller.name, host: binding?.host ?? null },
      policy,
      controller: {
        ...controllerIdentity(controller),
        ...(binding ? { bindingId: binding.id, declaredCapabilities: declared.capabilities } : {}),
      },
    });
  }

  /** 回合上下文精简视图：主控摘要 + 每活跃成员一行能力事实。 */
  async teamCapabilities(group) {
    const members = await this.memberCards(group);
    const controllerCard = await this.controllerCard(group).catch(() => null);
    return routing.teamCapabilityView({
      controller: controllerCard?.controller ?? null,
      controllerCard,
      members: members.map(member => ({
        id: member.id,
        name: member.name,
        role: member.role,
        capabilityCard: member.capabilityCard,
      })),
    });
  }

  /**
   * 写库前首检：发往成员且带能力要求时同步计算目标成员当前有效能力。
   * 只用已探测目录（不触发探测），目录缺失时 modal.image/contextWindow 走保守拒绝。
   */
  async assertDispatch({ group, target, requiredCapabilities = [], minContextWindow = null, mediaTypes = [] } = {}) {
    const requirements = routing.dispatchRequirements({ requiredCapabilities, minContextWindow, mediaTypes });
    const card = await this.memberCard(group, target, { persist: true });
    const evaluation = routing.evaluateDispatchRequirements(card, requirements);
    if (!evaluation.ok) {
      throw routing.capabilityRequirementError(target.name, evaluation, {
        capabilityCard: card,
        executionPolicy: card.effectivePolicy,
      });
    }
    return { card, requirements };
  }

  /** 这批消息里是否有持久化的能力要求；无要求时调度层走原同步路径，不做任何探测。 */
  hasDeliveryRequirements(messages = []) {
    return (messages ?? []).some(message => routing.hasDispatchRequirements(routing.messageRequirements(message)));
  }

  /**
   * 执行前二次复核：按最新模型选择、实时目录与最新有效策略重算。
   * 返回逐条结论，调度层据此只拦截不满足的消息，其余继续投递。
   */
  async recheckDelivery({ group, member, messages = [] } = {}) {
    const rows = (messages ?? []).filter(Boolean);
    const entries = rows.map(message => ({
      message,
      requirements: routing.messageRequirements(message),
    }));
    const constrained = entries.filter(entry => routing.hasDispatchRequirements(entry.requirements));
    if (constrained.length === 0) return { ok: true, allowed: entries, blocked: [], card: null };
    const catalog = await this.freshCatalog(member.host);
    const policy = await this.executionPolicyFor(group, member, { persist: true });
    const card = routing.buildCapabilityCard({
      member,
      selection: memberSelection(member),
      catalog,
      policy,
    });
    const allowed = [];
    const blocked = [];
    for (const entry of entries) {
      if (!routing.hasDispatchRequirements(entry.requirements)) {
        allowed.push(entry);
        continue;
      }
      const evaluation = routing.evaluateDispatchRequirements(card, entry.requirements);
      if (evaluation.ok) allowed.push({ ...entry, evaluation });
      else blocked.push({ ...entry, evaluation });
    }
    return { ok: blocked.length === 0, allowed, blocked, card };
  }

  /** 复核拦截后向主控投递可处置通知（不是用户聊天流气泡）。 */
  notifyBlocked({ group, member, blocked = [], recheck = false } = {}) {
    if (!blocked.length) return;
    const first = blocked[0];
    const capabilityCard = first.evaluation?.capabilityCard;
    const gaps = blocked.map(entry => {
      const evaluation = entry.evaluation ?? (capabilityCard ? routing.evaluateDispatchRequirements(capabilityCard, entry.requirements) : null);
      return evaluation
        ? `消息 ${entry.message.id} 缺少 ${evaluation.missingCapabilities.join(', ')}（${evaluation.reasons.join('；')}）`
        : `消息 ${entry.message.id} 不满足能力要求`;
    });
    const controller = this.bus.teamController(group.id);
    this.bus.notify(group.id, controller.id,
      `${recheck ? '执行前复核' : '派工前检查'}拦截了发往成员 ${member.name} 的 ${blocked.length} 条消息：${gaps.join('；')}。消息已保留但不会投递；可对照成员能力名片改派、调整 requiredCapabilities，或用 member_model / group_add 补齐能力后重派。`);
  }
}
