// Panel 会话域:Panel Agent 创建/配置、团队绑定建立、绑定与团队快照投影、
// 会话系统提示词组装。门面 PanelSessions 的方法逐字搬迁到这里,接收 bus。
import { randomUUID } from 'node:crypto';
import { ensureDefaultPanelWorkspace } from '../default-workspace.mjs';
import { panelCoordinationInstructions, panelPrivateInstructions } from '../prompts.mjs';
import * as conversationsAgg from '../aggregates/conversations.mjs';
import * as panelAgg from '../aggregates/panel.mjs';

/** 当前 Panel Agent;未创建时为 null。 */
export function panelAgent(bus) {
  return panelAgg.panelAgent(bus.store);
}

/** 为所有团队建立缺省 observer 绑定(幂等);没有 Panel Agent 时什么都不做。 */
export function ensurePanelBindings(bus) {
  const panelAgent = bus.panelAgent();
  if (!panelAgent) return;
  panelAgg.ensureBindings(bus.store, panelAgent.id, new Date().toISOString());
}

/** 当前 Panel Agent 对某团队的关系;没有 Panel Agent 时为 null。 */
export function panelTeamRelation(bus, groupId) {
  const panelAgent = bus.panelAgent();
  if (!panelAgent) return null;
  bus.store.group(groupId);
  bus.ensurePanelBindings();
  return panelAgg.bindingRelation(bus.store, panelAgent.id, groupId);
}

/** 未归档团队列表,附带 Panel Agent 关系与当前主控投影。 */
export function panelTeamViews(bus) {
  bus.ensurePanelBindings();
  const panelAgent = bus.panelAgent();
  if (!panelAgent) return [];
  return panelAgg.activeGroups(bus.store).map(group => ({
    ...group,
    relation: panelAgg.bindingRelation(bus.store, panelAgent.id, group.id),
    controller: bus.teamController(group.id),
  }));
}

/** 写操作前置校验:Panel Agent 必须是该团队 current main(绑定 main + 主控 active)。 */
export function requirePanelMain(bus, agentId, groupId) {
  const group = bus.store.group(groupId);
  const relation = panelAgg.bindingRelation(bus.store, agentId, groupId);
  const controller = panelAgg.controller(bus.store, groupId);
  if (relation !== 'main' || controller?.controller_kind !== 'panel_agent'
    || controller.controller_id !== agentId || controller.state !== 'active') {
    throw new Error('Panel Agent 当前不是该团队的主 Agent');
  }
  return group;
}

/** 单团队快照:群、关系、主控、成员、沟通摘要与运行中端点。 */
export function panelTeamSnapshot(bus, groupId) {
  bus.ensurePanelBindings();
  const group = bus.store.group(groupId);
  const panelAgent = bus.panelAgent();
  const relation = panelAgent ? bus.panelTeamRelation(groupId) : null;
  return {
    group,
    relation,
    controller: bus.teamController(groupId),
    members: bus.members(groupId),
    communication: bus.groupSummary(groupId),
    running: [...bus.running.values()]
      .filter(item => item.endpoint.group_id === groupId && item.endpoint.context !== 'private')
      .map(item => item.endpoint.id),
  };
}

/** 会话系统提示词:coordination 用协作提示词,private 带工作区/访问级别/当前团队。 */
export function panelInstructions(bus, session, panelAgent, activeTeamId = null) {
  if (session.context === 'coordination') return panelCoordinationInstructions(panelAgent, session.group_id);
  const relation = activeTeamId ? bus.panelTeamRelation(activeTeamId) : null;
  return panelPrivateInstructions(panelAgent, {
    workspace: panelAgent.workspace ?? '未设置（宿主 cwd 使用数据目录）',
    access: bus.panelAccessValue(panelAgent),
    activeTeamId,
    relation,
  });
}

/** 创建 Panel Agent:校验宿主/模型目录/访问级别,事务内落库并建私聊会话。 */
export async function createPanelAgent(bus, { name, host, model_provider, model, reasoning_effort, workspace, access = 'read-only' }) {
  if (bus.panelAgent()) throw new Error('当前数据目录已经存在 Panel Agent');
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) throw new Error('Panel Agent 名称无效');
  if (!['read-only', 'workspace-write', 'full-access'].includes(access)) throw new Error('Panel Agent 访问级别无效');
  bus.requireHost(host);
  bus.requirePanelAccess(host, access);
  // 未指定私人工作区时使用跨系统默认目录:开箱即用,不必先手动选择。
  // 附件副本与此无关——它们统一存放在数据目录 attachments/ 下,不污染工作区。
  const panelWorkspace = bus.panelWorkspace(
    typeof workspace === 'string' && workspace.trim() ? workspace : ensureDefaultPanelWorkspace(),
    access,
  );
  const catalog = await bus.modelCatalog({ refresh: true, host });
  const hostCatalog = catalog.hosts.find(item => item.host === host && item.ok && item.catalog);
  if (!hostCatalog) throw new Error('Panel Agent 宿主没有可用模型目录');
  if (!model) {
    const preferred = hostCatalog.catalog.models.find(item => item.key === hostCatalog.catalog.defaultModel)
      ?? hostCatalog.catalog.models.find(item => item.isDefault);
    if (!preferred) throw new Error('请明确选择模型，宿主没有提供默认模型');
    model = preferred.id;
    model_provider ??= preferred.provider;
  }
  const candidates = hostCatalog.catalog.models.filter(item => item.id === model);
  const provider = typeof model_provider === 'string' && model_provider.trim() ? model_provider.trim() : null;
  const selected = candidates.find(item => !provider || item.provider === provider);
  if (!selected) throw new Error('Panel Agent 选择的模型不在宿主目录中');
  const supported = selected.reasoningEfforts.length ? selected.reasoningEfforts : hostCatalog.catalog.reasoningEfforts;
  const effort = reasoning_effort || selected.defaultReasoningEffort || null;
  if (effort !== null && supported.length && !supported.some(item => item.id === effort)) {
    throw new Error('Panel Agent 思考强度不受支持');
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  bus.store.transaction(() => {
    if (bus.panelAgent()) throw new Error('当前数据目录已经存在 Panel Agent');
    panelAgg.insertAgent(bus.store, {
      id,
      name: name.trim(),
      host,
      modelProvider: selected.provider ?? provider,
      model: selected.id,
      reasoningEffort: effort,
      workspace: panelWorkspace,
      access,
      created: now,
      updated: now,
    });
    conversationsAgg.forPanelAgent(bus.store, id, 'private');
  });
  bus.ensurePanelBindings();
  return bus.panelAgentState();
}

