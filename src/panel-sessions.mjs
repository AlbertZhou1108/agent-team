import { randomUUID, createHash } from 'node:crypto';
import { resolve, relative, isAbsolute } from 'node:path';
import { statSync } from 'node:fs';
import { interactionView } from './interactions.mjs';
import { memberModelSummary } from './model-policy.mjs';
import { panelCoordinationInstructions, panelPrivateInstructions, legacyPanelDeliveryPrompt } from './prompts.mjs';
import { panelToolsFor, validatePanelTool } from './panel-tools.mjs';
import { attachmentError } from './attachments.mjs';
import { ensureDefaultPanelWorkspace } from './default-workspace.mjs';
import { telemetryObservation } from './telemetry.mjs';
import { CONTEXT_SCHEMA_VERSION } from './information.mjs';

// Panel 会话模块:Panel Agent 创建配置、私聊协作回合、面板更新与 Panel 工具。

export class PanelSessions {
  constructor(bus) {
    this.bus = bus;
    this.pumpingPanelUpdates = false;
    this.panelPrivateDeliveries = [];
  }
  panelAccessValue(agent) {
    const access = agent?.access ?? 'read-only';
    if (!['read-only', 'workspace-write', 'full-access'].includes(access)) throw new Error('Panel Agent 访问级别无效');
    return access;
  }
  panelWorkspace(value, access) {
    if (value === undefined || value === null || value === '') {
      if (access !== 'read-only') throw new Error('工作区写入和完全权限需要设置私人工作区');
      return null;
    }
    if (typeof value !== 'string' || !value.trim()) throw new Error('Panel Agent 私人工作区无效');
    const resolved = resolve(value.trim());
    let stat;
    try { stat = statSync(resolved); } catch { throw new Error('Panel Agent 私人工作区不存在'); }
    if (!stat.isDirectory()) throw new Error('Panel Agent 私人工作区不是目录');
    const rel = relative(this.bus.store.directory, resolved);
    if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error('Panel Agent 私人工作区不能位于数据目录内');
    return resolved;
  }
  requirePanelAccess(hostName, access) {
    const adapter = this.bus.hosts.get(hostName);
    const support = adapter?.supportsPanelAccess?.({ access }) ?? { supported: true };
    if (support === false || support.supported === false) throw new Error(`宿主 ${hostName} 不支持私人访问级别 ${access}：${support.reason ?? '宿主能力不足'}`);
  }
  panelAgent() {
    return this.bus.store.panelAgent();
  }
  ensurePanelBindings() {
    const panelAgent = this.bus.panelAgent();
    if (!panelAgent) return;
    const now = new Date().toISOString();
    for (const group of this.bus.store.all('SELECT id FROM groups')) {
      this.bus.store.run(
        "INSERT OR IGNORE INTO panel_team_bindings(panel_agent_id,group_id,relation,created,updated) VALUES(?,?,'observer',?,?)",
        panelAgent.id,
        group.id,
        now,
        now,
      );
    }
  }
  panelTeamRelation(groupId) {
    const panelAgent = this.bus.panelAgent();
    if (!panelAgent) return null;
    this.bus.store.group(groupId);
    this.bus.ensurePanelBindings();
    return this.bus.store.get(
      'SELECT relation FROM panel_team_bindings WHERE panel_agent_id=? AND group_id=?',
      panelAgent.id,
      groupId,
    )?.relation ?? 'observer';
  }
  panelTeamViews() {
    this.bus.ensurePanelBindings();
    const panelAgent = this.bus.panelAgent();
    if (!panelAgent) return [];
    return this.bus.store.all("SELECT * FROM groups WHERE state IS NULL OR state!='archived' ORDER BY created").map(group => ({
      ...group,
      relation: this.bus.store.get(
        'SELECT relation FROM panel_team_bindings WHERE panel_agent_id=? AND group_id=?',
        panelAgent.id,
        group.id,
      )?.relation ?? 'observer',
      controller: this.bus.teamController(group.id),
    }));
  }
  // 历史行附加结构化附件 DTO:只对确有附件的消息逐条补齐,避免每条消息都查库。
  withPanelAttachments(agentId, rows) {
    const bound = new Set(
      this.bus.store.all('SELECT DISTINCT panel_message_id FROM attachments WHERE panel_agent_id=? AND panel_message_id IS NOT NULL', agentId)
        .map(row => row.panel_message_id),
    );
    if (!bound.size) return rows;
    return rows.map(row => (bound.has(row.id) ? { ...row, attachments: this.bus.attachmentDescribeMessage(agentId, row.id) } : row));
  }
  panelAgentState(summary = false) {
    const agent = this.bus.panelAgent();
    if (!agent) return { agent: null, sessions: [], teams: [], conversation: [] };
    this.bus.ensurePanelBindings();
    return {
      agent,
      requests: this.bus.teamRequests.list(agent.id),
      teamPendingInteractions: Object.fromEntries(this.bus.store.all("SELECT group_id,COUNT(*) AS count FROM interactions WHERE state='pending' AND group_id IS NOT NULL GROUP BY group_id").map(row => [row.group_id, row.count])),
      notifications: this.bus.store.all('SELECT * FROM panel_updates WHERE panel_agent_id=? ORDER BY created DESC LIMIT 100', agent.id).map(row => this.bus.panelUpdate(row)),
      sessions: this.bus.store.all('SELECT id,context,group_id,session,updated FROM panel_sessions WHERE panel_agent_id=? ORDER BY created', agent.id),
      teams: this.bus.panelTeamViews(),
      conversation: this.withPanelAttachments(
        agent.id,
        this.bus.store.all(
          `SELECT * FROM (
            SELECT ${summary ? 'seq,id,role,created,active_team_id' : '*'} FROM panel_messages WHERE panel_agent_id=? AND context='private' ORDER BY seq DESC LIMIT 200
          ) ORDER BY seq`,
          agent.id,
        ),
      ),
      running: [...this.bus.running.values()]
        .filter(item => item.endpoint.context === 'panel-private' || item.endpoint.context === 'panel-coordination')
        .map(item => ({ endpoint: item.endpoint.id, groupId: item.activeTeamId ?? item.endpoint.group_id ?? null, turnId: item.turnId, created: item.created ?? null })),
      unknown: this.bus.panelUnknown(),
      streaming: this.bus.panelStreaming(agent.id),
    };
  }
  panelBrowserState(summary = false) {
    const state = this.bus.panelAgentState(summary);
    const active = new Set(this.bus.store.all("SELECT id FROM groups WHERE state IS NULL OR state!='archived'").map(row => row.id));
    return { ...state, bootId: this.bus.panelBootId, bootSeq: this.bus.panelBootSeq,
      conversation: state.conversation.filter(row => row.seq > this.bus.panelBootSeq),
      teams: state.teams.filter(row => active.has(row.id)),
      requests: (state.requests ?? []).filter(row => active.has(row.group_id) && ((this.bus.store.get('SELECT seq FROM panel_messages WHERE id=?', row.source_user_message_id)?.seq ?? 0) > this.bus.panelBootSeq || row.receipts.some(receipt => receipt.seq > this.bus.panelBootReceiptSeq))),
      notifications: (state.notifications ?? []).filter(row => active.has(row.group_id)),
      sessions: state.sessions.filter(row => !row.group_id || active.has(row.group_id)),
      unknown: (state.unknown ?? []).filter(row => !row.group_id || active.has(row.group_id)),
      teamPendingInteractions: Object.fromEntries(Object.entries(state.teamPendingInteractions ?? {}).filter(([id]) => active.has(id))),
    };
  }
  panelMessagePage({ history = false, before = 0 } = {}) {
    const agent = this.bus.panelAgent();
    if (!agent) return { messages: [], nextBefore: null, bootId: this.bus.panelBootId };
    const params = [agent.id, this.bus.panelBootSeq];
    let where = history ? 'seq<=?' : 'seq>?';
    if (before > 0) { where += ' AND seq<?'; params.push(before); }
    const rows = this.bus.store.all("SELECT * FROM panel_messages WHERE panel_agent_id=? AND context='private' AND " + where + ' ORDER BY seq DESC LIMIT 201', ...params);
    const hasMore = rows.length > 200;
    const messages = this.withPanelAttachments(agent.id, rows.slice(0, 200).reverse());
    return { messages, nextBefore: hasMore ? messages[0].seq : null, bootId: this.bus.panelBootId };
  }
  panelConversation(after = 0) {
    const agent = this.bus.panelAgent();
    if (!agent) return { messages: [], nextAfter: after };
    const messages = this.withPanelAttachments(
      agent.id,
      this.bus.store.all(
        "SELECT * FROM panel_messages WHERE panel_agent_id=? AND context='private' AND seq>? ORDER BY seq LIMIT 200",
        agent.id,
        after,
      ),
    );
    return { messages, nextAfter: messages.at(-1)?.seq ?? after };
  }

