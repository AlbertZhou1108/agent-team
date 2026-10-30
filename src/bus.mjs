import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { statSync, rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { Store } from './store.mjs';
import { EventLog } from './event-log.mjs';
import { TeamRequests } from './team-requests.mjs';
import { TeamDirectives } from './team-directives.mjs';
import { Telemetry, telemetryObservation } from './telemetry.mjs';
import { ToolStreams } from './tool-streams.mjs';
import { toolsFor, validateTool } from './tools.mjs';
import { panelToolsFor, validatePanelTool } from './panel-tools.mjs';
import { Collaboration } from './collaboration.mjs';
import { GroupLifecycle } from './group-lifecycle.mjs';
import { Information, CONTEXT_SCHEMA_VERSION } from './information.mjs';
import {
  memberRules,
  legacyMemberRules,
  profileIntro,
  legacyGroupDeliveryPrompt,
} from './prompts.mjs';
import {
  BUILTIN_PRESET_ID,
  DEFAULT_USER_MODEL_RULES,
  SMART_COST_RULES,
  SMART_PERFORMANCE_RULES,
  normalizeModelPolicy,
} from './model-policy.mjs';
import { memberModelSummary } from './model-policy.mjs';
import { Interactions } from './interactions.mjs';
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
    this.panel = new PanelSessions(this);
    this.lifecycle = new GroupLifecycle(this);
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
  groupSummary(groupId) {
    this.store.group(groupId);
    return {
      communicationOpen: this.collaboration.communicationOpen(groupId),
      unknown: this.collaboration.unknown(groupId),
      runningCount: [...this.running.values()].filter(item => item.endpoint.group_id === groupId).length,
    };
  }
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
  notify(groupId, recipient, text) {
    if (this.closing || !recipient || !this.store.get('SELECT 1 FROM groups WHERE id=?', groupId)) return;
    const notice = this.store.append(groupId, 'system', recipient, 'system', text);
    this.emit('notice', notice);
  }
  pump() {
    if (this.closing) return;
    for (const entry of this.store.all('SELECT * FROM panel_outbox WHERE accepted IS NULL AND error IS NULL ORDER BY rowid')) {
      const session = this.store.get('SELECT * FROM panel_sessions WHERE id=?', entry.session_id);
      if (session && this.canRun(session.group_id) && !this.running.has(entry.session_id)) {
        this.deliverPanel(entry);
      }
    }
    for (const entry of this.store.all('SELECT * FROM outbox WHERE accepted IS NULL AND error IS NULL ORDER BY rowid')) {
      const endpoint = this.store.get('SELECT * FROM endpoints WHERE id=?', entry.endpoint_id);
      if (endpoint && this.canRun(endpoint.group_id) && !this.running.has(entry.endpoint_id)) this.deliver(entry);
    }
    for (const message of this.store.pending()) {
      if (this.store.get('SELECT 1 FROM attached WHERE message_id=?', message.id)) continue;
      if (this.store.get('SELECT 1 FROM panel_attached WHERE message_id=?', message.id)) continue;
      if (!this.canRun(message.group_id)) continue;
      const controller = this.teamController(message.group_id);
      if (message.recipient === controller.id && controller.kind === 'panel_agent') {
        const session = this.store.panelSession(controller.id, 'coordination', message.group_id);
        if (this.running.has(session.id) || this.store.get('SELECT 1 FROM panel_outbox WHERE session_id=? AND accepted IS NULL AND error IS NULL', session.id)) continue;
        const entry = this.store.preparePanel(message, session);
        if (entry) this.deliverPanel(entry);
        continue;
      }
      const endpoint = this.store.endpoint(message.recipient, message.recipient === controller.id ? 'coordination' : `pair:${message.sender}`, message.recipient === controller.id ? null : message.sender);
      if (this.running.has(endpoint.id) || this.store.get('SELECT 1 FROM outbox WHERE endpoint_id=? AND accepted IS NULL AND error IS NULL', endpoint.id)) continue;
      const entry = this.store.prepare(message, endpoint);
      if (entry) this.deliver(entry);
    }
  }
  canRun(groupId) {
    return this.collaboration.communicationOpen(groupId)
      && !this.collaboration.unknown(groupId).length
      && !this.panelUnknown(groupId).length;
  }
  deliver(entry) {
    const endpoint = this.store.get('SELECT * FROM endpoints WHERE id=?', entry.endpoint_id);
    if (!endpoint || !this.store.get('SELECT 1 FROM members WHERE id=? AND removed IS NULL', endpoint.member_id)) return;
    const input = JSON.parse(entry.payload);
    this.runEndpoint(endpoint, context => {
      if (context.schema !== CONTEXT_SCHEMA_VERSION) {
        return legacyGroupDeliveryPrompt(input);
      }
      const group = this.store.group(endpoint.group_id);
      return JSON.stringify(this.information.turnInput({
        group,
        charter: group.charter,
        policy: context.policy,
        input,
        schema: context.schema,
      }));
    }, () => {
      this.store.run('UPDATE outbox SET accepted=? WHERE id=?', new Date().toISOString(), entry.id);
    }, [input.message, ...(input.additionalMessages ?? []), ...input.notes]).catch(error => {
      this.store.run('UPDATE outbox SET error=? WHERE id=?', error.message, entry.id);
      if (this.closing) return;
      const accepted = this.store.get('SELECT accepted FROM outbox WHERE id=?', entry.id)?.accepted;
      this.notify(endpoint.group_id, input.message.sender, `消息 ${input.message.id} 发给成员 ${endpoint.member_id} 的会话失败：${error.message}。${accepted ? '宿主已经接受输入；请查看宿主记录决定是否另发消息。' : '不会自动重试；核实后可用 /retry 明确重试。'}`);
    });
  }
  async runEndpoint(endpoint, text, onAccepted = () => {}, inputs = []) {
    this.collaboration.requireCommunication(endpoint.group_id);
    if (this.running.has(endpoint.id)) throw new Error('该会话正在运行');
    const member = this.store.member(endpoint.member_id);
    const group = this.store.group(member.group_id);
    const host = this.hosts.get(member.host);
    if (!host) throw new Error(`宿主未配置: ${member.host}`);
    const abort = new AbortController();
    const policy = this.collaboration.policy(endpoint);
    this.requirePolicy(member, policy);
    const sessionKey = typeof host.sessionKey === 'function' ? host.sessionKey({ policy, endpoint, member }) : 'default';
    if (typeof sessionKey !== 'string' || !sessionKey.trim()) throw new Error('宿主会话域无效');
    const binding = this.store.get('SELECT * FROM endpoint_session_bindings WHERE endpoint_id=? AND session_key=?', endpoint.id, sessionKey);
    const fallbackSession = sessionKey === 'default' ? endpoint.session : null;
    const effectiveEndpoint = { ...endpoint, session: binding?.session ?? fallbackSession };
    const previousPolicy = this.store.get('SELECT signature FROM endpoint_session_policies WHERE endpoint_id=? AND session_key=?', endpoint.id, sessionKey)
      ?? (!binding && fallbackSession ? this.store.get('SELECT signature FROM endpoint_policy WHERE endpoint_id=?', endpoint.id) : null);
    const schema = this.information.memberSchemaForSession(endpoint, sessionKey, binding?.session ?? fallbackSession);
    const prompt = typeof text === 'function'
      ? text({ schema, policy, sessionKey, group, endpoint: effectiveEndpoint })
      : text;
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('回合输入为空');
    const instructions = this.rules(endpoint, schema);
    this.information.assertRuleBudget(instructions, schema);
    const turnId = this.store.createTurn(effectiveEndpoint, inputs);
    this.information.rememberTurnSchema(turnId, 'member', schema, sessionKey);
    this.store.run(
      'INSERT INTO runtime_attempts(turn_id,group_id,endpoint_id,state,policy,created) VALUES(?,?,?,?,?,?)',
      turnId,
      group.id,
      endpoint.id,
      'running',
      JSON.stringify(policy),
      new Date().toISOString(),
    );
    const live = { endpoint: effectiveEndpoint, abort, turnId, done: null, created: new Date().toISOString() };
    const pairPeerId = endpoint.context.startsWith('pair:') ? endpoint.context.slice(5) : null;
    const pairPeerName = pairPeerId
      ? (pairPeerId === 'user' ? '用户' : this.store.get('SELECT name FROM members WHERE id=?', pairPeerId)?.name ?? pairPeerId)
      : null;
    const teamStream = (endpoint.context === 'coordination' && inputs.some(message => message.sender === 'user')) || pairPeerId
      ? {
          id: turnId,
          groupId: group.id,
          endpointId: endpoint.id,
          memberId: member.id,
          memberName: member.name,
          recipientName: pairPeerId ? pairPeerName : '用户',
          pairKey: pairPeerId ? [member.id, pairPeerId].sort().join(':') : '',
          kind: 'reply',
          host: member.host,
          context: endpoint.context,
          turnId,
          text: '',
          reasoning: '',
          // 阶段由服务端维护:前端据此区分思考、输出与工具调用,不必靠内容反推。
          runPhase: 'accepted',
          tool: null,
          created: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
      : null;
    const streamScope = {
      groupId: group.id,
      endpointId: endpoint.id,
      memberId: member.id,
      memberName: member.name,
      host: member.host,
      context: endpoint.context,
      turnId,
    };
    const toolStreamRun = this.createToolStreamRun(streamScope);
    const telemetryStarted = performance.now();
    this.running.set(endpoint.id, live);
    if (teamStream) {
      this.teamStreams.set(turnId, teamStream);
      this.publishTeamStream({ type: 'start', stream: { ...teamStream } });
    }
    // 成员的阶段只作用于团队流;工具名即公开信息,不附带参数。
    const setPhase = (phase, tool = null, publish = true) => {
      if (!teamStream) return;
      const current = this.teamStreams.get(turnId);
      if (!current || (current.runPhase === phase && current.tool === tool)) return;
      current.runPhase = phase;
      current.tool = tool;
      current.updatedAt = new Date().toISOString();
      if (publish) this.publishTeamStream({ type: 'phase', stream: { ...current } });
    };
    this.events.member(endpoint.id, { type: 'input', text: prompt }, turnId);
    try {
      this.information.measureRules({
        groupId: group.id,
        endpointId: endpoint.id,
        turnId,
        schemaVersion: schema,
        instructions,
        fixed: schema === CONTEXT_SCHEMA_VERSION,
      });
      this.information.measureTurnInput({ groupId: group.id, endpointId: endpoint.id, turnId, schemaVersion: schema, prompt });
    } catch {
      // Measurement is observational and must never change the host outcome.
    }
    this.events.member(endpoint.id, {
      type: 'framework.session_scope',
      domain: policy.domain,
      sessionKey,
      session: binding?.session ?? fallbackSession,
      reused: Boolean(binding?.session ?? fallbackSession),
      contextSchemaVersion: schema,
    }, turnId);
    const promise = Promise.resolve().then(() => host.run({
      endpoint: effectiveEndpoint, turnId, workspace: group.workspace, prompt, instructions,
      tools: toolsFor(member.role, endpoint.context), policy, previousPolicy, signal: abort.signal,
      modelSelection: {
        model_provider: member.model_provider ?? null,
        model: member.model ?? null,
        reasoning_effort: member.reasoning_effort ?? null,
      },
      onAccepted: () => { onAccepted(); this.events.member(endpoint.id, { type: 'framework.input_accepted' }, turnId); },
      onNativeTurn: ref => { this.store.run('INSERT OR IGNORE INTO native_turn_refs VALUES(?,?)', turnId, String(ref)); },
      onTool: async (name, args, metadata = {}) => {
        setPhase('tool', { name, groupId: group.id });
        try {
          return await this.tool(endpoint.id, endpoint.key, name, args, {
            ...metadata,
            turnId,
          });
        } catch (error) {
          this.failToolMessageStream(
            turnId,
            name,
            args,
            error,
            metadata.nativeCallId ?? null,
          );
          throw error;
        } finally {
          const settled = this.teamStreams.get(turnId);
          if (settled) setPhase(settled.text ? 'writing' : 'thinking');
        }
      },
      onSession: session => {
        this.store.run('INSERT INTO endpoint_session_bindings VALUES(?,?,?,?) ON CONFLICT(endpoint_id,session_key) DO UPDATE SET session=excluded.session,updated=excluded.updated', endpoint.id, sessionKey, session, new Date().toISOString());
        this.store.run('UPDATE endpoints SET session=? WHERE id=?', session, endpoint.id);
        endpoint.session = session;
        effectiveEndpoint.session = session;
        this.store.run('UPDATE turns SET session=? WHERE id=?', session, turnId);
      },
      onModel: observation => { this.events.member(endpoint.id, { type: 'framework.model', ...observation }, turnId); },
      onSelection: selection => { if (selection?.model) this.events.member(endpoint.id, { type: 'framework.model_selection', ...selection }, turnId); },
      onToolCallDelta: payload => this.observeToolStreamDelta(
        streamScope,
        toolStreamRun.streams,
        payload,
      ),
      onTextDelta: (delta, metadata = {}) => {
        if (!teamStream || typeof delta !== 'string' || !delta) return;
        const current = this.teamStreams.get(turnId);
        if (!current || current.text.length + delta.length > 2_000_000) return;
        current.text += delta;
        current.runPhase = 'writing';
        current.tool = null;
        current.updatedAt = new Date().toISOString();
        this.publishTeamStream({
          type: 'delta',
          stream: { ...current, text: '' },
          delta,
          metadata,
        });
      },
      onReasoningDelta: (delta, metadata = {}) => {
        if (!teamStream || typeof delta !== 'string' || !delta) return;
        const current = this.teamStreams.get(turnId);
        if (!current || current.reasoning.length + delta.length > 2_000_000) return;
        current.reasoning += delta;
        current.runPhase = 'thinking';
        current.tool = null;
        current.updatedAt = new Date().toISOString();
        this.publishTeamStream({
          type: 'reasoning-delta',
          stream: { ...current, text: '', reasoning: '' },
          delta,
          metadata,
        });
      },
      onPolicy: observation => {
        if (observation.signature) {
          this.store.run('INSERT INTO endpoint_session_policies VALUES(?,?,?) ON CONFLICT(endpoint_id,session_key) DO UPDATE SET signature=excluded.signature', endpoint.id, sessionKey, observation.signature);
          this.store.run('INSERT INTO endpoint_policy VALUES(?,?) ON CONFLICT(endpoint_id) DO UPDATE SET signature=excluded.signature', endpoint.id, observation.signature);
        }
        this.events.member(endpoint.id, { type: 'framework.policy', ...observation }, turnId);
      },
      onTelemetry: observation => {
        try {
          this.telemetry.record({
            groupId: group.id,
            executorKind: 'member',
            executorId: endpoint.member_id,
            endpointId: endpoint.id,
            sessionKey,
            turnId,
            turnKind: 'member',
            host: member.host,
            hostSessionId: effectiveEndpoint.session ?? null,
            context: endpoint.context,
            observation,
          });
        } catch {
          // Telemetry is observational and must never turn a host turn into a failure.
        }
      },
      onEvent: event => { if (!this.closing) this.events.member(endpoint.id, event, turnId); },
    }));
    live.done = promise;
    try {
      const result = await promise;
      this.store.run("UPDATE runtime_attempts SET state=?,ended=? WHERE turn_id=?", abort.signal.aborted ? 'cancelled' : 'completed', new Date().toISOString(), turnId);
      this.events.member(endpoint.id, { type: 'framework.output', text: result }, turnId);
      const publishedReplies = !abort.signal.aborted && endpoint.context === 'coordination'
        ? this.teamDirectives.publishOutput(turnId, result)
        : [];
      const persistedReply = publishedReplies?.[0] ?? null;
      if (teamStream) {
        this.teamStreams.delete(turnId);
        this.publishTeamStream({
          type: 'complete',
          stream: {
            ...teamStream,
            text: String(result ?? teamStream.text),
            updatedAt: new Date().toISOString(),
            ...(persistedReply
              ? { messageId: persistedReply.id, messageSeq: persistedReply.seq }
              : {}),
          },
        });
      }
      this.discardToolStreamRun(turnId);
      return result;
    }
    catch (error) {
      this.store.run('UPDATE runtime_attempts SET state=?,detail=?,ended=? WHERE turn_id=?', error.runtimeUnknown ? 'unknown' : abort.signal.aborted ? 'cancelled' : 'failed', error.message, new Date().toISOString(), turnId);
      this.events.member(endpoint.id, { type: abort.signal.aborted ? 'framework.cancelled' : 'framework.error', error: error.message }, turnId);
      if (teamStream) {
        this.teamStreams.delete(turnId);
        this.publishTeamStream({
          type: abort.signal.aborted ? 'cancelled' : 'error',
          stream: { ...teamStream, updatedAt: new Date().toISOString() },
          error: error.message,
        });
      }
      this.discardToolStreamRun(turnId, 'error', error.message);
      throw error;
    }
    finally {
      try {
        this.telemetry.record({
          groupId: group.id,
          executorKind: 'member',
          executorId: endpoint.member_id,
          endpointId: endpoint.id,
          sessionKey,
          turnId,
          turnKind: 'member',
          host: member.host,
          hostSessionId: effectiveEndpoint.session ?? null,
          context: endpoint.context,
          observation: telemetryObservation({
            source: 'framework.measured',
            scope: 'turn',
            aggregation: 'delta',
            timing: { executionWallMs: Math.max(0, Math.round(performance.now() - telemetryStarted)) },
            quality: { executionWallMs: 'measured' },
            completeness: { executionWallMs: 'complete' },
          }),
        });
      } catch { /* telemetry must not affect the host outcome */ }
      this.running.delete(endpoint.id); setImmediate(() => this.pump());
    }
  }
  async privateTurn(groupId, text) {
    this.store.group(groupId);
    const controller = this.teamController(groupId);
    if (controller.kind === 'panel_agent') return this.teamDirectives.submit(groupId, { text, controllerId: controller.id, operationId: randomUUID() });
    return this.runEndpoint(this.store.endpoint(controller.id, 'private'), text);
  }
  async stopWhere(predicate) {
    const active = [...this.running.values()].filter(({ endpoint }) => predicate(endpoint));
    for (const { abort } of active) abort.abort();
    await Promise.allSettled(active.map(item => item.done));
  }
  retry(groupId) { this.collaboration.requireCommunication(groupId); this.store.run('UPDATE outbox SET error=NULL WHERE accepted IS NULL AND endpoint_id IN (SELECT id FROM endpoints WHERE group_id=?)', groupId); this.pump(); return { retryRequested: true }; }
  resetSession(endpointId, reason, sessionKey = null) {
    const e = this.store.get('SELECT * FROM endpoints WHERE id=?', endpointId);
    if (!e || this.running.has(e.id) || this.collaboration.unknown(e.group_id).some(r => r.endpoint_id === e.id)) throw new Error('会话不存在、运行中或停止状态未核实');
    if (typeof reason !== 'string' || !reason.trim()) throw new Error('需要明确重建会话的原因');
    this.events.member(e.id, { type: 'framework.session_rotated', previousSession: e.session, reason });
    const rotationKeys = sessionKey
      ? [sessionKey]
      : [...new Set([
          ...this.store.all('SELECT session_key FROM endpoint_session_bindings WHERE endpoint_id=?', e.id).map(row => row.session_key),
          'default',
        ])];
    for (const key of rotationKeys) this.telemetry.rotateSession(e.id, key);
    if (sessionKey) {
      this.store.run('DELETE FROM endpoint_session_bindings WHERE endpoint_id=? AND session_key=?', e.id, sessionKey);
      this.store.run('DELETE FROM endpoint_session_policies WHERE endpoint_id=? AND session_key=?', e.id, sessionKey);
      this.information.forgetSessionFormats(e.id, sessionKey);
    } else {
      this.store.run('DELETE FROM endpoint_session_bindings WHERE endpoint_id=?', e.id);
      this.store.run('DELETE FROM endpoint_session_policies WHERE endpoint_id=?', e.id);
      this.store.run('DELETE FROM endpoint_policy WHERE endpoint_id=?', e.id);
      this.information.forgetSessionFormats(e.id);
    }
    const remaining = this.store.get('SELECT session FROM endpoint_session_bindings WHERE endpoint_id=? ORDER BY updated DESC LIMIT 1', e.id);
    this.store.run('UPDATE endpoints SET session=? WHERE id=?', remaining?.session ?? null, e.id);
    return { endpointId: e.id, previousSession: e.session, sessionKey, historyRetained: true };
  }
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
  overview() {
    this.ensurePanelBindings();
    const panelAgent = this.panelAgent();
    return {
      groups: this.store.all('SELECT * FROM groups ORDER BY created'),
      members: this.store.all('SELECT * FROM members ORDER BY rowid'),
      panelAgent: panelAgent ? {
        id: panelAgent.id,
        name: panelAgent.name,
        host: panelAgent.host,
        model_provider: panelAgent.model_provider,
        model: panelAgent.model,
        reasoning_effort: panelAgent.reasoning_effort,
        created: panelAgent.created,
        updated: panelAgent.updated,
      } : null,
      panelTeams: panelAgent ? this.panelTeamViews() : [],
      actors: [
        ...this.store.all('SELECT id,name FROM members WHERE removed IS NULL'),
        ...(panelAgent ? [{
          id: panelAgent.id,
          name: panelAgent.name,
          host: panelAgent.host,
          model_provider: panelAgent.model_provider,
          model: panelAgent.model,
          reasoning_effort: panelAgent.reasoning_effort,
        }] : []),
      ],
      modelPolicy: this.modelPolicy(),
      modelPolicyDefaults: {
        smart: {
          performance: SMART_PERFORMANCE_RULES,
          cost: SMART_COST_RULES,
        },
        user: DEFAULT_USER_MODEL_RULES,
      },
      groupStates: this.store.all('SELECT id,state,charter,policy,allow_shell FROM groups'),
    };
  }
  queryDirectory() {
    const panelAgent = this.panelAgent();
    return {
      members: this.store.all('SELECT * FROM members ORDER BY rowid'),
      actors: this.store.all('SELECT id,name FROM members ORDER BY rowid'),
      panelAgent: panelAgent ? Object.fromEntries(['id','name','host','model_provider','model','reasoning_effort','created','updated'].map(key => [key, panelAgent[key]])) : null,
    };
  }
  queryDefaults() {
    return { smart: { performance: SMART_PERFORMANCE_RULES, cost: SMART_COST_RULES }, user: DEFAULT_USER_MODEL_RULES };
  }
  querySessions(groupId) {
    this.store.group(groupId);
    this.ensurePanelBindings();
    const endpoints = [
      ...this.store.all("SELECT id,group_id,member_id,context,peer,session FROM endpoints WHERE group_id=? AND context!='private'", groupId),
      ...this.store.all("SELECT id,group_id,panel_agent_id AS member_id,context,NULL AS peer,session FROM panel_sessions WHERE group_id=? AND context='coordination'", groupId).map(row => ({ ...row, context: 'panel-coordination' })),
    ];
    const sessionBindings = this.store.all(`SELECT b.endpoint_id,b.session_key,b.session,b.updated FROM endpoint_session_bindings b
      WHERE b.endpoint_id IN (SELECT id FROM endpoints WHERE group_id=? AND context!='private'
      UNION SELECT id FROM panel_sessions WHERE group_id=? AND context='coordination') ORDER BY b.endpoint_id,b.session_key`, groupId, groupId);
    return { endpoints, sessionBindings };
  }
  querySession(groupId, endpointId) {
    this.store.group(groupId);
    return this.store.get("SELECT id,group_id,member_id,context,peer,session FROM endpoints WHERE group_id=? AND id=? AND context NOT IN ('private','profile')", groupId, endpointId)
      ?? this.store.get("SELECT id,group_id,panel_agent_id AS member_id,'panel-coordination' AS context,NULL AS peer,session FROM panel_sessions WHERE group_id=? AND id=? AND context='coordination'", groupId, endpointId);
  }
  queryRuntime(groupId) {
    if (groupId) this.store.group(groupId);
    return [...this.running.values()].filter(({ endpoint }) => endpoint.context !== 'private' && endpoint.context !== 'panel-private' && (!groupId || endpoint.group_id === groupId))
      .map(({ endpoint }) => ({ id: endpoint.id, group_id: endpoint.group_id, member_id: endpoint.member_id }));
  }
  queryUnread(current = false) {
    const agent = this.panelAgent();
    if (!agent) return { messages: [], receipts: [] };
    const messages = this.store.all("SELECT seq,role,active_team_id FROM (SELECT seq,role,active_team_id FROM panel_messages WHERE panel_agent_id=? AND context='private'" + (current ? ' AND seq>?' : '') + ' ORDER BY seq DESC LIMIT 200) ORDER BY seq', agent.id, ...(current ? [this.panelBootSeq] : []));
    const receipts = this.store.all('SELECT r.id,r.text,r.source_message_ids FROM team_request_receipts r JOIN team_requests q ON q.id=r.request_id WHERE q.panel_agent_id=?' + (current ? " AND r.seq>? AND q.group_id IN (SELECT id FROM groups WHERE state IS NULL OR state!='archived')" : '') + ' ORDER BY r.seq', agent.id, ...(current ? [this.panelBootReceiptSeq] : []))
      .map(row => { const sourceMessageIds = JSON.parse(row.source_message_ids); return { id: row.id, sourceMessageIds, isSourceCopy: sourceMessageIds.some(id => this.store.get('SELECT text FROM messages WHERE id=?', id)?.text === row.text) }; });
    return { messages: current ? messages.map(row => ({ ...row, active_team_id: null })) : messages, receipts };
  }
  snapshot(groupId) {
    this.ensurePanelBindings();
    const panelAgent = this.panelAgent();
    const endpoints = [
      ...this.store.all("SELECT id,group_id,member_id,context,peer,session FROM endpoints WHERE context!='private'")
        .filter(endpoint => groupId === undefined || endpoint.group_id === groupId)
        .map(endpoint => ({ ...endpoint, modelState: this.store.endpointModelSummary(endpoint.id) })),
      ...(panelAgent
        ? this.store.all("SELECT id,group_id,panel_agent_id AS member_id,'panel-coordination' AS context,NULL AS peer,session FROM panel_sessions WHERE panel_agent_id=? AND context='coordination'", panelAgent.id)
          .filter(endpoint => groupId === undefined || endpoint.group_id === groupId)
          .map(endpoint => ({ ...endpoint, modelState: this.store.endpointModelSummary(endpoint.id) }))
        : []),
    ];
    const visibleEndpoints = groupId === undefined ? endpoints : endpoints.filter(e => e.group_id === groupId);
    const endpointIds = new Set(visibleEndpoints.map(e => e.id));
    const sessionBindings = this.store.all('SELECT endpoint_id,session_key,session,updated FROM endpoint_session_bindings ORDER BY endpoint_id,session_key').filter(b => groupId === undefined || endpointIds.has(b.endpoint_id));
    return {
      ...this.overview(),
      endpoints: visibleEndpoints,
      sessionBindings,
      // This is an observation of the processes currently owned by this bus, not stored business state.
      runningEndpoints: [...this.running.values()]
        .filter(({ endpoint }) => endpoint.context !== 'private' && endpoint.context !== 'panel-private')
        .map(({ endpoint }) => endpoint.id),
      panelRunning: [...this.running.values()]
        .filter(({ endpoint }) => String(endpoint.context).startsWith('panel-'))
        .map(({ endpoint, turnId, activeTeamId }) => ({ endpoint: endpoint.id, groupId: activeTeamId ?? endpoint.group_id ?? null, turnId })),
      panelUnknown: panelAgent ? this.panelUnknown() : [],
      agentTasks: groupId ? this.agentTasksView(groupId) : [],
    };
  }
  async close() {
    this.closing = true;
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
