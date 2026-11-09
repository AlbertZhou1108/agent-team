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
import { Interactions } from './interactions.mjs';
import { Attachments } from './attachments.mjs';
import { PanelSessions } from './panel-sessions.mjs';
import { TurnExecutor } from './turn-executor.mjs';
import { ToolDispatch } from './tool-dispatch.mjs';
import { ArchiveSnapshots } from './archive-snapshots.mjs';
import { Notes } from './notes.mjs';
import { ControlPlane } from './control-plane.mjs';
import * as teamsAgg from './aggregates/teams.mjs';
import * as externalAgg from './aggregates/external-control.mjs';
import * as panelAgg from './aggregates/panel.mjs';
import { Maintenance } from './bus/maintenance.mjs';
import { ModelCatalog } from './bus/model-catalog.mjs';
import { AppSettings } from './bus/app-settings.mjs';

export { interactionView } from './interactions.mjs';

export class Bus extends EventEmitter {
  constructor({ directory, hosts, externalWake, controlSocketPath = null }) {
    super();
    this.store = new Store(directory);
    this.controlSocketPath = controlSocketPath;
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
    this.controlPlane = new ControlPlane(this, externalWake ? { wake: externalWake } : {});
    this.maintenance = new Maintenance(this);
    this.models = new ModelCatalog(this);
    this.appSettings = new AppSettings(this);
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
    this.maintenance.start();
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
  async modelCatalog(...args) { return this.models.list(...args); }
  teamController(groupId) {
    const group = this.store.group(groupId);
    const assignment = teamsAgg.controllerAssignment(this.store, groupId);
    if (assignment?.controller_kind === 'external_agent' && assignment.state === 'active') {
      const principal = externalAgg.principal(this.store, assignment.controller_id);
      if (!principal) throw new Error('团队 active controller 指向不存在的外部主控');
      return { kind: 'external_agent', id: principal.id, name: principal.name, principal, assignment };
    }
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

  modelPolicy(...args) { return this.appSettings.modelPolicy(...args); }
  updateModelPolicy(...args) { return this.appSettings.updateModelPolicy(...args); }
  modelPolicyPresets(...args) { return this.appSettings.modelPolicyPresets(...args); }
  createModelPolicyPreset(...args) { return this.appSettings.createPreset(...args); }
  renameModelPolicyPreset(...args) { return this.appSettings.renamePreset(...args); }
  saveModelPolicyPreset(...args) { return this.appSettings.savePreset(...args); }
  deleteModelPolicyPreset(...args) { return this.appSettings.deletePreset(...args); }
  themePacks(...args) { return this.appSettings.themePacks(...args); }
  createThemePack(...args) { return this.appSettings.createThemePack(...args); }
  deleteThemePack(...args) { return this.appSettings.deleteThemePack(...args); }
  attachmentSettings(...args) { return this.appSettings.attachmentSettings(...args); }
  updateAttachmentSettings(...args) { return this.appSettings.updateAttachmentSettings(...args); }
  // 附件模块薄转发;bindTx 只允许在 Store transaction 内经 bus.attachments 调用。
  attachmentUpload(...args) { return this.attachments.upload(...args); }
  attachmentRead(...args) { return this.attachments.read(...args); }
  attachmentDiscard(...args) { return this.attachments.discard(...args); }
  attachmentPrepare(...args) { return this.attachments.prepare(...args); }
  attachmentDescribeMessage(...args) { return this.attachments.describeMessage(...args); }
  attachmentCleanup(...args) { return this.attachments.cleanup(...args); }
  defaultModelSelection(...args) { return this.models.defaultSelection(...args); }
  validateMemberModelSelection(...args) { return this.models.validate(...args); }
  applyMemberModel(...args) { return this.models.apply(...args); }
  setMemberModel(...args) { return this.models.set(...args); }
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
  controlTools(...args) { return this.controlPlane.tools(...args); }
  controlTool(...args) { return this.controlPlane.tool(...args); }
  enqueueExternalMessage(...args) { return this.controlPlane.enqueueIncomingMessage(...args); }

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
    // 先停表：定时器若在 store 关闭后触发会拿到已关闭的连接。
    this.maintenance.stop();
    this.models.abort();
    await Promise.allSettled([...this.hosts.values()].map(host => host.cancelProbe?.()));
    await this.stopWhere(() => true);
    await Promise.allSettled([...this.archiveSnapshots.pending.values()]);
    await Promise.allSettled([...this.hosts.values()].map(host => host.close?.()));
    await this.models.settled();
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