  async createPanelAgent({ name, host, model_provider, model, reasoning_effort, workspace, access = 'read-only' }) {
    if (this.bus.panelAgent()) throw new Error('当前数据目录已经存在 Panel Agent');
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) throw new Error('Panel Agent 名称无效');
    if (!['read-only', 'workspace-write', 'full-access'].includes(access)) throw new Error('Panel Agent 访问级别无效');
    this.bus.requireHost(host);
    this.bus.requirePanelAccess(host, access);
    // 未指定私人工作区时使用跨系统默认目录:开箱即用,不必先手动选择。
    // 附件副本与此无关——它们统一存放在数据目录 attachments/ 下,不污染工作区。
    const panelWorkspace = this.bus.panelWorkspace(
      typeof workspace === 'string' && workspace.trim() ? workspace : ensureDefaultPanelWorkspace(),
      access,
    );
    const catalog = await this.bus.modelCatalog({ refresh: true, host });
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
    this.bus.store.transaction(() => {
      if (this.bus.panelAgent()) throw new Error('当前数据目录已经存在 Panel Agent');
      this.bus.store.run(
        'INSERT INTO panel_agents(id, singleton, name, host, model_provider, model, reasoning_effort, workspace, access, created, updated) VALUES(?,1,?,?,?,?,?,?,?,?,?)',
        id,
        name.trim(),
        host,
        selected.provider ?? provider,
        selected.id,
        effort,
        panelWorkspace,
        access,
        now,
        now,
      );
      this.bus.store.conversation('panel_agent', id, 'private');
    });
    this.bus.ensurePanelBindings();
    return this.bus.panelAgentState();
  }
  async updatePanelAgent({ name, host, model_provider, model, reasoning_effort, workspace, access }) {
    const agent = this.bus.panelAgent();
    if (!agent) throw new Error('Panel Agent 尚未创建');
    if ([...this.bus.running.values()].some(item => item.endpoint.context === 'panel-private' || item.endpoint.context === 'panel-coordination')) {
      throw new Error('Panel Agent 正在运行，不能修改配置');
    }
    if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.trim().length > 100)) {
      throw new Error('Panel Agent 名称无效');
    }
    const nextHost = host ?? agent.host;
    this.bus.requireHost(nextHost);
    const currentAccess = this.bus.panelAccessValue(agent);
    const nextAccess = access === undefined ? currentAccess : access;
    if (!['read-only', 'workspace-write', 'full-access'].includes(nextAccess)) throw new Error('Panel Agent 访问级别无效');
    this.bus.requirePanelAccess(nextHost, nextAccess);
    // 与创建一致:未指定或清空工作区都回落跨系统默认目录,Panel Agent 始终有工作区可用。
    const nextWorkspace = workspace === undefined
      ? (agent.workspace ?? ensureDefaultPanelWorkspace())
      : (typeof workspace === 'string' && workspace.trim()
          ? this.bus.panelWorkspace(workspace, nextAccess)
          : ensureDefaultPanelWorkspace());
    if (nextAccess !== 'read-only' && !nextWorkspace) throw new Error('工作区写入和完全权限需要设置私人工作区');
    const catalog = await this.bus.modelCatalog({ refresh: true, host: nextHost });
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
    this.bus.store.transaction(() => {
      this.bus.store.run(
        'UPDATE panel_agents SET name=?,host=?,model_provider=?,model=?,reasoning_effort=?,workspace=?,access=?,updated=? WHERE id=?',
        (name ?? agent.name).trim(),
        nextHost,
        nextProvider,
        selected.id,
        effort,
        nextWorkspace,
        nextAccess,
        now,
        agent.id,
      );
      if (hostModelChanged) {
        this.bus.store.run("UPDATE panel_sessions SET session=NULL,policy_signature=NULL,updated=? WHERE panel_agent_id=?", now, agent.id);
      } else if (privateChanged) {
        this.bus.store.run("UPDATE panel_sessions SET session=NULL,policy_signature=NULL,updated=? WHERE panel_agent_id=? AND context='private'", now, agent.id);
      }
    });
    return this.bus.panelAgentState();
  }
  createPanelTeam(agent, { name, workspace, members = '', charter }) {
    const people = String(members ?? '').split(',').filter(Boolean).map(item => {
      const [memberName, host, ...extra] = item.trim().split('=');
      if (!memberName || !host || extra.length) throw new Error('成员格式应为 名称=宿主');
      this.bus.requireHost(host);
      return { name: memberName, host };
    });
    return this.bus.createGroup({
      name,
      workspace,
      charter,
      lead: { name: agent.name, host: agent.host },
      members: people,
      panelAgentId: agent.id,
    });
  }
  requirePanelMain(agentId, groupId) {
    const group = this.bus.store.group(groupId);
    const binding = this.bus.store.get(
      'SELECT relation FROM panel_team_bindings WHERE panel_agent_id=? AND group_id=?',
      agentId,
      groupId,
    );
    const controller = this.bus.store.get('SELECT * FROM team_lead_controllers WHERE group_id=?', groupId);
    if (binding?.relation !== 'main' || controller?.controller_kind !== 'panel_agent'
      || controller.controller_id !== agentId || controller.state !== 'active') {
      throw new Error('Panel Agent 当前不是该团队的主 Agent');
    }
    return group;
  }
  panelTeamSnapshot(groupId) {
    this.bus.ensurePanelBindings();
    const group = this.bus.store.group(groupId);
    const panelAgent = this.bus.panelAgent();
    const relation = panelAgent ? this.bus.panelTeamRelation(groupId) : null;
    return {
      group,
      relation,
      controller: this.bus.teamController(groupId),
      members: this.bus.members(groupId),
      communication: this.bus.groupSummary(groupId),
      running: [...this.bus.running.values()]
        .filter(item => item.endpoint.group_id === groupId && item.endpoint.context !== 'private')
        .map(item => item.endpoint.id),
    };
  }
  async panelTool(sessionId, key, name, args, provenance = {}) {
    const { session, panelAgent } = this.bus.store.authenticatePanelSession(sessionId, key);
    validatePanelTool(session.context, name, args);
    const turnId = provenance.turnId;
    if (turnId && this.bus.running.get(sessionId)?.turnId !== turnId) throw new Error('工具不属于当前 Panel Agent 执行回合');
    const recordedTurn = turnId
      ? this.bus.store.get('SELECT active_team_id FROM panel_turns WHERE id=? AND session_id=?', turnId, sessionId)
      : null;
    const activeTeamId = recordedTurn
      ? recordedTurn.active_team_id ?? null
      : provenance.activeTeamId ?? null;
    const callId = randomUUID();
    this.bus.events.panel(sessionId, {
      type: 'framework.tool_call',
      name,
      args,
      callId,
      nativeCallId: provenance.nativeCallId ?? null,
      activeTeamId,
    }, turnId);
    try {
      const result = await this.bus.executePanelTool(session, panelAgent, name, args, {
        turnId,
        callId,
        nativeCallId: provenance.nativeCallId ?? null,
        activeTeamId,
      });
      this.bus.measureToolCall({
        groupId: session.group_id ?? args.groupId ?? null,
        endpointId: session.id,
        turnId,
        name,
        args,
        result,
        schema: this.bus.information.panelSchemaForTurn(turnId) ?? this.bus.information.panelSchemaForSession(session),
      });
      this.bus.events.panel(sessionId, { type: 'framework.tool_result', callId, result }, turnId);
      return result;
    } catch (error) {
      this.bus.events.panel(sessionId, { type: 'framework.tool_result', callId, error: error.message }, turnId);
      throw error;
    }
  }
  async executePanelTool(session, panelAgent, name, args, origin) {
    if (name === 'team_request_submit') return this.bus.teamRequests.submit(session, panelAgent, origin, args);
    if (name === 'team_receipt_publish') return this.bus.teamRequests.publish(session, panelAgent, origin, args);
    if (name === 'team_requests') {
      const requests = this.bus.teamRequests.list(panelAgent.id, session.context === 'coordination' ? session.group_id : args.groupId);
      return session.context === 'coordination' ? requests.map(({ original_text: _originalText, source_user_message_id: _sourceUserMessageId, ...request }) => request) : requests;
    }
    if (name === 'model_catalog') return this.bus.modelCatalog({ refresh: true });
    if (name === 'teams_list') return this.bus.panelTeamViews();
    if (name === 'team_create') {
      if (session.context !== 'private') throw new Error('团队创建只能在 Panel Agent 私人会话中执行');
      const group = this.bus.createPanelTeam(panelAgent, args);
      return group;
    }
    if (name === 'ask') {
      if (args.kind === 'choice' && !Array.isArray(args.options)) throw new Error('choice 必须提供 options');
      if (args.kind === 'input' && args.options !== undefined) throw new Error('input 不接受 options');
      const anchor = this.bus.panelInteractionAnchor(session, panelAgent, origin, args.text);
      const interaction = this.bus.store.createInteraction({
        id: randomUUID(),
        groupId: anchor.groupId,
        panelAgentId: panelAgent.id,
        endpointId: session.id,
        context: session.context,
        turnId: origin.turnId ?? '',
        callId: origin.callId,
        messageId: anchor.messageId,
        panelMessageId: anchor.panelMessageId,
        kind: args.kind,
        payload: { kind: args.kind, text: args.text, ...(args.options ? { options: args.options } : {}) },
      });
      return { interaction: interaction.id, state: interaction.state };
    }
    if (name === 'request_team_takeover' || name === 'request_team_handback') {
      if (session.context !== 'private' && origin.activeTeamId !== args.groupId) {
        throw new Error('控制动作请求必须与当前 activeTeamId 一致，请先切换团队上下文');
      }
      return this.bus.requestPanelControllerAction(
        panelAgent,
        session,
        origin,
        name === 'request_team_takeover' ? 'takeover' : 'handback',
        args.groupId,
      );
    }

    if (name === 'panel_update_publish') {
      const group = this.bus.store.group(session.group_id);
      this.bus.requirePanelMain(panelAgent.id, group.id);
      if (origin.activeTeamId !== group.id) {
        throw new Error('团队更新必须与当前 activeTeamId 一致，请先切换团队上下文');
      }
      const sourceMessageIds = origin.turnId
        ? this.bus.store.all(
            'SELECT message_id FROM panel_turn_inputs WHERE turn_id=? ORDER BY ordinal',
            origin.turnId,
          ).map(row => row.message_id)
        : [];
      const update = this.bus.publishPanelUpdate({
        panelAgentId: panelAgent.id,
        groupId: group.id,
        sourceTurnId: origin.turnId ?? null,
        text: args.text.trim(),
        sourceMessageIds,
      });
      return update;
    }

    const group = this.bus.store.group(args.groupId);
    if (group.state === 'archived') throw new Error('团队已归档，请在设置中恢复后访问');
    if (name === 'team_snapshot') return this.bus.panelTeamSnapshot(group.id);
    if (name === 'team_members') return this.bus.members(group.id);
    if (name === 'team_read') {
      const schema = this.bus.information.panelSchemaForTurn(origin.turnId) ?? this.bus.information.panelSchemaForSession(session);
      if (args.messageId) {
        if (args.after !== undefined || args.limit !== undefined || args.sender !== undefined) {
          throw new Error('正文展开不能同时使用列表参数');
        }
        return this.bus.information.readBody({
          groupId: group.id,
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
      const senderId = args.sender === panelAgent.id || args.sender === panelAgent.name
        ? panelAgent.id
        : args.sender
          ? this.bus.resolveMember(group.id, args.sender).id
          : null;
      return this.bus.information.listMessages({
        groupId: group.id,
        after: args.after ?? 0,
        limit: args.limit ?? 50,
        senderId,
        schema,
      });
    }
    if (name === 'team_message_trace') {
      const message = this.bus.store.get('SELECT id FROM messages WHERE id=? AND group_id=?', args.messageId, group.id);
      if (!message) throw new Error('消息不属于当前团队');
      return this.bus.store.messageTrace(args.messageId);
    }
    if (name === 'team_turn_trace') {
      const trace = this.bus.store.turnTrace(args.turnId, args.after ?? 0);
      if (!trace || trace.turn.group_id !== group.id) throw new Error('回合不属于当前团队');
      return trace;
    }

    this.bus.requirePanelMain(panelAgent.id, group.id);
    if (origin.activeTeamId !== group.id) {
      throw new Error('团队写操作必须与当前 activeTeamId 一致，请先切换团队上下文');
    }
    const coordination = this.bus.store.conversation('panel_agent', panelAgent.id, 'coordination', { groupId: group.id });
    if (coordination.id !== session.id && this.bus.running.has(coordination.id)) {
      throw new Error('该团队的 Panel Agent coordination 正在运行，请等待后再写入');
    }
    if (name === 'team_send' || name === 'team_note') {
      this.bus.collaboration.requireCommunication(group.id);
      const target = this.bus.resolveMember(group.id, args.to);
      const message = this.bus.store.transaction(() => {
        const value = this.bus.store.append(group.id, panelAgent.id, target.id, name === 'team_send' ? 'send' : 'note', args.text);
        this.bus.store.run('INSERT INTO panel_message_origins VALUES(?,?,?,?,?)', value.id, origin.turnId ?? null, null, origin.callId, origin.nativeCallId ?? null);
        return value;
      });
      this.bus.emit('message', message);
      this.bus.completeToolMessageStream(
        origin.turnId,
        name,
        args,
        { messageId: message.id },
        origin.nativeCallId,
      );
      queueMicrotask(() => this.bus.pump());
      return { messageId: message.id };
    }
    if (name === 'group_add') {
      this.bus.requireHost(args.host);
      return this.bus.addMember(group.id, args);
    }
    if (name === 'group_remove') return this.bus.removeMember(group.id, args.member);
    if (name === 'group_member_model') {
      const target = this.bus.resolveMember(group.id, args.member);
      if (target.role !== 'member') throw new Error('group_member_model 只能调整普通成员');
      const selection = await this.bus.validateMemberModelSelection(target, args);
      return this.bus.requestPanelMemberModel(panelAgent, session, origin, group,
        `请求将成员 ${target.name} 的模型调整为 ${memberModelSummary(selection)}`,
        { member: args.member, ...(selection ?? {}) });
    }
    if (name === 'group_tasks_set') {
      return this.bus.setAgentTasks({ groupId: group.id, ownerId: panelAgent.id, tasks: args.tasks });
    }
    throw new Error('Panel Agent 工具不存在');
  }


  panelInstructions(session, panelAgent, activeTeamId = null) {
    if (session.context === 'coordination') return panelCoordinationInstructions(panelAgent, session.group_id);
    const relation = activeTeamId ? this.bus.panelTeamRelation(activeTeamId) : null;
    return panelPrivateInstructions(panelAgent, {
      workspace: panelAgent.workspace ?? '未设置（宿主 cwd 使用数据目录）',
      access: this.bus.panelAccessValue(panelAgent),
      activeTeamId,
      relation,
    });
  }

  panelUpdate(row) {
    if (!row) return null;
    return {
      ...row,
      kind: row.kind ?? 'update',
      sourceMessageIds: JSON.parse(row.source_message_ids),
    };
  }

  pendingPanelUpdates(groupId) {
    const agent = this.bus.panelAgent();
    if (!agent || !groupId) return [];
    return this.bus.store.all(
      `SELECT * FROM panel_updates
       WHERE panel_agent_id=? AND group_id=? AND delivered_turn_id IS NULL
       ORDER BY created LIMIT 5`,
      agent.id,
      groupId,
    ).map(row => this.bus.panelUpdate(row));
  }

  publishPanelUpdate({
    panelAgentId,
    groupId,
    sourceTurnId,
    kind = 'update',
    text,
    sourceMessageIds = [],
    id = randomUUID(),
  }) {
    this.bus.store.run(
      `INSERT INTO panel_updates(id,panel_agent_id,group_id,source_turn_id,kind,text,source_message_ids,created)
       VALUES(?,?,?,?,?,?,?,?)`,
      id,
      panelAgentId,
      groupId,
      sourceTurnId ?? null,
      kind,
      text,
      JSON.stringify(sourceMessageIds),
      new Date().toISOString(),
    );
    const update = this.bus.panelUpdate(this.bus.store.get('SELECT * FROM panel_updates WHERE id=?', id));
    this.bus.emit('panel-update', update);
    return update;
  }

  markPanelUpdatesDelivered(updateIds, turnId) {
    if (!updateIds.length) return;
    const delivered = new Date().toISOString();
    this.bus.store.transaction(() => {
      for (const id of updateIds) {
        this.bus.store.run(
          'UPDATE panel_updates SET delivered_turn_id=?,delivered=? WHERE id=? AND delivered_turn_id IS NULL',
          turnId,
          delivered,
          id,
        );
      }
    });
  }

  async pumpPanelUpdates() {
    // Only explicit user answers may resume the private host. Legacy updates never do.
    this.bus.flushPanelPrivateDeliveries();
  }

  async runPanelTurn({
    sourceUserMessageId = null,
    session,
    panelAgent,
    prompt,
    activeTeamId = null,
    inputs = [],
    attachments = [],
    onAccepted = () => {},
  }) {
    if (this.bus.running.has(session.id)) throw new Error('Panel Agent 会话正在运行');
    if (this.bus.store.get("SELECT 1 FROM panel_turns WHERE session_id=? AND state='unknown'", session.id)) {
      throw new Error('Panel Agent 会话存在待核实运行，请先核实宿主已经停止');
    }
    if (session.context === 'coordination') {
      this.bus.requirePanelMain(panelAgent.id, session.group_id);
      this.bus.collaboration.requireCommunication(session.group_id);
      if (this.bus.panelUnknown(session.group_id).length) throw new Error('Panel Agent 团队存在待核实运行');
    }
    const host = this.bus.hosts.get(panelAgent.host);
    if (!host) throw new Error(`宿主未配置: ${panelAgent.host}`);
    const abort = new AbortController();
    const group = session.group_id ? this.bus.store.group(session.group_id) : null;
    const privateContext = session.context === 'private';
    const access = privateContext ? this.bus.panelAccessValue(panelAgent) : 'communication';
    if (privateContext) this.bus.requirePanelAccess(panelAgent.host, access);
    const privateWorkspace = privateContext ? (panelAgent.workspace ?? this.bus.store.directory) : null;
    const policy = privateContext
      ? { mode: access, allowShell: true, access, domain: 'project' }
      : { mode: 'communication', allowShell: false, domain: 'communication' };
    const schema = this.bus.information.rememberPanelSchema(session, this.bus.information.panelSchemaForStart(session));
    const instructions = this.bus.panelInstructions(session, panelAgent, activeTeamId);
    this.bus.information.assertRuleBudget(instructions, schema);
    const now = new Date().toISOString();
    const turnId = this.bus.store.createTurn(session, {
      executorKind: 'panel_agent',
      executorId: panelAgent.id,
      inputs,
      activeTeamId,
      sourceUserMessageId,
    });
    this.bus.information.rememberTurnSchema(turnId, 'panel', schema);
    const live = {
      endpoint: { ...session, group_id: session.group_id ?? null, context: session.context === 'private' ? 'panel-private' : 'panel-coordination' },
      activeTeamId,
      abort,
      turnId,
      done: null,
      created: now,
    };
    const sourceMessage = sourceUserMessageId ? this.bus.store.get('SELECT text FROM panel_messages WHERE id=?', sourceUserMessageId) : null;
    const stream = {
      homeSummary: session.context === 'private' && Boolean(sourceMessage?.text.startsWith('[主页进展摘要]')),
      sourceUserMessageId,
      agentId: panelAgent.id,
      sessionId: session.id,
      turnId,
      context: session.context,
      activeTeamId,
      text: '',
      reasoning: '',
      // 阶段由服务端维护:前端据此区分思考、输出与工具调用,不必靠内容反推。
      runPhase: 'accepted',
      tool: null,
      created: now,
      updatedAt: now,
    };
    this.bus.panelStreams.set(turnId, stream);
    this.bus.publishPanelStream({ type: 'start', stream: { ...stream } });
    const teamStream = session.context === 'coordination' && inputs.some(message => message.sender === 'user')
      ? {
          id: turnId,
          groupId: session.group_id,
          endpointId: session.id,
          memberId: panelAgent.id,
          memberName: panelAgent.name,
          recipientName: '用户',
          pairKey: '',
          kind: 'reply',
          host: panelAgent.host,
          context: session.context,
          turnId,
          text: '',
          reasoning: '',
          runPhase: 'accepted',
          tool: null,
          created: now,
          updatedAt: now,
        }
      : null;
    if (teamStream) {
      this.bus.teamStreams.set(turnId, teamStream);
      this.bus.publishTeamStream({ type: 'start', stream: { ...teamStream } });
    }
    // `publish: false` 用于增量路径:该事件本身已携带新阶段,无需再补一条 phase。
    const setPhase = (phase, tool = null, publish = true) => {
      const current = this.bus.panelStreams.get(turnId);
      if (!current || (current.runPhase === phase && current.tool === tool)) return;
      current.runPhase = phase;
      current.tool = tool;
      current.updatedAt = new Date().toISOString();
      if (!publish) return;
      this.bus.publishPanelStream({ type: 'phase', stream: { ...current } });
      const teamCurrent = teamStream ? this.bus.teamStreams.get(turnId) : null;
      if (teamCurrent) {
        teamCurrent.runPhase = phase;
        teamCurrent.tool = tool;
        this.bus.publishTeamStream({ type: 'phase', stream: { ...teamCurrent } });
      }
    };
    const toolStreamRun = session.context === 'coordination'
      ? this.bus.createToolStreamRun({
          groupId: session.group_id,
          endpointId: session.id,
          memberId: panelAgent.id,
          memberName: panelAgent.name,
          host: panelAgent.host,
          context: session.context,
          turnId,
        })
      : null;
    const telemetryStarted = performance.now();
    this.bus.running.set(session.id, live);
    this.bus.events.panel(session.id, { type: 'input', text: prompt }, turnId);
    try {
      this.bus.information.measureRules({
        groupId: session.group_id ?? null,
        endpointId: session.id,
        turnId,
        schemaVersion: schema,
        instructions,
        fixed: false,
      });
      this.bus.information.measureTurnInput({
        groupId: session.group_id ?? null,
        endpointId: session.id,
        turnId,
        schemaVersion: schema,
        prompt,
      });
    } catch {
      // Measurement is observational and must never change the host outcome.
    }
    this.bus.events.panel(session.id, {
      type: 'framework.context',
      activeTeamId,
      relation: activeTeamId ? this.bus.panelTeamRelation(activeTeamId) : null,
      contextSchemaVersion: schema,
      ...(privateContext ? { workspace: privateWorkspace, access } : {}),
    }, turnId);
    const previousPolicy = session.policy_signature ? { signature: session.policy_signature } : null;
    const promise = Promise.resolve().then(() => host.run({
      endpoint: { ...session, context: live.endpoint.context, group_id: session.group_id ?? null },
      turnId,
      workspace: privateContext ? privateWorkspace : (group?.workspace ?? this.bus.store.directory),
      prompt,
      instructions,
      tools: panelToolsFor(session.context),
      policy,
      previousPolicy,
      // 结构化附件输入:含服务端解析的副本路径,仅供 adapter 内部使用;不进用户可见正文。
      attachments,
      signal: abort.signal,
      modelSelection: {
        model_provider: panelAgent.model_provider ?? null,
        model: panelAgent.model ?? null,
        reasoning_effort: panelAgent.reasoning_effort ?? null,
      },
      onAccepted: () => {
        onAccepted(turnId);
        this.bus.events.panel(session.id, { type: 'framework.input_accepted' }, turnId);
      },
      onNativeTurn: ref => {
        this.bus.events.panel(session.id, { type: 'framework.native_turn', ref: String(ref) }, turnId);
      },
      onTool: async (name, args, metadata = {}) => {
        setPhase('tool', { name, groupId: activeTeamId ?? null });
        try {
          return await this.bus.panelTool(session.id, session.key, name, args, {
            ...metadata,
            turnId,
            activeTeamId,
          });
        } catch (error) {
          this.bus.failToolMessageStream(
            turnId,
            name,
            args,
            error,
            metadata.nativeCallId ?? null,
          );
          throw error;
        } finally {
          // 工具结束后回到内容阶段:有正文即输出中,否则回到思考中。
          const settled = this.bus.panelStreams.get(turnId);
          if (settled) setPhase(settled.text ? 'writing' : 'thinking');
        }
      },
      onSession: value => {
        this.bus.store.setConversationSession(session.id, value);
        session.session = value;
      },
      onModel: observation => this.bus.events.panel(session.id, { type: 'framework.model', ...observation }, turnId),
      onSelection: selection => {
        if (selection?.model) this.bus.events.panel(session.id, { type: 'framework.model_selection', ...selection }, turnId);
      },
      onToolCallDelta: payload => {
        if (toolStreamRun) {
          this.bus.observeToolStreamDelta(
            toolStreamRun.scope,
            toolStreamRun.streams,
            payload,
          );
        }
      },
      onTextDelta: (delta, metadata = {}) => {
        if (typeof delta !== 'string' || !delta) return;
        const current = this.bus.panelStreams.get(turnId);
        if (!current || current.text.length + delta.length > 2_000_000) return;
        current.text += delta;
        current.runPhase = 'writing';
        current.tool = null;
        current.updatedAt = new Date().toISOString();
        if (teamStream) {
          const teamCurrent = this.bus.teamStreams.get(turnId);
          if (teamCurrent) {
            teamCurrent.text = current.text;
            teamCurrent.runPhase = 'writing';
            teamCurrent.tool = null;
            teamCurrent.updatedAt = current.updatedAt;
            this.bus.publishTeamStream({
              type: 'delta',
              stream: { ...teamCurrent, text: '' },
              delta,
              metadata,
            });
          }
        }
        this.bus.publishPanelStream({
          type: 'delta',
          stream: { ...current, text: '' },
          delta,
          metadata,
        });
      },
      onReasoningDelta: (delta, metadata = {}) => {
        if (typeof delta !== 'string' || !delta) return;
        const current = this.bus.panelStreams.get(turnId);
        if (!current || current.reasoning.length + delta.length > 2_000_000) return;
        current.reasoning += delta;
        current.runPhase = 'thinking';
        current.tool = null;
        current.updatedAt = new Date().toISOString();
        if (teamStream) {
          const teamCurrent = this.bus.teamStreams.get(turnId);
          if (teamCurrent) {
            teamCurrent.reasoning = current.reasoning;
            teamCurrent.runPhase = 'thinking';
            teamCurrent.tool = null;
            teamCurrent.updatedAt = current.updatedAt;
            this.bus.publishTeamStream({
              type: 'reasoning-delta',
              stream: { ...teamCurrent, text: '', reasoning: '' },
              delta,
              metadata,
            });
          }
        }
        this.bus.publishPanelStream({
          type: 'reasoning-delta',
          stream: { ...current, text: '', reasoning: '' },
          delta,
          metadata,
        });
      },
      onPolicy: observation => {
        if (observation.signature) {
          this.bus.store.setConversationPolicySignature(session.id, observation.signature);
          session.policy_signature = observation.signature;
        }
        this.bus.events.panel(session.id, { type: 'framework.policy', ...observation }, turnId);
      },
      onTelemetry: observation => {
        try {
          this.bus.telemetry.record({
            groupId: session.group_id,
            executorKind: 'panel_agent',
            executorId: panelAgent.id,
            endpointId: session.id,
            sessionKey: 'default',
            turnId,
            turnKind: 'panel',
            host: panelAgent.host,
            hostSessionId: session.session ?? null,
            context: session.context,
            observation,
          });
        } catch {
          // Telemetry is observational and must never turn a host turn into a failure.
        }
      },
      onEvent: event => {
        if (!this.bus.closing) this.bus.events.panel(session.id, event, turnId);
      },
    }));
    live.done = promise;
    try {
      const result = await promise;
      this.bus.store.setTurnState(turnId, abort.signal.aborted ? 'cancelled' : 'completed');
      this.bus.events.panel(session.id, { type: 'framework.output', text: result }, turnId);
      if (result) {
        const finalActiveTeamId = this.bus.store.get('SELECT active_team_id FROM panel_turns WHERE id=?', turnId)?.active_team_id ?? activeTeamId;
        this.bus.store.panelAppend(panelAgent.id, session.context, 'assistant', String(result), finalActiveTeamId);
      }
      const publishedReplies = !abort.signal.aborted && session.context === 'coordination'
        ? this.bus.teamDirectives.publishOutput(turnId, result, true)
        : [];
      const persistedReply = publishedReplies?.[0] ?? this.bus.store.get("SELECT m.* FROM messages m JOIN panel_message_origins o ON o.message_id=m.id WHERE o.turn_id=? AND m.recipient='user' AND m.reply_to IS NOT NULL ORDER BY m.seq DESC LIMIT 1", turnId) ?? null;
      this.bus.panelStreams.delete(turnId);
      this.bus.publishPanelStream({
        type: 'complete',
        stream: { ...stream, text: String(result ?? stream.text), updatedAt: new Date().toISOString() },
      });
      if (teamStream) {
        this.bus.teamStreams.delete(turnId);
        this.bus.publishTeamStream({
          type: 'complete',
          stream: {
            ...teamStream,
            text: String(persistedReply?.text ?? result ?? teamStream.text),
            updatedAt: new Date().toISOString(),
            ...(persistedReply
              ? { messageId: persistedReply.id, messageSeq: persistedReply.seq }
              : {}),
          },
        });
      }
      this.bus.discardToolStreamRun(turnId);
      return result;
    } catch (error) {
      const state = error.runtimeUnknown ? 'unknown' : abort.signal.aborted ? 'cancelled' : 'failed';
      this.bus.store.setTurnState(turnId, state);
      this.bus.events.panel(session.id, {
        type: abort.signal.aborted ? 'framework.cancelled' : 'framework.error',
        error: error.message,
      }, turnId);
      this.bus.panelStreams.delete(turnId);
      this.bus.publishPanelStream({
        type: abort.signal.aborted ? 'cancelled' : 'error',
        stream: { ...stream, updatedAt: new Date().toISOString() },
        error: error.message,
      });
      if (teamStream) {
        this.bus.teamStreams.delete(turnId);
        this.bus.publishTeamStream({
          type: abort.signal.aborted ? 'cancelled' : 'error',
          stream: { ...teamStream, updatedAt: new Date().toISOString() },
          error: error.message,
        });
      }
      this.bus.discardToolStreamRun(turnId, 'error', error.message);
      throw error;
    } finally {
      try {
        this.bus.telemetry.record({
          groupId: session.group_id,
          executorKind: 'panel_agent',
          executorId: panelAgent.id,
          endpointId: session.id,
          sessionKey: 'default',
          turnId,
          turnKind: 'panel',
          host: panelAgent.host,
          hostSessionId: session.session ?? null,
          context: session.context,
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
      this.bus.running.delete(session.id);
      setImmediate(() => this.bus.pumpPanelUpdates());
      setImmediate(() => this.bus.pump());
    }
  }


  // 稳定的请求指纹:正文与附件顺序共同构成;同 ID 不同内容必须被拒绝。
  panelRequestHash(text, attachmentIds) {
    return createHash('sha256').update(JSON.stringify({ text, attachmentIds })).digest('hex');
  }

  isUniqueViolation(error) {
    return error?.errstr?.includes('SQLITE_CONSTRAINT') || String(error?.message ?? '').includes('UNIQUE constraint failed');
  }

  // 幂等重试:返回原请求的用户消息及其后的回复状态,不再创建消息或触发回合。
  replayPanelRequest(panelAgentId, request) {
    const message = this.bus.store.get('SELECT * FROM panel_messages WHERE id=?', request.panel_message_id);
    const reply = message
      ? this.bus.store.get(
          "SELECT * FROM panel_messages WHERE panel_agent_id=? AND context='private' AND seq>? AND role='assistant' ORDER BY seq DESC LIMIT 1",
          panelAgentId,
          message.seq,
        )
      : null;
    return {
      message: message ?? null,
      reply: reply ?? null,
      result: { replayed: true },
      activeTeamId: message?.active_team_id ?? null,
    };
  }

  async panelPrivateTurn({ text, activeTeamId = null, clientMessageId = null, attachmentIds = [] }) {
    const panelAgent = this.bus.panelAgent();
    if (!panelAgent) throw new Error('Panel Agent 尚未创建');
    if (typeof text !== 'string' || text.length > 48000) throw new Error('Panel Agent 输入无效');
    if (activeTeamId) throw new Error('团队对话已迁移到团队协作会话，请从团队页面发送');
    if (!Array.isArray(attachmentIds) || attachmentIds.some(id => typeof id !== 'string' || !id)) throw new Error('附件列表无效');

    const prompt = text.trim();
    // 正文和附件都为空才拒绝;附件-only 是合法消息。
    if (!prompt && !attachmentIds.length) throw new Error('消息内容不能为空');

    // 幂等层:clientMessageId 缺省时保持旧客户端兼容,不写 request 记录。
    let payloadHash = null;
    if (clientMessageId != null) {
      if (typeof clientMessageId !== 'string' || !clientMessageId.trim() || clientMessageId.length > 200) throw new Error('clientMessageId 无效');
      payloadHash = this.panelRequestHash(prompt, attachmentIds);
      const existing = this.bus.store.get(
        'SELECT * FROM panel_message_requests WHERE panel_agent_id=? AND client_message_id=?',
        panelAgent.id,
        clientMessageId,
      );
      if (existing) {
        if (existing.payload_hash !== payloadHash) {
          throw attachmentError('conflict', '同一消息 ID 已用于不同的正文或附件,请刷新会话后重新发送');
        }
        return this.replayPanelRequest(panelAgent.id, existing);
      }
    }

    const settings = this.bus.store.attachmentSettings();
    if (attachmentIds.length > settings.maxFilesPerMessage) {
      throw new Error(`附件数量超过单条消息上限 ${settings.maxFilesPerMessage}`);
    }

    // 提交顺序固定:一个事务内验证附件、创建用户消息、写入有序关联和 request 记录;提交成功后才调宿主。
    let user;
    try {
      this.bus.store.transaction(() => {
        user = this.bus.store.panelAppend(panelAgent.id, 'private', 'user', prompt, null);
        if (attachmentIds.length) this.bus.attachments.bindTx(panelAgent.id, user.id, attachmentIds);
        if (clientMessageId != null) {
          this.bus.store.run(
            'INSERT INTO panel_message_requests(panel_agent_id,client_message_id,payload_hash,panel_message_id,created_at) VALUES(?,?,?,?,?)',
            panelAgent.id,
            clientMessageId,
            payloadHash,
            user.id,
            new Date().toISOString(),
          );
        }
      });
    } catch (error) {
      // 并发同 ID 提交:唯一键冲突时按幂等语义回放或拒绝。
      if (clientMessageId != null && this.isUniqueViolation(error)) {
        const existing = this.bus.store.get(
          'SELECT * FROM panel_message_requests WHERE panel_agent_id=? AND client_message_id=?',
          panelAgent.id,
          clientMessageId,
        );
        if (existing) {
          if (existing.payload_hash !== payloadHash) {
            throw attachmentError('conflict', '同一消息 ID 已用于不同的正文或附件,请刷新会话后重新发送');
          }
          return this.replayPanelRequest(panelAgent.id, existing);
        }
      }
      throw error;
    }

    // 宿主调用前准备附件输入;文件缺失在此明确报错,不悄悄只发文字。
    const preparedAttachments = attachmentIds.length ? this.bus.attachmentPrepare(panelAgent.id, attachmentIds) : [];
    const session = this.bus.store.conversation('panel_agent', panelAgent.id, 'private');
    const updates = [];
    let accepted = false;
    let acceptedTurnId = null;
    try {
      const result = await this.bus.runPanelTurn({
        session,
        panelAgent,
        sourceUserMessageId: user.id,
        prompt,
        activeTeamId: null,
        attachments: preparedAttachments,
        onAccepted: turnId => {
          accepted = true;
          acceptedTurnId = turnId;
        },
      });
      if (result && acceptedTurnId) {
        this.bus.markPanelUpdatesDelivered(updates.map(update => update.id), acceptedTurnId);
      }
      let finalActiveTeamId = activeTeamId ?? null;
      if (acceptedTurnId) {
        finalActiveTeamId = this.bus.store.get('SELECT active_team_id FROM panel_turns WHERE id=?', acceptedTurnId)?.active_team_id ?? finalActiveTeamId;
      }
      if (finalActiveTeamId && finalActiveTeamId !== (activeTeamId ?? null)) {
        this.bus.store.run('UPDATE panel_messages SET active_team_id=? WHERE id=?', finalActiveTeamId, user.id);
        user.active_team_id = finalActiveTeamId;
      }
      return {
        message: user,
        reply: this.bus.store.get("SELECT * FROM panel_messages WHERE panel_agent_id=? AND context='private' ORDER BY seq DESC LIMIT 1", panelAgent.id),
        result,
        activeTeamId: finalActiveTeamId,
      };
    } catch (error) {
      throw Object.assign(error, { panelMessageId: user.id, accepted });
    }
  }
  async stopPanel() {
    const agent = this.bus.panelAgent();
    if (!agent) return { stopped: [] };
    const active = [...this.bus.running.values()].filter(item => item.endpoint.context === 'panel-private');
    for (const item of active) item.abort.abort();
    await Promise.allSettled(active.map(item => item.done));
    return { stopped: active.map(item => item.turnId) };
  }
  resolvePanelRuntime(turnId, reason) {
    if (typeof reason !== 'string' || !reason.trim()) throw new Error('需要说明停止核实依据');
    const turn = this.bus.store.get("SELECT * FROM panel_turns WHERE id=? AND state='unknown'", turnId);
    if (!turn) throw new Error('待核实 Panel Agent 运行不存在');
    this.bus.store.setTurnState(turnId, 'stopped');
    this.bus.events.panel(turn.session_id, {
      type: 'framework.runtime_verified_by_user',
      turnId,
      reason: reason.trim(),
    }, turnId);
    this.bus.pump();
    return { turnId, state: 'stopped' };
  }
  panelInteractionAnchor(session, panelAgent, origin, text) {
    if (session.context === 'coordination') {
      const groupId = session.group_id;
      const message = this.bus.store.append(groupId, panelAgent.id, 'user', 'send', text);
      this.bus.emit('message', message);
      return { groupId, messageId: message.id, panelMessageId: null };
    }
    const row = this.bus.store.panelAppend(panelAgent.id, 'private', 'assistant', text, null);
    return { groupId: null, messageId: null, panelMessageId: row.id };
  }
  requestPanelControllerAction(panelAgent, session, origin, action, groupId) {
    if (!['takeover', 'handback'].includes(action)) throw new Error('控制动作无效');
    const relation = this.bus.panelTeamRelation(groupId);
    if (action === 'takeover' && relation !== 'observer') throw new Error('团队当前不是观察状态');
    if (action === 'handback' && relation !== 'main') throw new Error('Panel Agent 当前不是该团队主 Agent');
    const revision = this.bus.store.get('SELECT * FROM team_lead_controllers WHERE group_id=?', groupId)?.revision ?? 0;
    const existing = this.bus.store.get(
      "SELECT * FROM interactions WHERE panel_agent_id=? AND group_id=? AND kind=? AND state='pending' ORDER BY created DESC LIMIT 1",
      panelAgent.id,
      groupId,
      action,
    );
    if (existing) {
      if (JSON.parse(existing.payload).baseRevision === revision) return interactionView(existing);
      this.bus.store.setInteractionState(existing.id, 'cancelled', null, null, '控制者版本已变化');
    }
    const groupName = this.bus.store.group(groupId).name;
    const text = action === 'takeover'
      ? `请求接管团队「${groupName}」`
      : `请求将团队「${groupName}」交还原主 Agent`;
    const anchor = this.bus.panelInteractionAnchor(session, panelAgent, origin, text);
    const row = this.bus.store.createInteraction({
      id: randomUUID(),
      groupId,
      panelAgentId: panelAgent.id,
      endpointId: session.id,
      context: session.context,
      turnId: origin.turnId ?? '',
      callId: origin.callId,
      messageId: anchor.messageId,
      panelMessageId: anchor.panelMessageId,
      kind: action,
      payload: { kind: action, text, groupId, baseRevision: revision },
    });
    return interactionView(row);
  }
  requestPanelMemberModel(panelAgent, session, origin, group, text, args) {
    const existing = this.bus.store.get(
      "SELECT * FROM interactions WHERE panel_agent_id=? AND group_id=? AND kind='member_model' AND state='pending' ORDER BY created DESC LIMIT 1",
      panelAgent.id,
      group.id,
    );
    if (existing) {
      if (JSON.parse(existing.payload).text === text) return interactionView(existing);
      this.bus.store.setInteractionState(existing.id, 'cancelled', null, null, '请求内容已变化');
    }
    const anchor = this.bus.panelInteractionAnchor(session, panelAgent, origin, text);
    const row = this.bus.store.createInteraction({
      id: randomUUID(),
      groupId: group.id,
      panelAgentId: panelAgent.id,
      endpointId: session.id,
      context: session.context,
      turnId: origin.turnId ?? '',
      callId: origin.callId,
      messageId: anchor.messageId,
      panelMessageId: anchor.panelMessageId,
      kind: 'member_model',
      payload: { kind: 'member_model', text, args },
    });
    return interactionView(row);
  }
  deliverToPanelPrivate(row, text) {
    const agent = this.bus.panelAgent();
    if (!agent || agent.id !== row.panel_agent_id || this.bus.closing) return;
    const session = this.bus.store.conversation('panel_agent', agent.id, 'private');
    if (this.bus.running.has(session.id)) {
      this.panelPrivateDeliveries.push({ text, groupId: row.group_id });
      return;
    }
    void this.bus.panelPrivateTurn({ text }).catch(() => {});
  }
  // 私人会话忙碌期间积压的互动答复/动作结果,在会话空闲后按序补投。
  flushPanelPrivateDeliveries() {
    if (this.bus.closing || !this.panelPrivateDeliveries.length) return;
    const agent = this.bus.panelAgent();
    if (!agent) return;
    const session = this.bus.store.conversation('panel_agent', agent.id, 'private');
    if (this.bus.running.has(session.id) || this.bus.store.get("SELECT 1 FROM panel_turns WHERE session_id=? AND state='unknown'", session.id)) return;
    const item = this.panelPrivateDeliveries.shift();
    void this.bus.panelPrivateTurn({ text: item.text }).catch(() => {});
  }

  panelUnknown(groupId = null) {
    return this.bus.store.all(
      `SELECT t.*,s.context AS session_context FROM panel_turns t JOIN panel_sessions s ON s.id=t.session_id
       WHERE t.state='unknown' ${groupId ? 'AND t.group_id=?' : ''} ORDER BY t.created`,
      ...(groupId ? [groupId] : []),
    );
  }
  failPanelDelivery(session, input, entry, error) {
    this.bus.store.run('UPDATE panel_outbox SET error=? WHERE id=?', error.message, entry.id);
    if (this.bus.closing) return;
    const message = this.bus.store.get('SELECT sender FROM messages WHERE id=?', input.message.id);
    if (message?.sender) {
      const notice = this.bus.store.append(session.group_id, 'system', message.sender, 'system',
        `消息 ${input.message.id} 发给 Panel Agent 的会话失败：${error.message}。不会自动重试。`);
      this.bus.emit('notice', notice);
    }
  }
  deliverPanel(entry) {
    const session = this.bus.store.conversationById(entry.session_id);
    if (!session || session.owner_kind !== 'panel_agent' || session.context !== 'coordination') return;
    const panelAgent = this.bus.store.get('SELECT * FROM panel_agents WHERE id=?', session.panel_agent_id);
    if (!panelAgent) return;
    const input = JSON.parse(entry.payload);
    const schema = this.bus.information.panelSchemaForStart(session);
    let prompt;
    try {
      if (schema === CONTEXT_SCHEMA_VERSION) {
        const group = this.bus.store.group(session.group_id);
        prompt = JSON.stringify(this.bus.information.turnInput({
          group,
          charter: group.charter,
          policy: { mode: 'communication', allowShell: false, domain: 'communication' },
          input,
          schema,
        }));
      } else {
        prompt = legacyPanelDeliveryPrompt(input);
      }
    } catch (error) {
      this.bus.failPanelDelivery(session, input, entry, error);
      return;
    }
    this.bus.runPanelTurn({
      session: { ...session, group_id: session.group_id },
      panelAgent,
      prompt,
      activeTeamId: session.group_id,
      inputs: [input.message, ...(input.additionalMessages ?? []), ...input.notes],
      onAccepted: () => this.bus.store.run('UPDATE panel_outbox SET accepted=? WHERE id=?', new Date().toISOString(), entry.id),
    }).catch(error => {
      this.bus.failPanelDelivery(session, input, entry, error);
    });
  }
}
