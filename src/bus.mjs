import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Store } from './store.mjs';
import { EventLog } from './event-log.mjs';
import { TeamRequests } from './team-requests.mjs';
import { TeamDirectives } from './team-directives.mjs';
import { Telemetry } from './telemetry.mjs';
import { MessageDispatch } from './message-dispatch.mjs';
import { BusQueries } from './bus-queries.mjs';
import { ToolStreams } from './tool-streams.mjs';
import { toolsFor } from './tools.mjs';
import { panelToolsFor } from './panel-tools.mjs';
import { Collaboration } from './collaboration.mjs';
import { GroupLifecycle } from './group-lifecycle.mjs';
import { Information } from './information.mjs';
import {
  BUILTIN_PRESET_ID,
  normalizeModelPolicy,
} from './model-policy.mjs';
import { memberModelSummary } from './model-policy.mjs';
import { Interactions } from './interactions.mjs';
import { Attachments } from './attachments.mjs';
import { PanelSessions } from './panel-sessions.mjs';
import { TurnExecutor } from './turn-executor.mjs';
import { ToolDispatch } from './tool-dispatch.mjs';
import { ArchiveSnapshots } from './archive-snapshots.mjs';
import { Notes } from './notes.mjs';
import * as teamsAgg from './aggregates/teams.mjs';
import * as panelAgg from './aggregates/panel.mjs';
import * as settingsAgg from './aggregates/settings.mjs';

export { interactionView } from './interactions.mjs';

export class Bus extends EventEmitter {
  constructor({ directory, hosts }) {
    super();
    this.store = new Store(directory);
    this.panelBootSeq = panelAgg.bootSeq(this.store);
    this.panelBootId = randomUUID();

    // token 级增量占历史表 76%–97%,逐条 autocommit 会拖垮事件循环;走写合并层。
    this.events = new EventLog(this.store);
    this.telemetry = new Telemetry(this.store, {
      capabilityFor: host => this.hosts.get(host)?.telemetryCapabilities ?? null,
    });
    this.collaboration = new Collaboration(this.store);
    this.information = new Information(this.store);
    this.teamDirectives = new TeamDirectives(this);
    this.teamRequests = new TeamRequests(this);
    this.panelBootReceiptSeq = teamsAgg.latestReceiptSeq(this.store);
    this.hosts = hosts;
    this.running = new Map();
    this.deletingGroups = new Set();
    this.closing = false;
    this.modelCatalogCache = null;
    this.hostCatalogs = new Map();
    this.hostCatalogPending = new Map();
    this.hostCatalogControllers = new Map();
    this.toolStreams = new ToolStreams(this);
    this.interactions = new Interactions(this);
    this.attachments = new Attachments(this);
    this.panel = new PanelSessions(this);
    this.toolDispatch = new ToolDispatch(this);
    this.lifecycle = new GroupLifecycle(this);
    this.dispatch = new MessageDispatch(this);
    this.queries = new BusQueries(this);
    this.turnExecutor = new TurnExecutor(this);
    this.archiveSnapshots = new ArchiveSnapshots(this);
    this.notes = new Notes(this);
    // 旧任务列表没有 step id;把当前控制者的列表提升为当前任期计划,只做一次。
    this.lifecycle.migrateLegacyPlans();
  }
  get panelStreams() { return this.toolStreams.panelStreams; }
  get teamStreams() { return this.toolStreams.teamStreams; }
  panelStreaming(agentId = null) { return this.toolStreams.panelStreaming(agentId); }
  publishPanelStream(event) { this.toolStreams.publishPanelStream(event); }
  teamStreaming(groupId = null) { return this.toolStreams.teamStreaming(groupId); }
  publishTeamStream(event) { this.toolStreams.publishTeamStream(event); }
  createToolStreamRun(scope) { return this.toolStreams.createToolStreamRun(scope); }
  observeToolStreamDelta(scope, streams, payload) { this.toolStreams.observeToolStreamDelta(scope, streams, payload); }
  completeToolMessageStream(turnId, name, args, result, preferredCallId = null) { this.toolStreams.completeToolMessageStream(turnId, name, args, result, preferredCallId); }
  failToolMessageStream(turnId, name, args, error, preferredCallId = null) { this.toolStreams.failToolMessageStream(turnId, name, args, error, preferredCallId); }
  discardToolStreamRun(turnId, type = 'cancelled', error = null) { this.toolStreams.discardToolStreamRun(turnId, type, error); }
  start() {
    this.teamDirectives.recoverOutputs();
    this.startAttachmentCleanup();
    this.startRetentionCleanup();
    this.pump();
  }
  requireHost(host) { if (!this.hosts.has(host)) throw new Error(`宿主未配置: ${host}`); }
  panelAccessValue(...args) { return this.panel.panelAccessValue(...args); }
  panelWorkspace(...args) { return this.panel.panelWorkspace(...args); }
  requirePanelAccess(...args) { return this.panel.requirePanelAccess(...args); }
  panelAgent(...args) { return this.panel.panelAgent(...args); }
  ensurePanelBindings(...args) { return this.panel.ensurePanelBindings(...args); }
  panelTeamRelation(...args) { return this.panel.panelTeamRelation(...args); }
  panelTeamViews(...args) { return this.panel.panelTeamViews(...args); }
  panelAgentState(...args) { return this.panel.panelAgentState(...args); }
  panelBrowserState(...args) { return this.panel.panelBrowserState(...args); }
  panelMessagePage(...args) { return this.panel.panelMessagePage(...args); }
  panelConversation(...args) { return this.panel.panelConversation(...args); }
  createPanelAgent(...args) { return this.panel.createPanelAgent(...args); }
  updatePanelAgent(...args) { return this.panel.updatePanelAgent(...args); }
  createPanelTeam(...args) { return this.panel.createPanelTeam(...args); }
  requirePanelMain(...args) { return this.panel.requirePanelMain(...args); }
  panelTeamSnapshot(...args) { return this.panel.panelTeamSnapshot(...args); }