/** 更新 Panel Agent 配置;宿主/模型变化时按范围清空会话绑定。 */
export async function updatePanelAgent(bus, { name, host, model_provider, model, reasoning_effort, workspace, access }) {
  const agent = bus.panelAgent();
  if (!agent) throw new Error('Panel Agent 尚未创建');
  if ([...bus.running.values()].some(item => item.endpoint.owner_kind === 'panel_agent')) {
    throw new Error('Panel Agent 正在运行，不能修改配置');
  }
  if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.trim().length > 100)) {
    throw new Error('Panel Agent 名称无效');
  }
  const nextHost = host ?? agent.host;
  bus.requireHost(nextHost);
  const currentAccess = bus.panelAccessValue(agent);
  const nextAccess = access === undefined ? currentAccess : access;
  if (!['read-only', 'workspace-write', 'full-access'].includes(nextAccess)) throw new Error('Panel Agent 访问级别无效');
  bus.requirePanelAccess(nextHost, nextAccess);
  // 与创建一致:未指定或清空工作区都回落跨系统默认目录,Panel Agent 始终有工作区可用。
  const nextWorkspace = workspace === undefined
    ? (agent.workspace ?? ensureDefaultPanelWorkspace())
    : (typeof workspace === 'string' && workspace.trim()
        ? bus.panelWorkspace(workspace, nextAccess)
        : ensureDefaultPanelWorkspace());
  if (nextAccess !== 'read-only' && !nextWorkspace) throw new Error('工作区写入和完全权限需要设置私人工作区');
  const catalog = await bus.modelCatalog({ refresh: true, host: nextHost });
  const hostCatalog = catalog.hosts.find(item => item.host === nextHost && item.ok && item.catalog);
  if (!hostCatalog) throw new Error('Panel Agent 宿主没有可用模型目录');
  const nextModel = model ?? agent.model;
  const provider = model_provider === undefined
    ? (agent.model_provider ?? null)
    : (typeof model_provider === 'string' && model_provider.trim() ? model_provider.trim() : null);
  const selected = hostCatalog.catalog.models.find(item => item.id === nextModel && (!provider || item.provider === provider));
  if (!selected) throw new Error('Panel Agent 选择的模型不在宿主目录中');
  const supported = selected.reasoningEfforts.length ? selected.reasoningEfforts : hostCatalog.catalog.reasoningEfforts;
  const effort = reasoning_effort === undefined ? (agent.reasoning_effort ?? selected.defaultReasoningEffort ?? null) : reasoning_effort || selected.defaultReasoningEffort || null;
  if (effort !== null && supported.length && !supported.some(item => item.id === effort)) throw new Error('Panel Agent 思考强度不受支持');
  const now = new Date().toISOString();
  const nextProvider = selected.provider ?? provider ?? null;
  const hostModelChanged = nextHost !== agent.host
    || nextProvider !== (agent.model_provider ?? null)
    || selected.id !== agent.model
    || effort !== agent.reasoning_effort;
  const privateChanged = nextAccess !== currentAccess || nextWorkspace !== (agent.workspace ?? null);
  bus.store.transaction(() => {
    panelAgg.updateAgent(bus.store, {
      id: agent.id,
      name: (name ?? agent.name).trim(),
      host: nextHost,
      modelProvider: nextProvider,
      model: selected.id,
      reasoningEffort: effort,
      workspace: nextWorkspace,
      access: nextAccess,
      updated: now,
    });
    if (hostModelChanged) {
      conversationsAgg.clearSessionsForPanelAgent(bus.store, agent.id);
    } else if (privateChanged) {
      conversationsAgg.clearSessionsForPanelAgent(bus.store, agent.id, { privateOnly: true });
    }
  });
  return bus.panelAgentState();
}

/** 创建 Panel Agent 主控的团队:成员格式 名称=宿主,主 Agent 复用 Panel Agent 身份。 */
export function createPanelTeam(bus, agent, { name, workspace, members = '', charter }) {
  const people = String(members ?? '').split(',').filter(Boolean).map(item => {
    const [memberName, host, ...extra] = item.trim().split('=');
    if (!memberName || !host || extra.length) throw new Error('成员格式应为 名称=宿主');
    bus.requireHost(host);
    return { name: memberName, host };
  });
  return bus.createGroup({
    name,
    workspace,
    charter,
    lead: { name: agent.name, host: agent.host },
    members: people,
    panelAgentId: agent.id,
  });
}
