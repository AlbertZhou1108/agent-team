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
import { toolsFor, validateTool } from './tools.mjs';
import { panelToolsFor } from './panel-tools.mjs';
import { Collaboration } from './collaboration.mjs';
import { GroupLifecycle } from './group-lifecycle.mjs';
import { Information, CONTEXT_SCHEMA_VERSION } from './information.mjs';
import {
  memberRules,
  legacyMemberRules,
  profileIntro,
} from './prompts.mjs';
import {
  BUILTIN_PRESET_ID,
  normalizeModelPolicy,
} from './model-policy.mjs';
import { memberModelSummary } from './model-policy.mjs';
import { Interactions } from './interactions.mjs';
import { Attachments } from './attachments.mjs';
import { PanelSessions } from './panel-sessions.mjs';

export { interactionView } from './interactions.mjs';

export class Bus extends EventEmitter {
  constructor({ directory, hosts }) {
    super();
    this.store = new Store(directory);
    this.panelBootSeq = this.store.get('SELECT COALESCE(MAX(seq),0) AS seq FROM panel_messages').seq;
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
    this.panelBootReceiptSeq = this.store.get('SELECT COALESCE(MAX(seq),0) AS seq FROM team_request_receipts').seq;
    this.hosts = hosts;
    this.running = new Map();
    this.closing = false;
    this.modelCatalogCache = null;
    this.modelCatalogPending = null;
    this.toolStreams = new ToolStreams(this);
    this.interactions = new Interactions(this);
    this.attachments = new Attachments(this);
    this.panel = new PanelSessions(this);
    this.lifecycle = new GroupLifecycle(this);
    this.dispatch = new MessageDispatch(this);
    this.queries = new BusQueries(this);
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
    // Serving the panel does not implicitly resume historical work.
    this.store.run("UPDATE panel_turns SET state='unknown',ended=? WHERE state='running'", new Date().toISOString());
    this.startAttachmentCleanup();
    this.pumpPanelUpdates();
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
  async modelCatalog({ refresh = false } = {}) {
    if (!refresh && this.modelCatalogCache && Date.now() - this.modelCatalogCache.created < 30000) {
      return { ...this.modelCatalogCache.value, cached: true };
    }
    if (!refresh && this.modelCatalogPending) return this.modelCatalogPending;
    this.modelCatalogPending = (async () => {
      const hosts = await Promise.all([...this.hosts].map(async ([hostName, host]) => {
        if (typeof host.listModels !== 'function') {
          return { host: hostName, ok: false, error: '宿主适配器未提供模型目录' };
        }
        let timer;
        try {
          const catalog = await Promise.race([
            Promise.resolve().then(() => host.listModels()),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error('模型目录探测超时')), 25000);
            }),
          ]);
          return { host: hostName, ok: true, catalog };
        } catch (error) {
          return { host: hostName, ok: false, error: error instanceof Error ? error.message : String(error) };
        } finally {
          clearTimeout(timer);
        }
      }));
      const value = { version: 1, generatedAt: new Date().toISOString(), hosts };
      this.modelCatalogCache = { created: Date.now(), value };
      return { ...value, cached: false };
    })();
    try {
      return await this.modelCatalogPending;
    } finally {
      this.modelCatalogPending = null;
    }
  }
  teamController(groupId) {
    const group = this.store.group(groupId);
    const assignment = this.store.get('SELECT * FROM team_lead_controllers WHERE group_id=?', groupId);
    if (assignment?.controller_kind === 'panel_agent' && assignment.state === 'active') {
      const agent = this.store.get('SELECT * FROM panel_agents WHERE id=?', assignment.controller_id);
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
  pendingPanelUpdates(...args) { return this.panel.pendingPanelUpdates(...args); }
  publishPanelUpdate(...args) { return this.panel.publishPanelUpdate(...args); }
  markPanelUpdatesDelivered(...args) { return this.panel.markPanelUpdatesDelivered(...args); }
  pumpPanelUpdates(...args) { return this.panel.pumpPanelUpdates(...args); }
  runPanelTurn(...args) { return this.panel.runPanelTurn(...args); }

  panelPrivateTurn(...args) { return this.panel.panelPrivateTurn(...args); }
  stopPanel(...args) { return this.panel.stopPanel(...args); }
  resolvePanelRuntime(...args) { return this.panel.resolvePanelRuntime(...args); }
  panelInteractionAnchor(...args) { return this.panel.panelInteractionAnchor(...args); }
  requestPanelControllerAction(...args) { return this.panel.requestPanelControllerAction(...args); }
  requestPanelMemberModel(...args) { return this.panel.requestPanelMemberModel(...args); }
  deliverToPanelPrivate(...args) { return this.panel.deliverToPanelPrivate(...args); }
  flushPanelPrivateDeliveries(...args) { return this.panel.flushPanelPrivateDeliveries(...args); }
  panelUnknown(...args) { return this.panel.panelUnknown(...args); }
  deliverPanel(...args) { return this.panel.deliverPanel(...args); }
  failPanelDelivery(...args) { return this.panel.failPanelDelivery(...args); }

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
  createGroup(...args) { return this.lifecycle.createGroup(...args); }
  setGroupState(...args) { return this.lifecycle.setGroupState(...args); }
  members(...args) { return this.lifecycle.members(...args); }
  resolveMember(...args) { return this.lifecycle.resolveMember(...args); }
  resolveRecipient(...args) { return this.lifecycle.resolveRecipient(...args); }
  addMember(...args) { return this.lifecycle.addMember(...args); }
  removeMember(...args) { return this.lifecycle.removeMember(...args); }
  deleteGroup(...args) { return this.lifecycle.deleteGroup(...args); }
  archiveGroup(...args) { return this.lifecycle.archiveGroup(...args); }
  restoreGroup(...args) { return this.lifecycle.restoreGroup(...args); }
  directive(...args) { return this.lifecycle.directive(...args); }

  modelPolicy() {
    return this.store.get('SELECT mode,rules,preset_id,created,updated FROM global_model_policy WHERE singleton=1');
  }
  updateModelPolicy(value) {
    const policy = normalizeModelPolicy(value);
    // presetId 只由调用方显式给出:内容相同的多份配置无法靠文本区分。
    // 内置默认规则用固定哨兵值,让它也能被精确回指(否则保存后无法高亮)。
    let presetId = null;
    if (value?.presetId === BUILTIN_PRESET_ID) {
      presetId = BUILTIN_PRESET_ID;
    } else if (typeof value?.presetId === 'string' && value.presetId) {
      const preset = this.store.get('SELECT id FROM model_policy_presets WHERE id=?', value.presetId);
      if (!preset) throw new Error('配置不存在');
      presetId = preset.id;
    }
    this.store.run(
      'UPDATE global_model_policy SET mode=?,rules=?,preset_id=?,updated=? WHERE singleton=1',
      policy.mode,
      policy.rules,
      presetId,
      new Date().toISOString(),
    );
    return this.modelPolicy();
  }
  // 自定义策略配置:编辑辅助层,不参与运行时;激活策略仍是 global_model_policy 单行。
  modelPolicyPresets() {
    return this.store.all('SELECT id,name,mode,rules,created,updated FROM model_policy_presets ORDER BY updated DESC');
  }
  normalizePresetName(name) {
    const value = typeof name === 'string' ? name.trim() : '';
    if (!value || value.length > 60) throw new Error('配置名称需要 1-60 字符');
    return value;
  }
  // 自定义配置只属于「用户配置」模式:智能策略的两个模板是代码内置的,不可自建。
  createModelPolicyPreset({ name, rules }) {
    const normalized = this.normalizePresetName(name);
    if (this.store.get('SELECT 1 FROM model_policy_presets WHERE name=?', normalized)) throw new Error('配置名称已存在');
    const policy = normalizeModelPolicy({ mode: 'user', rules });
    const now = new Date().toISOString();
    this.store.run(
      'INSERT INTO model_policy_presets(id,name,mode,rules,created,updated) VALUES(?,?,?,?,?,?)',
      randomUUID(),
      normalized,
      'user',
      policy.rules,
      now,
      now,
    );
    return this.modelPolicyPresets().find(row => row.name === normalized);
  }
  renameModelPolicyPreset(id, name) {
    const normalized = this.normalizePresetName(name);
    const existing = this.store.get('SELECT * FROM model_policy_presets WHERE id=?', id);
    if (!existing) throw new Error('配置不存在');
    const conflict = this.store.get('SELECT 1 FROM model_policy_presets WHERE name=? AND id<>?', normalized, id);
    if (conflict) throw new Error('配置名称已存在');
    this.store.run('UPDATE model_policy_presets SET name=?,updated=? WHERE id=?', normalized, new Date().toISOString(), id);
    return this.modelPolicyPresets().find(row => row.id === id);
  }
  saveModelPolicyPreset(id, { mode, rules }) {
    const existing = this.store.get('SELECT * FROM model_policy_presets WHERE id=?', id);
    if (!existing) throw new Error('配置不存在');
    const policy = normalizeModelPolicy({ mode, rules });
    this.store.run('UPDATE model_policy_presets SET mode=?,rules=?,updated=? WHERE id=?', policy.mode, policy.rules, new Date().toISOString(), id);
    return this.modelPolicyPresets().find(row => row.id === id);
  }
  deleteModelPolicyPreset(id) {
    const existing = this.store.get('SELECT * FROM model_policy_presets WHERE id=?', id);
    if (!existing) throw new Error('配置不存在');
    // 正在使用的配置不允许删除:先切到其他策略再删,避免生效策略失去来源或被静默改写。
    const active = this.store.get('SELECT preset_id FROM global_model_policy WHERE singleton=1');
    if (active?.preset_id === id) throw new Error('该配置正在使用中，请先切换到其他配置再删除');
    this.store.run('DELETE FROM model_policy_presets WHERE id=?', id);
    return { deleted: id };
  }
  // 主题包:内置主题随应用发布、不进库(前端代码持有),这里只存用户上传的包。
  // 服务端只做结构级校验(可解析、长度、键数),颜色语义校验在前端导入时完成。
  themePacks() {
    return this.store.all('SELECT id,name,light,dark,created,updated FROM theme_packs ORDER BY updated DESC');
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
    if (this.store.get('SELECT 1 FROM theme_packs WHERE name=?', normalized)) throw new Error('主题名称已存在');
    this.validateThemePackTokens(light, '浅色');
    this.validateThemePackTokens(dark, '深色');
    const now = new Date().toISOString();
    const id = randomUUID();
    this.store.run(
      'INSERT INTO theme_packs(id,name,light,dark,created,updated) VALUES(?,?,?,?,?,?)',
      id,
      normalized,
      light,
      dark,
      now,
      now,
    );
    return this.store.get('SELECT id,name,light,dark,created,updated FROM theme_packs WHERE id=?', id);
  }
  deleteThemePack(id) {
    const existing = this.store.get('SELECT id FROM theme_packs WHERE id=?', id);
    if (!existing) throw new Error('主题不存在');
    // 使用中由各端偏好自行禁删(选中状态存在浏览器端,服务端无全局"当前主题");
    // 跨设备删除后,其他端解析不到该 id 时自动回落内置主题。
    this.store.run('DELETE FROM theme_packs WHERE id=?', id);
    return { deleted: id };
  }
  attachmentSettings() {
    return this.store.attachmentSettings();
  }
  updateAttachmentSettings(value) {
    return this.store.updateAttachmentSettings(value);
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
    const catalog = await this.modelCatalog({ refresh: true });
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
    this.store.run(
      'UPDATE members SET model_provider=?,model=?,reasoning_effort=? WHERE id=?',
      selection?.model_provider ?? null,
      selection?.model ?? null,
      selection?.reasoning_effort ?? null,
      member.id,
    );
    this.notify(groupId, member.id, `你的模型配置已调整为 ${memberModelSummary(selection)}`);
    return this.store.member(member.id);
  }
  async setMemberModel(groupId, memberId, selection) {
    const member = this.resolveMember(groupId, memberId);
    const validated = await this.validateMemberModelSelection(member, selection);
    return this.applyMemberModel(groupId, member.id, validated);
  }
  // 任务面板:模型自述当前任务,整体替换自己的列表;无阻塞语义,进度由模型控制。
  rules(endpoint, schema = this.information.memberSchemaForEndpoint(endpoint.id)) {
    const member = this.store.member(endpoint.member_id);
    if (schema === CONTEXT_SCHEMA_VERSION) {
      const modelPolicy = member.role === 'lead' && ['coordination', 'private'].includes(endpoint.context) ? this.modelPolicy() : null;
      return memberRules(member, { modelPolicy });
    }
    // Legacy sessions keep plain communication rules; their turn inputs stay
    // raw JSON so old host conversations remain readable.
    const membersJson = JSON.stringify(this.members(member.group_id).map(({ id, name, profile }) => ({ id, name, profile })));
    return legacyMemberRules(member, membersJson);
  }
  introduce(member) {
    if (this.closing) return;
    const endpoint = this.store.endpoint(member.id, 'profile');
    this.runEndpoint(endpoint, profileIntro()).catch(error => {
      if (!this.closing) this.notify(member.group_id, this.teamController(member.group_id).id, `成员 ${member.name} 入群说明失败：${error.message}`);
    });
  }
  async tool(endpointId, key, name, args, provenance = {}) {
    if (endpointId.startsWith('panel-session-')) return this.panelTool(endpointId, key, name, args, provenance);
    const endpoint = this.store.authenticate(endpointId, key);
    const member = this.store.member(endpoint.member_id);
    validateTool(member.role, name, args, endpoint.context);
    const { turnId, nativeCallId = null } = provenance;
    if (turnId && this.running.get(endpointId)?.turnId !== turnId) throw new Error('工具不属于当前执行回合');
    const origin = turnId ? { turnId, callId: randomUUID(), nativeCallId } : null;
    if (origin) origin.eventSeq = this.events.member(endpointId, { type: 'framework.tool_call', name, args, callId: origin.callId, nativeCallId }, turnId);
    try {
      const result = await this.executeTool(endpointId, key, name, args, origin);
      this.measureToolCall({ groupId: member.group_id, endpointId, turnId, name, args, result, schema: this.information.toolSchema(turnId, endpointId) });
      if (origin) this.events.member(endpointId, { type: 'framework.tool_result', callId: origin.callId, result }, turnId);
      return result;
    } catch (error) {
      if (origin) this.events.member(endpointId, { type: 'framework.tool_result', callId: origin.callId, error: error.message }, turnId);
      throw error;
    }
  }
  measureToolCall({ groupId, endpointId, turnId, name, args, result, schema }) {
    if (!turnId) return;
    try {
      const detail = { view: result?.view ?? null, complete: result?.complete ?? null, hasMore: result?.hasMore ?? null };
      if (args?.messageId) {
        detail.expansion = true;
        detail.messageId = args.messageId;
        detail.offset = result?.offset ?? args.offset ?? 0;
        detail.bodyLimit = args.bodyLimit ?? null;
        detail.next = result?.next ?? null;
      }
      if (args?.itemId) detail.itemId = args.itemId;
      if (Array.isArray(result?.omissions)) detail.omissions = result.omissions.length;
      this.information.measureToolResult({ groupId, endpointId, turnId, schemaVersion: schema, name, result, detail });
    } catch {
      // Measurement is observational and must never change a tool outcome.
    }
  }
  async executeTool(endpointId, key, name, args, origin) {
    const endpoint = this.store.authenticate(endpointId, key);
    const member = this.store.member(endpoint.member_id);
    validateTool(member.role, name, args, endpoint.context);
    const groupId = member.group_id;
    if (name === 'model_catalog') return this.modelCatalog({ refresh: true });
    if (name === 'members') return this.members(groupId).map(({ id, name: displayName, host, role, profile }) => ({ id, name: displayName, host, role, profile }));
    if (name === 'read') {
      const schema = this.information.toolSchema(origin?.turnId, endpoint.id);
      if (args.messageId) {
        if (args.after !== undefined || args.limit !== undefined || args.sender !== undefined) {
          throw new Error('正文展开不能同时使用列表参数');
        }
        return this.information.readBody({
          groupId,
          messageId: args.messageId,
          hash: args.hash,
          offset: args.offset ?? 0,
          bodyLimit: args.bodyLimit ?? 1024,
          schema,
        });
      }
      if (args.hash !== undefined || args.offset !== undefined || args.bodyLimit !== undefined) {
        throw new Error('hash、offset、bodyLimit 需要同时提供 messageId');
      }
      const senderId = args.sender ? this.resolveMember(groupId, args.sender).id : null;
      return this.information.listMessages({
        groupId,
        after: args.after ?? 0,
        limit: args.limit ?? 50,
        senderId,
        schema,
      });
    }
    if (name === 'profile_set') { this.store.run('UPDATE members SET profile=? WHERE id=?', args.text, member.id); return { member: member.id, profile: args.text }; }
    if (name === 'send' || name === 'note') {
      this.collaboration.requireCommunication(groupId);
      const target = this.resolveRecipient(groupId, args.to);
      if (target.id === member.id) throw new Error('不能向自己发消息');
      const message = this.store.transaction(() => {
        const value = this.store.append(groupId, member.id, target.id, name, args.text);
        if (origin) this.store.run('INSERT INTO message_origins VALUES(?,?,?,?,?)', value.id, origin.turnId, origin.eventSeq, origin.callId, origin.nativeCallId);
        return value;
      });
      this.emit('message', message);
      if (origin?.turnId) {
        this.completeToolMessageStream(
          origin.turnId,
          name,
          args,
          { messageId: message.id },
          origin.nativeCallId,
        );
      }
      queueMicrotask(() => this.pump());
      return { messageId: message.id };
    }
    if (name === 'ask') {
      if (!origin) throw new Error('互动卡只能在执行回合内发出');
      this.collaboration.requireCommunication(groupId);
      if (args.kind === 'choice' && !Array.isArray(args.options)) throw new Error('choice 必须提供 options');
      if (args.kind === 'input' && args.options !== undefined) throw new Error('input 不接受 options');
      if (member.role !== 'lead') this.store.endpoint(member.id, 'pair:user', 'user');
      const message = this.store.transaction(() => {
        const value = this.store.append(groupId, member.id, 'user', 'send', args.text);
        this.store.run('INSERT INTO message_origins VALUES(?,?,?,?,?)', value.id, origin.turnId, origin.eventSeq, origin.callId, origin.nativeCallId);
        return value;
      });
      this.emit('message', message);
      const interaction = this.store.createInteraction({
        id: randomUUID(),
        groupId,
        memberId: member.id,
        endpointId: endpoint.id,
        context: endpoint.context,
        turnId: origin.turnId,
        callId: origin.callId,
        messageId: message.id,
        kind: args.kind,
        payload: { kind: args.kind, text: args.text, ...(args.options ? { options: args.options } : {}) },
      });
      return { interaction: interaction.id, state: interaction.state };
    }
    if (name === 'tasks_set') {
      return this.setAgentTasks({ groupId, ownerId: member.id, tasks: args.tasks });
    }
    if (name === 'groups') return this.store.all('SELECT * FROM groups ORDER BY created');
    if (name === 'group_create') {
      const people = (args.members ?? '').split(',').filter(Boolean).map(item => {
        const [name, host, ...extra] = item.trim().split('=');
        if (!name || !host || extra.length) throw new Error('成员格式应为 名称=宿主');
        this.requireHost(host);
        return { name, host };
      });
      return this.requestGroupAction(member, endpoint, origin, 'group_create',
        `请求创建团队「${args.name}」（工作区 ${args.workspace}）`,
        { name: args.name, workspace: args.workspace, lead: { name: member.name, host: member.host }, members: people });
    }
    if (name === 'group_add') {
      this.requireHost(args.host);
      if (args.name.trim().length > 100) throw new Error('成员名称无效');
      return this.requestGroupAction(member, endpoint, origin, 'group_add',
        `请求向本群添加成员 ${args.name}（${args.host}）`,
        { name: args.name, host: args.host });
    }
    if (name === 'group_remove') return this.removeMember(groupId, args.member);
    if (name === 'group_delete') {
      return this.requestGroupAction(member, endpoint, origin, 'group_delete',
        `请求删除群 ${this.store.group(groupId).name} 的配置与消息记录`,
        {});
    }
    if (name === 'member_model') {
      const target = this.resolveMember(groupId, args.member);
      if (target.role !== 'member') throw new Error('member_model 只能调整普通成员');
      const selection = await this.validateMemberModelSelection(target, args);
      return this.requestGroupAction(member, endpoint, origin, 'member_model',
        `请求将成员 ${target.name} 的模型调整为 ${memberModelSummary(selection)}`,
        { member: args.member, ...(selection ?? {}) });
    }
    throw new Error('工具不存在');
  }
  notify(...args) { return this.dispatch.notify(...args); }
  pump(...args) { return this.dispatch.pump(...args); }
  canRun(...args) { return this.dispatch.canRun(...args); }
  deliver(...args) { return this.dispatch.deliver(...args); }
  runEndpoint(...args) { return this.dispatch.runEndpoint(...args); }
  privateTurn(...args) { return this.dispatch.privateTurn(...args); }
  stopWhere(...args) { return this.dispatch.stopWhere(...args); }
  retry(...args) { return this.dispatch.retry(...args); }
  resetSession(...args) { return this.dispatch.resetSession(...args); }

  telemetryConversation(groupId, memberId, peerId, options = {}) {
    return this.telemetry.conversation(groupId, memberId, peerId, options);
  }
  telemetryManagerConversation(groupId, memberId, options = {}) {
    if (!this.store.get('SELECT 1 FROM groups WHERE id=?', groupId)) {
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
    await this.stopWhere(() => true);
    await Promise.allSettled([...this.hosts.values()].map(host => host.close?.()));
    // 停止所有回合后缓冲里可能还有尾段增量,必须在关闭数据库前落盘。
    this.events.close();
    this.store.close();
  }
  endpointTools(id, key) {
    if (id.startsWith('panel-session-')) {
      const { session } = this.store.authenticatePanelSession(id, key);
      return panelToolsFor(session.context);
    }
    const e = this.store.authenticate(id, key);
    return toolsFor(this.store.member(e.member_id).role, e.context);
  }
}