  requirePolicy(member, policy) {
    const host = this.hosts.get(member.host);
    const support = host?.supportsPolicy?.({ member, policy }) ?? { supported: true };
    if (support === false || support.supported === false) throw new Error(`${member.name}（${member.host}）不支持${policy.mode}${policy.allowShell ? ' + 命令' : ''}：${support.reason ?? '宿主能力不足'}`);
  }
  async modelCatalog({ refresh = false, host: selectedHost } = {}) {
    if (selectedHost) this.requireHost(selectedHost);
    const names = selectedHost ? [selectedHost] : [...this.hosts.keys()];
    const cached = names.every(name => !refresh && this.hostCatalogs.has(name) && Date.now() - this.hostCatalogs.get(name).created < 30000);
    const hosts = await Promise.all(names.map(async hostName => {
      const previous = this.hostCatalogs.get(hostName);
      if (!refresh && previous && Date.now() - previous.created < 30000) return previous.value;
      if (!this.hostCatalogPending.has(hostName)) {
        const pending = (async () => {
          const host = this.hosts.get(hostName);
          let timer;
          const controller = new AbortController();
          this.hostCatalogControllers.set(hostName, controller);
          try {
            if (!host.listModels) throw new Error('宿主适配器未提供模型目录');
            const catalog = await Promise.race([
              Promise.resolve().then(() => host.listModels({ signal: controller.signal })),
              new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('模型目录探测超时')); }, 25000); }),
            ]);
            return { host: hostName, ok: true, catalog };
          } catch (error) { return { host: hostName, ok: false, error: error.message }; }
          finally { clearTimeout(timer); this.hostCatalogControllers.delete(hostName); }
        })().then(value => { this.hostCatalogs.set(hostName, { created: Date.now(), value }); return value; })
          .finally(() => this.hostCatalogPending.delete(hostName));
        this.hostCatalogPending.set(hostName, pending);
      }
      return this.hostCatalogPending.get(hostName);
    }));
    const value = { version: 1, generatedAt: new Date().toISOString(), hosts };
    this.modelCatalogCache = { created: Date.now(), value: { ...value, hosts: [...this.hostCatalogs.values()].map(entry => entry.value) } };
    return { ...value, cached };
  }
  teamController(groupId) {
    const group = this.store.group(groupId);
    const assignment = teamsAgg.controllerAssignment(this.store, groupId);
    if (assignment?.controller_kind === 'panel_agent' && assignment.state === 'active') {
      const agent = panelAgg.controllerAgent(this.store, assignment.controller_id);
      if (!agent) throw new Error('团队 active controller 指向不存在的 Panel Agent');
      return { kind: 'panel_agent', id: agent.id, name: agent.name, agent, assignment };
    }
    if (!group.lead) throw new Error('团队没有可用的主 Agent');
    const member = this.store.member(group.lead);
    return { kind: 'member', id: member.id, name: member.name, member, assignment };
  }
  groupSummary(...args) { return this.queries.groupSummary(...args); }
  overview(...args) { return this.queries.overview(...args); }
  queryDirectory(...args) { return this.queries.queryDirectory(...args); }
  queryDefaults(...args) { return this.queries.queryDefaults(...args); }
  querySessions(...args) { return this.queries.querySessions(...args); }
  querySession(...args) { return this.queries.querySession(...args); }
  queryRuntime(...args) { return this.queries.queryRuntime(...args); }
  queryUnread(...args) { return this.queries.queryUnread(...args); }
  snapshot(...args) { return this.queries.snapshot(...args); }

  panelTool(...args) { return this.panel.panelTool(...args); }
  executePanelTool(...args) { return this.panel.executePanelTool(...args); }
  panelInstructions(...args) { return this.panel.panelInstructions(...args); }
  panelUpdate(...args) { return this.panel.panelUpdate(...args); }
  publishPanelUpdate(...args) { return this.panel.publishPanelUpdate(...args); }
  runPanelTurn(...args) { return this.panel.runPanelTurn(...args); }

  panelPrivateTurn(...args) { return this.panel.panelPrivateTurn(...args); }
  stopPanel(...args) { return this.panel.stopPanel(...args); }
  resolvePanelRuntime(...args) { return this.panel.resolvePanelRuntime(...args); }
  panelInteractionAnchor(...args) { return this.panel.panelInteractionAnchor(...args); }
  requestPanelControllerAction(...args) { return this.panel.requestPanelControllerAction(...args); }
  requestPanelMemberModel(...args) { return this.panel.requestPanelMemberModel(...args); }
  enqueuePanelPrivateAnswer(...args) { return this.panel.enqueuePanelPrivateAnswer(...args); }
  panelUnknown(...args) { return this.panel.panelUnknown(...args); }
  deliverPanel(...args) { return this.dispatch.deliverPanel(...args); }
  deliverPanelPrivate(...args) { return this.dispatch.deliverPanelPrivate(...args); }

  decideInteraction(...args) { return this.interactions.decideInteraction(...args); }
  decideActionInteraction(...args) { return this.interactions.decideActionInteraction(...args); }
  deliverOutcomeSafe(...args) { return this.interactions.deliverOutcomeSafe(...args); }
  memberInteractionAnchor(...args) { return this.interactions.memberInteractionAnchor(...args); }
  requestGroupAction(...args) { return this.interactions.requestGroupAction(...args); }
  controllerState(...args) { return this.lifecycle.controllerState(...args); }
  assertControllerSwitchSafe(...args) { return this.lifecycle.assertControllerSwitchSafe(...args); }
  takeoverTeam(...args) { return this.lifecycle.takeoverTeam(...args); }
  handbackTeam(...args) { return this.lifecycle.handbackTeam(...args); }
  normalizeAgentTasks(...args) { return this.lifecycle.normalizeAgentTasks(...args); }
  setAgentTasks(...args) { return this.lifecycle.setAgentTasks(...args); }
  agentTasksView(...args) { return this.lifecycle.agentTasksView(...args); }
  agentTasksPlanView(...args) { return this.lifecycle.agentTasksPlanView(...args); }
  pendingCancellations(...args) { return this.lifecycle.pendingCancellations(...args); }
  currentPlan(...args) { return this.lifecycle.currentPlan(...args); }
  assertStepRef(...args) { return this.lifecycle.assertStepRef(...args); }
  createGroup(...args) { return this.lifecycle.createGroup(...args); }
  setGroupState(...args) { return this.lifecycle.setGroupState(...args); }
  members(...args) { return this.lifecycle.members(...args); }
  resolveMember(...args) { return this.lifecycle.resolveMember(...args); }
  resolveRecipient(...args) { return this.lifecycle.resolveRecipient(...args); }
  addMember(...args) { return this.lifecycle.addMember(...args); }
  removeMember(...args) { return this.lifecycle.removeMember(...args); }
  deleteGroup(...args) { return this.lifecycle.deleteGroup(...args); }
  archiveSnapshot(groupId) { return this.archiveSnapshots.read(groupId); }
  summarizeArchive(groupId) { return this.archiveSnapshots.start(groupId); }
  archiveGroup(...args) { return this.lifecycle.archiveGroup(...args); }
  restoreGroup(...args) { return this.lifecycle.restoreGroup(...args); }
  directive(...args) { return this.lifecycle.directive(...args); }

  modelPolicy() {
    return settingsAgg.modelPolicy(this.store);
  }
  updateModelPolicy(value) {
    const policy = normalizeModelPolicy(value);
    // presetId 只由调用方显式给出:内容相同的多份配置无法靠文本区分。
    // 内置默认规则用固定哨兵值,让它也能被精确回指(否则保存后无法高亮)。
    let presetId = null;
    if (value?.presetId === BUILTIN_PRESET_ID) {
      presetId = BUILTIN_PRESET_ID;
    } else if (typeof value?.presetId === 'string' && value.presetId) {
      const preset = settingsAgg.presetById(this.store, value.presetId);
      if (!preset) throw new Error('配置不存在');
      presetId = preset.id;
    }
    settingsAgg.updateModelPolicy(this.store, {
      mode: policy.mode,
      rules: policy.rules,
      presetId,
      updated: new Date().toISOString(),
    });
    return this.modelPolicy();
  }
  // 自定义策略配置:编辑辅助层,不参与运行时;激活策略仍是 global_model_policy 单行。
  modelPolicyPresets() {
    return settingsAgg.listPresets(this.store);
  }
  normalizePresetName(name) {
    const value = typeof name === 'string' ? name.trim() : '';
    if (!value || value.length > 60) throw new Error('配置名称需要 1-60 字符');
    return value;
  }
  // 自定义配置只属于「用户配置」模式:智能策略的两个模板是代码内置的,不可自建。
  createModelPolicyPreset({ name, rules }) {
    const normalized = this.normalizePresetName(name);
    if (settingsAgg.presetNameTaken(this.store, normalized)) throw new Error('配置名称已存在');
    const policy = normalizeModelPolicy({ mode: 'user', rules });
    const now = new Date().toISOString();
    settingsAgg.insertPreset(this.store, {
      id: randomUUID(),
      name: normalized,
      mode: 'user',
      rules: policy.rules,
      created: now,
      updated: now,
    });
    return this.modelPolicyPresets().find(row => row.name === normalized);
  }
  renameModelPolicyPreset(id, name) {
    const normalized = this.normalizePresetName(name);
    const existing = settingsAgg.presetById(this.store, id);
    if (!existing) throw new Error('配置不存在');
    const conflict = settingsAgg.presetNameConflict(this.store, normalized, id);
    if (conflict) throw new Error('配置名称已存在');
    settingsAgg.renamePreset(this.store, id, normalized, new Date().toISOString());
    return this.modelPolicyPresets().find(row => row.id === id);
  }
  saveModelPolicyPreset(id, { mode, rules }) {
    const existing = settingsAgg.presetById(this.store, id);
    if (!existing) throw new Error('配置不存在');
    const policy = normalizeModelPolicy({ mode, rules });
    settingsAgg.updatePreset(this.store, id, { mode: policy.mode, rules: policy.rules, updated: new Date().toISOString() });
    return this.modelPolicyPresets().find(row => row.id === id);
  }
  deleteModelPolicyPreset(id) {
    const existing = settingsAgg.presetById(this.store, id);
    if (!existing) throw new Error('配置不存在');
    // 正在使用的配置不允许删除:先切到其他策略再删,避免生效策略失去来源或被静默改写。
    const activePresetId = settingsAgg.activePresetId(this.store);
    if (activePresetId === id) throw new Error('该配置正在使用中，请先切换到其他配置再删除');
    settingsAgg.deletePreset(this.store, id);
    return { deleted: id };
  }
  // 主题包:内置主题随应用发布、不进库(前端代码持有),这里只存用户上传的包。
  // 服务端只做结构级校验(可解析、长度、键数),颜色语义校验在前端导入时完成。
  themePacks() {
    return settingsAgg.listThemePacks(this.store);
  }
  normalizeThemePackName(name) {
    const value = typeof name === 'string' ? name.trim() : '';
    if (!value || value.length > 60) throw new Error('主题名称需要 1-60 字符');
    return value;
  }
  validateThemePackTokens(value, label) {
    if (typeof value !== 'string' || value.length > 16384) throw new Error(`${label}数据过大或缺失`);
    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error(`${label}不是有效 JSON`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label}格式不正确`);
    const keys = Object.keys(parsed);
    if (keys.length > 64) throw new Error(`${label}变量过多`);
    for (const key of keys) {
      const item = parsed[key];
      if (typeof item !== 'string' || item.length > 128) throw new Error(`${label}存在非法变量值`);
    }
  }
  createThemePack({ name, light, dark }) {
    const normalized = this.normalizeThemePackName(name);
    if (settingsAgg.themeNameTaken(this.store, normalized)) throw new Error('主题名称已存在');
    this.validateThemePackTokens(light, '浅色');
    this.validateThemePackTokens(dark, '深色');
    const now = new Date().toISOString();
    const id = randomUUID();
    settingsAgg.insertThemePack(this.store, { id, name: normalized, light, dark, created: now, updated: now });
    return settingsAgg.themePackById(this.store, id);
  }
  deleteThemePack(id) {
    const existing = settingsAgg.themePackById(this.store, id);
    if (!existing) throw new Error('主题不存在');
    // 使用中由各端偏好自行禁删(选中状态存在浏览器端,服务端无全局"当前主题");
    // 跨设备删除后,其他端解析不到该 id 时自动回落内置主题。
    settingsAgg.deleteThemePack(this.store, id);
    return { deleted: id };
  }
  attachmentSettings() {
    return settingsAgg.attachmentSettings(this.store);
  }
  updateAttachmentSettings(value) {
    return settingsAgg.updateAttachmentSettings(this.store, value);
  }
  // 附件模块薄转发;bindTx 只允许在 Store transaction 内经 bus.attachments 调用。
  attachmentUpload(...args) { return this.attachments.upload(...args); }
  attachmentRead(...args) { return this.attachments.read(...args); }
  attachmentDiscard(...args) { return this.attachments.discard(...args); }
  attachmentPrepare(...args) { return this.attachments.prepare(...args); }
  attachmentDescribeMessage(...args) { return this.attachments.describeMessage(...args); }
  attachmentCleanup(...args) { return this.attachments.cleanup(...args); }
  startAttachmentCleanup() {
    // best-effort:启动清一次(.part 全清),之后每小时一次;失败只记录,不影响通信启动。
    try {
      this.attachments.cleanup(new Date(), { partMaxAgeMs: 0 });
    } catch (error) {
      console.error('[attachments] 启动清理失败:', error.message);
    }
    this.attachmentCleanupTimer = setInterval(() => {
      try {
        this.attachments.cleanup(new Date());
      } catch (error) {
        console.error('[attachments] 定期清理失败:', error.message);
      }
    }, 60 * 60 * 1000);
    this.attachmentCleanupTimer.unref();
  }
  // 历史保留:启动 1 分钟后跑一次,之后每 6 小时;异步启动,不阻塞服务。
  startRetentionCleanup() {
    const run = () => {
      try {
        this.store.pruneHistory({ retentionDays: 30 });
      } catch (error) {
        if (!this.closing) console.error('[retention] 历史清理失败:', error.message);
      }
    };
    this.retentionTimer = setTimeout(run, 60 * 1000);
    this.retentionTimer.unref?.();
    this.retentionInterval = setInterval(run, 6 * 60 * 60 * 1000);
    this.retentionInterval.unref?.();
  }
  defaultModelSelection(hostName) {
    const cached = this.modelCatalogCache?.value.hosts.find(item => item.host === hostName && item.ok);
    if (!cached) return null;
    const catalog = cached.catalog;
    const model = catalog.models.find(item => item.key === catalog.defaultModel)
      ?? catalog.models.find(item => item.isDefault)
      ?? catalog.models[0];
    if (!model) return null;
    return {
      model_provider: model.provider ?? null,
      model: model.id,
      reasoning_effort: model.defaultReasoningEffort ?? null,
    };
  }
  async validateMemberModelSelection(member, { model_provider, model, reasoning_effort } = {}) {
    if (model === undefined || model === null || String(model).trim() === '') return null;
    const catalog = await this.modelCatalog({ refresh: true, host: member.host });
    const hostCatalog = catalog.hosts.find(item => item.host === member.host && item.ok && item.catalog);
    if (!hostCatalog) throw new Error(`宿主 ${member.host} 没有可用模型目录`);
    const provider = typeof model_provider === 'string' && model_provider.trim() ? model_provider.trim() : null;
    const selected = hostCatalog.catalog.models.find(item => item.id === model && (!provider || item.provider === provider));
    if (!selected) throw new Error('选择的模型不在该成员宿主目录中');
    const supported = selected.reasoningEfforts.length ? selected.reasoningEfforts : hostCatalog.catalog.reasoningEfforts;
    const effort = reasoning_effort ?? selected.defaultReasoningEffort;
    if (!effort || (supported.length && !supported.some(item => item.id === effort))) throw new Error('模型思考强度不受支持');
    return { model_provider: selected.provider ?? provider ?? null, model: selected.id, reasoning_effort: effort };
  }
  // 互动卡执行器走同步应用:卡创建时已完成目录校验,这里只落库;
  // 若目录此后变化,由成员下一回合的宿主错误暴露,可再次调整。
  applyMemberModel(groupId, memberId, selection) {
    const member = this.resolveMember(groupId, memberId);
    teamsAgg.updateMemberModel(this.store, member.id, selection);
    this.notify(groupId, member.id, `你的模型配置已调整为 ${memberModelSummary(selection)}`);
    return this.store.member(member.id);
  }
  async setMemberModel(groupId, memberId, selection) {
    const member = this.resolveMember(groupId, memberId);
    const validated = await this.validateMemberModelSelection(member, selection);
    return this.applyMemberModel(groupId, member.id, validated);
  }
  // 任务面板:模型自述当前任务,整体替换自己的列表;无阻塞语义,进度由模型控制。
  rules(...args) { return this.toolDispatch.rules(...args); }
  introduce(...args) { return this.toolDispatch.introduce(...args); }
  async tool(...args) { return this.toolDispatch.tool(...args); }
  measureToolCall(...args) { return this.toolDispatch.measureToolCall(...args); }
  async executeTool(...args) { return this.toolDispatch.executeTool(...args); }
  notify(...args) { return this.dispatch.notify(...args); }
  pump(...args) { return this.dispatch.pump(...args); }
  canRun(...args) { return this.dispatch.canRun(...args); }
  deliver(...args) { return this.dispatch.deliver(...args); }
  runEndpoint(...args) { return this.dispatch.runEndpoint(...args); }
  privateTurn(...args) { return this.dispatch.privateTurn(...args); }
  stopWhere(...args) { return this.dispatch.stopWhere(...args); }
  retry(...args) { return this.dispatch.retry(...args); }
  pruneHistory(...args) { return this.store.pruneHistory(...args); }
  resetSession(...args) { return this.dispatch.resetSession(...args); }

  telemetryConversation(groupId, memberId, peerId, options = {}) {
    return this.telemetry.conversation(groupId, memberId, peerId, options);
  }
  telemetryManagerConversation(groupId, memberId, options = {}) {
    if (!teamsAgg.groupExists(this.store, groupId)) {
      throw Object.assign(new Error('群不存在'), { status: 404 });
    }
    return this.telemetry.managerConversation(groupId, this.teamController(groupId), memberId, options);
  }
  telemetryCoordination(groupId, options = {}) {
    const controller = this.teamController(groupId);
    return this.telemetry.coordination(groupId, controller, options);
  }
  telemetryMembers(groupId, options = {}) {
    return this.telemetry.members(groupId, options);
  }
  telemetryCapabilities(groupId) {
    const controllers = [];
    try { controllers.push(this.teamController(groupId)); } catch { /* A group without a controller still has host capability declarations. */ }
    return this.telemetry.capabilities(groupId, controllers);
  }
  informationManifest(turnId) {
    return this.information.manifest(turnId);
  }
  // 与团队无关的全局状态。团队页每次切换 groupId 都会重新拉 scoped snapshot,
  // 但侧栏需要的团队/成员列表并不随团队变化,单独提供以免整棵侧栏闪一次空态。
  async close() {
    this.closing = true;
    if (this.attachmentCleanupTimer) {
      clearInterval(this.attachmentCleanupTimer);
      this.attachmentCleanupTimer = null;
    }
    if (this.retentionTimer) {
      clearTimeout(this.retentionTimer);
      this.retentionTimer = null;
    }
    if (this.retentionInterval) {
      clearInterval(this.retentionInterval);
      this.retentionInterval = null;
    }
    for (const controller of this.hostCatalogControllers.values()) controller.abort(new Error('服务正在停止'));
    await Promise.allSettled([...this.hosts.values()].map(host => host.cancelProbe?.()));
    await this.stopWhere(() => true);
    await Promise.allSettled([...this.archiveSnapshots.pending.values()]);
    await Promise.allSettled([...this.hosts.values()].map(host => host.close?.()));
    await Promise.allSettled([...this.hostCatalogPending.values()]);
    // 停止所有回合后缓冲里可能还有尾段增量,必须在关闭数据库前落盘。
    this.events.close();
    this.store.close();
  }
  endpointTools(id, key) {
    if (this.store.conversationById(id)?.context === 'archive-summary') return [];
    if (this.store.conversationById(id)?.owner_kind === 'panel_agent') {
      const { session } = this.store.authenticatePanelSession(id, key);
      return panelToolsFor(session.context);
    }
    const e = this.store.authenticate(id, key);
    return toolsFor(this.store.member(e.member_id).role, e.context);
  }
}
