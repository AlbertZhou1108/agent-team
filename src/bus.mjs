import { randomUUID } from 'node:crypto';
import { resolve, relative, isAbsolute } from 'node:path';
import { statSync, rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { Store } from './store.mjs';
import { EventLog } from './event-log.mjs';
import { TeamRequests } from './team-requests.mjs';
import { TeamDirectives } from './team-directives.mjs';
import { Telemetry, telemetryObservation } from './telemetry.mjs';
import { toolsFor, validateTool } from './tools.mjs';
import { panelToolsFor, validatePanelTool } from './panel-tools.mjs';
import { Collaboration, roleNameKey } from './collaboration.mjs';
import { Information, CONTEXT_SCHEMA_VERSION } from './information.mjs';
import {
  memberRules,
  legacyMemberRules,
  panelCoordinationInstructions,
  panelPrivateInstructions,
  panelUpdatesDispatchPrompt,
  panelPrivateTurnPrompt,
  profileIntro,
  legacyPanelDeliveryPrompt,
  legacyGroupDeliveryPrompt,
} from './prompts.mjs';
import {
  BUILTIN_PRESET_ID,
  DEFAULT_USER_MODEL_RULES,
  SMART_COST_RULES,
  SMART_PERFORMANCE_RULES,
  normalizeModelPolicy,
} from './model-policy.mjs';

const messageToolNames = new Set(['send', 'note', 'team_send', 'team_note']);
const actionInteractionKinds = new Set(['takeover', 'handback', 'group_create', 'group_add', 'group_delete', 'member_model']);

function memberModelSummary(selection) {
  return selection
    ? `${selection.model_provider ? `${selection.model_provider}/` : ''}${selection.model}（强度 ${selection.reasoning_effort}）`
    : '宿主默认模型';
}

function questionPreview(text) {
  const points = Array.from(typeof text === 'string' ? text : '');
  return points.length > 120 ? `${points.slice(0, 120).join('')}…` : points.join('');
}

export function interactionView(row) {
  if (!row) return row;
  return {
    ...row,
    // 卡片锚点消息:成员/协作互动为群消息,Panel 私聊互动为 panel_messages 行。
    message_id: row.message_id ?? row.panel_message_id ?? null,
    payload: JSON.parse(row.payload),
    ...(row.answer ? { answer: JSON.parse(row.answer) } : {}),
  };
}

function streamMessageToolName(name) {
  if (typeof name !== 'string') return name;
  if (name.startsWith('mcp__agent_team__')) return name.slice('mcp__agent_team__'.length);
  if (name.startsWith('agent_team_')) return name.slice('agent_team_'.length);
  return name;
}

function partialJsonString(value, key) {
  function readString(start) {
    let encoded = '';
    for (let index = start + 1; index < value.length; index += 1) {
      const character = value[index];
      if (character === '\\') {
        if (index + 1 >= value.length) {
          return { closed: false, end: index, value: null };
        }
        encoded += character + value[index + 1];
        index += 1;
        continue;
      }
      if (character === '"') {
        try {
          return {
            closed: true,
            end: index,
            value: JSON.parse(`"${encoded}"`),
          };
        } catch {
          return { closed: true, end: index, value: null };
        }
      }
      encoded += character;
    }
    try {
      return { closed: false, end: value.length, value: JSON.parse(`"${encoded}"`) };
    } catch {
      return { closed: false, end: value.length, value: null };
    }
  }

  let depth = 0;
  let previousSignificant = '';
  for (let index = 0; index < value.length;) {
    const character = value[index];
    if (character === '"') {
      const token = readString(index);
      if (depth === 1 && (previousSignificant === '{' || previousSignificant === ',') && token.closed) {
        let next = token.end + 1;
        while (/\s/.test(value[next] ?? '')) next += 1;
        if (value[next] === ':') {
          next += 1;
          while (/\s/.test(value[next] ?? '')) next += 1;
          if (token.value === key) {
            if (value[next] !== '"') return null;
            return readString(next).value;
          }
        }
      }
      previousSignificant = '"';
      index = token.end + 1;
      continue;
    }
    if (!/\s/.test(character)) {
      if (character === '{' || character === '[') depth += 1;
      else if (character === '}' || character === ']') depth = Math.max(0, depth - 1);
      previousSignificant = character;
    }
    index += 1;
  }
  return null;
}

export class Bus extends EventEmitter {
  constructor({ directory, hosts }) {
    super();
    this.store = new Store(directory);
    // token 级增量占历史表 76%–97%,逐条 autocommit 会拖垮事件循环;走写合并层。
    this.events = new EventLog(this.store);
    this.telemetry = new Telemetry(this.store, {
      capabilityFor: host => this.hosts.get(host)?.telemetryCapabilities ?? null,
    });
    this.collaboration = new Collaboration(this.store);
    this.information = new Information(this.store);
    this.teamDirectives = new TeamDirectives(this);
    this.teamRequests = new TeamRequests(this);
    this.hosts = hosts;
    this.running = new Map();
    this.panelStreams = new Map();
    this.teamStreams = new Map();
    this.toolStreamRuns = new Map();
    this.closing = false;
    this.pumpingPanelUpdates = false;
    this.panelPrivateDeliveries = [];
    this.modelCatalogCache = null;
    this.modelCatalogPending = null;
  }
  start() {
    this.teamDirectives.recoverOutputs();
    // Serving the panel does not implicitly resume historical work.
    this.store.run("UPDATE panel_turns SET state='unknown',ended=? WHERE state='running'", new Date().toISOString());
    this.pumpPanelUpdates();
    this.pump();
  }
  requireHost(host) { if (!this.hosts.has(host)) throw new Error(`宿主未配置: ${host}`); }
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
    const rel = relative(this.store.directory, resolved);
    if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error('Panel Agent 私人工作区不能位于数据目录内');
    return resolved;
  }
  requirePanelAccess(hostName, access) {
    const adapter = this.hosts.get(hostName);
    const support = adapter?.supportsPanelAccess?.({ access }) ?? { supported: true };
    if (support === false || support.supported === false) throw new Error(`宿主 ${hostName} 不支持私人访问级别 ${access}：${support.reason ?? '宿主能力不足'}`);
  }
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
  panelAgent() {
    return this.store.panelAgent();
  }
  ensurePanelBindings() {
    const panelAgent = this.panelAgent();
    if (!panelAgent) return;
    const now = new Date().toISOString();
    for (const group of this.store.all('SELECT id FROM groups')) {
      this.store.run(
        "INSERT OR IGNORE INTO panel_team_bindings(panel_agent_id,group_id,relation,created,updated) VALUES(?,?,'observer',?,?)",
        panelAgent.id,
        group.id,
        now,
        now,
      );
    }
  }
  panelTeamRelation(groupId) {
    const panelAgent = this.panelAgent();
    if (!panelAgent) return null;
    this.store.group(groupId);
    this.ensurePanelBindings();
    return this.store.get(
      'SELECT relation FROM panel_team_bindings WHERE panel_agent_id=? AND group_id=?',
      panelAgent.id,
      groupId,
    )?.relation ?? 'observer';
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
  panelTeamViews() {
    this.ensurePanelBindings();
    const panelAgent = this.panelAgent();
    if (!panelAgent) return [];
    return this.store.all('SELECT * FROM groups ORDER BY created').map(group => ({
      ...group,
      relation: this.store.get(
        'SELECT relation FROM panel_team_bindings WHERE panel_agent_id=? AND group_id=?',
        panelAgent.id,
        group.id,
      )?.relation ?? 'observer',
      controller: this.teamController(group.id),
    }));
  }
  panelAgentState(summary = false) {
    const agent = this.panelAgent();
    if (!agent) return { agent: null, sessions: [], teams: [], conversation: [] };
    this.ensurePanelBindings();
    return {
      agent,
      requests: this.teamRequests.list(agent.id),
      teamPendingInteractions: Object.fromEntries(this.store.all("SELECT group_id,COUNT(*) AS count FROM interactions WHERE state='pending' AND group_id IS NOT NULL GROUP BY group_id").map(row => [row.group_id, row.count])),
      notifications: this.store.all('SELECT * FROM panel_updates WHERE panel_agent_id=? ORDER BY created DESC LIMIT 100', agent.id).map(row => this.panelUpdate(row)),
      sessions: this.store.all('SELECT id,context,group_id,session,updated FROM panel_sessions WHERE panel_agent_id=? ORDER BY created', agent.id),
      teams: this.panelTeamViews(),
      conversation: this.store.all(
        `SELECT * FROM (
          SELECT ${summary ? 'seq,id,role,created,active_team_id' : '*'} FROM panel_messages WHERE panel_agent_id=? AND context='private' ORDER BY seq DESC LIMIT 200
        ) ORDER BY seq`,
        agent.id,
      ),
      running: [...this.running.values()]
        .filter(item => item.endpoint.context === 'panel-private' || item.endpoint.context === 'panel-coordination')
        .map(item => ({ endpoint: item.endpoint.id, groupId: item.activeTeamId ?? item.endpoint.group_id ?? null, turnId: item.turnId, created: item.created ?? null })),
      unknown: this.panelUnknown(),
      streaming: this.panelStreaming(agent.id),
    };
  }
  panelConversation(after = 0) {
    const agent = this.panelAgent();
    if (!agent) return { messages: [], nextAfter: after };
    const messages = this.store.all(
      "SELECT * FROM panel_messages WHERE panel_agent_id=? AND context='private' AND seq>? ORDER BY seq LIMIT 200",
      agent.id,
      after,
    );
    return { messages, nextAfter: messages.at(-1)?.seq ?? after };
  }
  panelStreaming(agentId = null) {
    return [...this.panelStreams.values()]
      .filter(stream => !agentId || stream.agentId === agentId)
      .map(stream => ({ ...stream }));
  }
  publishPanelStream(event) {
    if (!this.closing) this.emit('panel-stream', event);
  }
  teamStreaming(groupId = null) {
    return [...this.teamStreams.values()]
      .filter(stream => !groupId || stream.groupId === groupId)
      .map(stream => ({ ...stream }));
  }
  publishTeamStream(event) {
    if (!this.closing) this.emit('team-stream', event);
  }
  createToolStreamRun(scope) {
    const run = { scope, streams: new Map() };
    this.toolStreamRuns.set(scope.turnId, run);
    return run;
  }
  selectToolStream(run, name, args, preferredCallId = null) {
    const entries = [...run.streams.entries()];
    if (preferredCallId && run.streams.has(preferredCallId)) {
      const preferred = entries.find(([key]) => key === preferredCallId);
      if (preferred?.[1].name === name) return preferred;
    }
    const serialized = JSON.stringify(args);
    return entries.find(([, state]) => (
      state.name === name && state.arguments === serialized
    )) ?? entries.find(([, state]) => state.name === name) ?? null;
  }
  resolveStreamTarget(scope, value) {
    if (typeof value !== 'string' || !value) return null;
    return this.store.get(
      'SELECT id,name FROM members WHERE group_id=? AND removed IS NULL AND (id=? OR name=?) LIMIT 1',
      scope.groupId,
      value,
      value,
    ) ?? null;
  }
  observeToolStreamDelta(scope, streams, payload) {
    const name = streamMessageToolName(payload.name ?? streams.get(payload.callId)?.name);
    if (!messageToolNames.has(name)) return;
    const key = payload.callId ?? `${scope.turnId}:${payload.index ?? 0}`;
    const state = streams.get(key) ?? { name, arguments: '', stream: null, previousText: '' };
    state.name = name ?? state.name;
    if (payload.complete) state.arguments = payload.argumentsDelta ?? '';
    else state.arguments += payload.argumentsDelta ?? '';
    streams.set(key, state);
    const targetValue = partialJsonString(state.arguments, 'to');
    const target = this.resolveStreamTarget(scope, targetValue);
    const text = partialJsonString(state.arguments, 'text');
    if (!text) return;
    if (!state.stream) {
      state.stream = {
        id: `tool:${scope.turnId}:${key}`,
        groupId: scope.groupId,
        endpointId: scope.endpointId,
        memberId: scope.memberId,
        memberName: scope.memberName,
        recipientName: target?.name ?? targetValue ?? '团队',
        pairKey: target ? [scope.memberId, target.id].sort().join(':') : '',
        kind: 'message',
        messageKind: name === 'note' || name === 'team_note' ? 'note' : 'send',
        host: scope.host,
        context: scope.context,
        turnId: scope.turnId,
        toolCallId: key,
        text: '',
        created: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.teamStreams.set(state.stream.id, state.stream);
      this.publishTeamStream({ type: 'start', stream: { ...state.stream } });
    } else {
      if (target) {
        state.stream.recipientName = target.name;
        state.stream.pairKey = [scope.memberId, target.id].sort().join(':');
      } else if (targetValue) {
        state.stream.recipientName = targetValue;
      }
    }
    const replace = !text.startsWith(state.previousText);
    const delta = replace ? text : text.slice(state.previousText.length);
    if (!delta) return;
    state.previousText = text;
    state.stream.text = text;
    state.stream.updatedAt = new Date().toISOString();
    this.publishTeamStream({
      type: 'delta',
      stream: { ...state.stream, text: '' },
      delta,
      replace,
    });
  }
  completeToolStream(scope, streams, payload, result) {
    const key = payload.callId ?? `${scope.turnId}:${payload.index ?? 0}`;
    const state = streams.get(key);
    if (!state?.stream) return;
    const message = result?.messageId
      ? this.store.get('SELECT * FROM messages WHERE id=?', result.messageId)
      : null;
    if (message) {
      const target = this.store.get('SELECT id,name FROM members WHERE id=?', message.recipient);
      state.stream.text = message.text;
      state.stream.recipientName = target?.name ?? message.recipient;
      state.stream.pairKey = [message.sender, message.recipient].sort().join(':');
      state.stream.messageId = message.id;
      state.stream.messageSeq = message.seq;
    }
    state.stream.updatedAt = new Date().toISOString();
    this.teamStreams.delete(state.stream.id);
    this.publishTeamStream({ type: 'complete', stream: { ...state.stream } });
    streams.delete(key);
  }
  completeToolMessageStream(turnId, name, args, result, preferredCallId = null) {
    const run = this.toolStreamRuns.get(turnId);
    if (!run || !messageToolNames.has(name)) return;
    const selected = this.selectToolStream(run, name, args, preferredCallId);
    if (!selected) return;
    this.completeToolStream(
      run.scope,
      run.streams,
      { callId: selected[0] },
      result,
    );
  }
  failToolMessageStream(turnId, name, args, error, preferredCallId = null) {
    const run = this.toolStreamRuns.get(turnId);
    if (!run || !messageToolNames.has(name)) return;
    const selected = this.selectToolStream(run, name, args, preferredCallId);
    if (!selected) return;
    const [key, state] = selected;
    if (state.stream) {
      this.teamStreams.delete(state.stream.id);
      this.publishTeamStream({
        type: 'error',
        stream: { ...state.stream, updatedAt: new Date().toISOString() },
        error: error instanceof Error ? error.message : String(error),
      });
    }
    run.streams.delete(key);
  }
  discardToolStreamRun(turnId, type = 'cancelled', error = null) {
    const run = this.toolStreamRuns.get(turnId);
    if (run) {
      for (const state of run.streams.values()) {
        if (!state.stream) continue;
        this.teamStreams.delete(state.stream.id);
        this.publishTeamStream({
          type,
          stream: { ...state.stream, updatedAt: new Date().toISOString() },
          ...(error ? { error } : {}),
        });
      }
    }
    this.toolStreamRuns.delete(turnId);
  }
  async createPanelAgent({ name, host, model_provider, model, reasoning_effort, workspace, access = 'read-only' }) {
    if (this.panelAgent()) throw new Error('当前数据目录已经存在 Panel Agent');
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) throw new Error('Panel Agent 名称无效');
    if (!['read-only', 'workspace-write', 'full-access'].includes(access)) throw new Error('Panel Agent 访问级别无效');
    this.requireHost(host);
    this.requirePanelAccess(host, access);
    const panelWorkspace = this.panelWorkspace(workspace, access);
    const catalog = await this.modelCatalog({ refresh: true });
    const hostCatalog = catalog.hosts.find(item => item.host === host && item.ok && item.catalog);
    if (!hostCatalog) throw new Error('Panel Agent 宿主没有可用模型目录');
    const candidates = hostCatalog.catalog.models.filter(item => item.id === model);
    const provider = typeof model_provider === 'string' && model_provider.trim() ? model_provider.trim() : null;
    const selected = candidates.find(item => !provider || item.provider === provider);
    if (!selected) throw new Error('Panel Agent 选择的模型不在宿主目录中');
    const supported = selected.reasoningEfforts.length ? selected.reasoningEfforts : hostCatalog.catalog.reasoningEfforts;
    const effort = reasoning_effort ?? selected.defaultReasoningEffort;
    if (!effort || (supported.length && !supported.some(item => item.id === effort))) {
      throw new Error('Panel Agent 思考强度不受支持');
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.store.transaction(() => {
      this.store.run(
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
      this.store.panelSession(id, 'private');
    });
    this.ensurePanelBindings();
    return this.panelAgentState();
  }
  async updatePanelAgent({ name, host, model_provider, model, reasoning_effort, workspace, access }) {
    const agent = this.panelAgent();
    if (!agent) throw new Error('Panel Agent 尚未创建');
    if ([...this.running.values()].some(item => item.endpoint.context === 'panel-private' || item.endpoint.context === 'panel-coordination')) {
      throw new Error('Panel Agent 正在运行，不能修改配置');
    }
    if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.trim().length > 100)) {
      throw new Error('Panel Agent 名称无效');
    }
    const nextHost = host ?? agent.host;
    this.requireHost(nextHost);
    const currentAccess = this.panelAccessValue(agent);
    const nextAccess = access === undefined ? currentAccess : access;
    if (!['read-only', 'workspace-write', 'full-access'].includes(nextAccess)) throw new Error('Panel Agent 访问级别无效');
    this.requirePanelAccess(nextHost, nextAccess);
    const nextWorkspace = workspace === undefined
      ? (agent.workspace ?? null)
      : this.panelWorkspace(workspace, nextAccess);
    if (nextAccess !== 'read-only' && !nextWorkspace) throw new Error('工作区写入和完全权限需要设置私人工作区');
    const catalog = await this.modelCatalog({ refresh: true });
    const hostCatalog = catalog.hosts.find(item => item.host === nextHost && item.ok && item.catalog);
    if (!hostCatalog) throw new Error('Panel Agent 宿主没有可用模型目录');
    const nextModel = model ?? agent.model;
    const provider = model_provider === undefined
      ? (agent.model_provider ?? null)
      : (typeof model_provider === 'string' && model_provider.trim() ? model_provider.trim() : null);
    const selected = hostCatalog.catalog.models.find(item => item.id === nextModel && (!provider || item.provider === provider));
    if (!selected) throw new Error('Panel Agent 选择的模型不在宿主目录中');
    const supported = selected.reasoningEfforts.length ? selected.reasoningEfforts : hostCatalog.catalog.reasoningEfforts;
    const effort = reasoning_effort ?? agent.reasoning_effort ?? selected.defaultReasoningEffort;
    if (!effort || (supported.length && !supported.some(item => item.id === effort))) throw new Error('Panel Agent 思考强度不受支持');
    const now = new Date().toISOString();
    const nextProvider = selected.provider ?? provider ?? null;
    const hostModelChanged = nextHost !== agent.host
      || nextProvider !== (agent.model_provider ?? null)
      || selected.id !== agent.model
      || effort !== agent.reasoning_effort;
    const privateChanged = nextAccess !== currentAccess || nextWorkspace !== (agent.workspace ?? null);
    this.store.transaction(() => {
      this.store.run(
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
        this.store.run("UPDATE panel_sessions SET session=NULL,policy_signature=NULL,updated=? WHERE panel_agent_id=?", now, agent.id);
      } else if (privateChanged) {
        this.store.run("UPDATE panel_sessions SET session=NULL,policy_signature=NULL,updated=? WHERE panel_agent_id=? AND context='private'", now, agent.id);
      }
    });
    return this.panelAgentState();
  }
  groupSummary(groupId) {
    this.store.group(groupId);
    return {
      communicationOpen: this.collaboration.communicationOpen(groupId),
      unknown: this.collaboration.unknown(groupId),
      runningCount: [...this.running.values()].filter(item => item.endpoint.group_id === groupId).length,
    };
  }
  createPanelTeam(agent, { name, workspace, members = '', charter }) {
    const people = String(members ?? '').split(',').filter(Boolean).map(item => {
      const [memberName, host, ...extra] = item.trim().split('=');
      if (!memberName || !host || extra.length) throw new Error('成员格式应为 名称=宿主');
      this.requireHost(host);
      return { name: memberName, host };
    });
    return this.createGroup({
      name,
      workspace,
      charter,
      lead: { name: agent.name, host: agent.host },
      members: people,
      panelAgentId: agent.id,
    });
  }
  requirePanelMain(agentId, groupId) {
    const group = this.store.group(groupId);
    const binding = this.store.get(
      'SELECT relation FROM panel_team_bindings WHERE panel_agent_id=? AND group_id=?',
      agentId,
      groupId,
    );
    const controller = this.store.get('SELECT * FROM team_lead_controllers WHERE group_id=?', groupId);
    if (binding?.relation !== 'main' || controller?.controller_kind !== 'panel_agent'
      || controller.controller_id !== agentId || controller.state !== 'active') {
      throw new Error('Panel Agent 当前不是该团队的主 Agent');
    }
    return group;
  }
  panelTeamSnapshot(groupId) {
    this.ensurePanelBindings();
    const group = this.store.group(groupId);
    const panelAgent = this.panelAgent();
    const relation = panelAgent ? this.panelTeamRelation(groupId) : null;
    return {
      group,
      relation,
      controller: this.teamController(groupId),
      members: this.members(groupId),
      communication: this.groupSummary(groupId),
      running: [...this.running.values()]
        .filter(item => item.endpoint.group_id === groupId && item.endpoint.context !== 'private')
        .map(item => item.endpoint.id),
    };
  }
  async panelTool(sessionId, key, name, args, provenance = {}) {
    const { session, panelAgent } = this.store.authenticatePanelSession(sessionId, key);
    validatePanelTool(session.context, name, args);
    const turnId = provenance.turnId;
    if (turnId && this.running.get(sessionId)?.turnId !== turnId) throw new Error('工具不属于当前 Panel Agent 执行回合');
    const recordedTurn = turnId
      ? this.store.get('SELECT active_team_id FROM panel_turns WHERE id=? AND session_id=?', turnId, sessionId)
      : null;
    const activeTeamId = recordedTurn
      ? recordedTurn.active_team_id ?? null
      : provenance.activeTeamId ?? null;
    const callId = randomUUID();
    this.events.panel(sessionId, {
      type: 'framework.tool_call',
      name,
      args,
      callId,
      nativeCallId: provenance.nativeCallId ?? null,
      activeTeamId,
    }, turnId);
    try {
      const result = await this.executePanelTool(session, panelAgent, name, args, {
        turnId,
        callId,
        nativeCallId: provenance.nativeCallId ?? null,
        activeTeamId,
      });
      this.measureToolCall({
        groupId: session.group_id ?? args.groupId ?? null,
        endpointId: session.id,
        turnId,
        name,
        args,
        result,
        schema: this.information.panelSchemaForTurn(turnId) ?? this.information.panelSchemaForSession(session),
      });
      this.events.panel(sessionId, { type: 'framework.tool_result', callId, result }, turnId);
      return result;
    } catch (error) {
      this.events.panel(sessionId, { type: 'framework.tool_result', callId, error: error.message }, turnId);
      throw error;
    }
  }
  async executePanelTool(session, panelAgent, name, args, origin) {
    if (name === 'team_request_submit') return this.teamRequests.submit(session, panelAgent, origin, args);
    if (name === 'team_receipt_publish') return this.teamRequests.publish(session, panelAgent, origin, args);
    if (name === 'team_requests') {
      const requests = this.teamRequests.list(panelAgent.id, session.context === 'coordination' ? session.group_id : args.groupId);
      return session.context === 'coordination' ? requests.map(({ original_text, source_user_message_id, ...request }) => request) : requests;
    }
    if (name === 'model_catalog') return this.modelCatalog({ refresh: true });
    if (name === 'teams_list') return this.panelTeamViews();
    if (name === 'team_create') {
      if (session.context !== 'private') throw new Error('团队创建只能在 Panel Agent 私人会话中执行');
      const group = this.createPanelTeam(panelAgent, args);
      return group;
    }
    if (name === 'ask') {
      if (args.kind === 'choice' && !Array.isArray(args.options)) throw new Error('choice 必须提供 options');
      if (args.kind === 'input' && args.options !== undefined) throw new Error('input 不接受 options');
      const anchor = this.panelInteractionAnchor(session, panelAgent, origin, args.text);
      const interaction = this.store.createInteraction({
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
      return this.requestPanelControllerAction(
        panelAgent,
        session,
        origin,
        name === 'request_team_takeover' ? 'takeover' : 'handback',
        args.groupId,
      );
    }

    if (name === 'panel_update_publish') {
      const group = this.store.group(session.group_id);
      this.requirePanelMain(panelAgent.id, group.id);
      if (origin.activeTeamId !== group.id) {
        throw new Error('团队更新必须与当前 activeTeamId 一致，请先切换团队上下文');
      }
      const sourceMessageIds = origin.turnId
        ? this.store.all(
            'SELECT message_id FROM panel_turn_inputs WHERE turn_id=? ORDER BY ordinal',
            origin.turnId,
          ).map(row => row.message_id)
        : [];
      const update = this.publishPanelUpdate({
        panelAgentId: panelAgent.id,
        groupId: group.id,
        sourceTurnId: origin.turnId ?? null,
        text: args.text.trim(),
        sourceMessageIds,
      });
      return update;
    }

    const group = this.store.group(args.groupId);
    if (name === 'team_snapshot') return this.panelTeamSnapshot(group.id);
    if (name === 'team_members') return this.members(group.id);
    if (name === 'team_read') {
      const schema = this.information.panelSchemaForTurn(origin.turnId) ?? this.information.panelSchemaForSession(session);
      if (args.messageId) {
        if (args.after !== undefined || args.limit !== undefined || args.sender !== undefined) {
          throw new Error('正文展开不能同时使用列表参数');
        }
        return this.information.readBody({
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
          ? this.resolveMember(group.id, args.sender).id
          : null;
      return this.information.listMessages({
        groupId: group.id,
        after: args.after ?? 0,
        limit: args.limit ?? 50,
        senderId,
        schema,
      });
    }
    if (name === 'team_message_trace') {
      const message = this.store.get('SELECT id FROM messages WHERE id=? AND group_id=?', args.messageId, group.id);
      if (!message) throw new Error('消息不属于当前团队');
      return this.store.messageTrace(args.messageId);
    }
    if (name === 'team_turn_trace') {
      const trace = this.store.turnTrace(args.turnId, args.after ?? 0);
      if (!trace || trace.turn.group_id !== group.id) throw new Error('回合不属于当前团队');
      return trace;
    }

    this.requirePanelMain(panelAgent.id, group.id);
    if (origin.activeTeamId !== group.id) {
      throw new Error('团队写操作必须与当前 activeTeamId 一致，请先切换团队上下文');
    }
    const coordination = this.store.panelSession(panelAgent.id, 'coordination', group.id);
    if (coordination.id !== session.id && this.running.has(coordination.id)) {
      throw new Error('该团队的 Panel Agent coordination 正在运行，请等待后再写入');
    }
    if (name === 'team_send' || name === 'team_note') {
      this.collaboration.requireCommunication(group.id);
      const target = this.resolveMember(group.id, args.to);
      const message = this.store.transaction(() => {
        const value = this.store.append(group.id, panelAgent.id, target.id, name === 'team_send' ? 'send' : 'note', args.text);
        this.store.run('INSERT INTO panel_message_origins VALUES(?,?,?,?,?)', value.id, origin.turnId ?? null, null, origin.callId, origin.nativeCallId ?? null);
        return value;
      });
      this.emit('message', message);
      this.completeToolMessageStream(
        origin.turnId,
        name,
        args,
        { messageId: message.id },
        origin.nativeCallId,
      );
      queueMicrotask(() => this.pump());
      return { messageId: message.id };
    }
    if (name === 'group_add') {
      this.requireHost(args.host);
      return this.addMember(group.id, args);
    }
    if (name === 'group_remove') return this.removeMember(group.id, args.member);
    if (name === 'group_member_model') {
      const target = this.resolveMember(group.id, args.member);
      if (target.role !== 'member') throw new Error('group_member_model 只能调整普通成员');
      const selection = await this.validateMemberModelSelection(target, args);
      return this.requestPanelMemberModel(panelAgent, session, origin, group,
        `请求将成员 ${target.name} 的模型调整为 ${memberModelSummary(selection)}`,
        { member: args.member, ...(selection ?? {}) });
    }
    if (name === 'group_tasks_set') {
      return this.setAgentTasks({ groupId: group.id, ownerId: panelAgent.id, tasks: args.tasks });
    }
    throw new Error('Panel Agent 工具不存在');
  }
  panelInstructions(session, panelAgent, activeTeamId = null) {
    if (session.context === 'coordination') return panelCoordinationInstructions(panelAgent, session.group_id);
    const relation = activeTeamId ? this.panelTeamRelation(activeTeamId) : null;
    return panelPrivateInstructions(panelAgent, {
      workspace: panelAgent.workspace ?? '未设置（宿主 cwd 使用数据目录）',
      access: this.panelAccessValue(panelAgent),
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
    const agent = this.panelAgent();
    if (!agent || !groupId) return [];
    return this.store.all(
      `SELECT * FROM panel_updates
       WHERE panel_agent_id=? AND group_id=? AND delivered_turn_id IS NULL
       ORDER BY created LIMIT 5`,
      agent.id,
      groupId,
    ).map(row => this.panelUpdate(row));
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
    this.store.run(
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
    const update = this.panelUpdate(this.store.get('SELECT * FROM panel_updates WHERE id=?', id));
    this.emit('panel-update', update);
    return update;
  }

  markPanelUpdatesDelivered(updateIds, turnId) {
    if (!updateIds.length) return;
    const delivered = new Date().toISOString();
    this.store.transaction(() => {
      for (const id of updateIds) {
        this.store.run(
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
    this.flushPanelPrivateDeliveries();
  }

  async runPanelTurn({
    sourceUserMessageId = null,
    session,
    panelAgent,
    prompt,
    activeTeamId = null,
    inputs = [],
    onAccepted = () => {},
  }) {
    if (this.running.has(session.id)) throw new Error('Panel Agent 会话正在运行');
    if (this.store.get("SELECT 1 FROM panel_turns WHERE session_id=? AND state='unknown'", session.id)) {
      throw new Error('Panel Agent 会话存在待核实运行，请先核实宿主已经停止');
    }
    if (session.context === 'coordination') {
      this.requirePanelMain(panelAgent.id, session.group_id);
      this.collaboration.requireCommunication(session.group_id);
      if (this.panelUnknown(session.group_id).length) throw new Error('Panel Agent 团队存在待核实运行');
    }
    const host = this.hosts.get(panelAgent.host);
    if (!host) throw new Error(`宿主未配置: ${panelAgent.host}`);
    const abort = new AbortController();
    const group = session.group_id ? this.store.group(session.group_id) : null;
    const privateContext = session.context === 'private';
    const access = privateContext ? this.panelAccessValue(panelAgent) : 'communication';
    if (privateContext) this.requirePanelAccess(panelAgent.host, access);
    const privateWorkspace = privateContext ? (panelAgent.workspace ?? this.store.directory) : null;
    const policy = privateContext
      ? { mode: access, allowShell: true, access, domain: 'project' }
      : { mode: 'communication', allowShell: false, domain: 'communication' };
    const schema = this.information.rememberPanelSchema(session, this.information.panelSchemaForStart(session));
    const instructions = this.panelInstructions(session, panelAgent, activeTeamId);
    this.information.assertRuleBudget(instructions, schema);
    const turnId = randomUUID();
    const now = new Date().toISOString();
    this.store.run(
      'INSERT INTO panel_turns(id,session_id,panel_agent_id,context,group_id,active_team_id,state,created) VALUES(?,?,?,?,?,?,?,?)',
      turnId,
      session.id,
      panelAgent.id,
      session.context,
      session.group_id ?? null,
      activeTeamId,
      'running',
      now,
    );
    if (sourceUserMessageId) this.store.run('UPDATE panel_turns SET source_user_message_id=? WHERE id=?', sourceUserMessageId, turnId);
    this.information.rememberTurnSchema(turnId, 'panel', schema);
    inputs.forEach((message, ordinal) => this.store.run(
      'INSERT INTO panel_turn_inputs VALUES(?,?,?)',
      turnId,
      message.id,
      ordinal,
    ));
    const live = {
      endpoint: { ...session, group_id: session.group_id ?? null, context: session.context === 'private' ? 'panel-private' : 'panel-coordination' },
      activeTeamId,
      abort,
      turnId,
      done: null,
      created: now,
    };
    const stream = {
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
    this.panelStreams.set(turnId, stream);
    this.publishPanelStream({ type: 'start', stream: { ...stream } });
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
      this.teamStreams.set(turnId, teamStream);
      this.publishTeamStream({ type: 'start', stream: { ...teamStream } });
    }
    // `publish: false` 用于增量路径:该事件本身已携带新阶段,无需再补一条 phase。
    const setPhase = (phase, tool = null, publish = true) => {
      const current = this.panelStreams.get(turnId);
      if (!current || (current.runPhase === phase && current.tool === tool)) return;
      current.runPhase = phase;
      current.tool = tool;
      current.updatedAt = new Date().toISOString();
      if (!publish) return;
      this.publishPanelStream({ type: 'phase', stream: { ...current } });
      const teamCurrent = teamStream ? this.teamStreams.get(turnId) : null;
      if (teamCurrent) {
        teamCurrent.runPhase = phase;
        teamCurrent.tool = tool;
        this.publishTeamStream({ type: 'phase', stream: { ...teamCurrent } });
      }
    };
    const toolStreamRun = session.context === 'coordination'
      ? this.createToolStreamRun({
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
    this.running.set(session.id, live);
    this.events.panel(session.id, { type: 'input', text: prompt }, turnId);
    try {
      this.information.measureRules({
        groupId: session.group_id ?? null,
        endpointId: session.id,
        turnId,
        schemaVersion: schema,
        instructions,
        fixed: false,
      });
      this.information.measureTurnInput({
        groupId: session.group_id ?? null,
        endpointId: session.id,
        turnId,
        schemaVersion: schema,
        prompt,
      });
    } catch {
      // Measurement is observational and must never change the host outcome.
    }
    this.events.panel(session.id, {
      type: 'framework.context',
      activeTeamId,
      relation: activeTeamId ? this.panelTeamRelation(activeTeamId) : null,
      contextSchemaVersion: schema,
      ...(privateContext ? { workspace: privateWorkspace, access } : {}),
    }, turnId);
    const previousPolicy = session.policy_signature ? { signature: session.policy_signature } : null;
    const promise = Promise.resolve().then(() => host.run({
      endpoint: { ...session, context: live.endpoint.context, group_id: session.group_id ?? null },
      turnId,
      workspace: privateContext ? privateWorkspace : (group?.workspace ?? this.store.directory),
      prompt,
      instructions,
      tools: panelToolsFor(session.context),
      policy,
      previousPolicy,
      signal: abort.signal,
      modelSelection: {
        model_provider: panelAgent.model_provider ?? null,
        model: panelAgent.model ?? null,
        reasoning_effort: panelAgent.reasoning_effort ?? null,
      },
      onAccepted: () => {
        onAccepted(turnId);
        this.events.panel(session.id, { type: 'framework.input_accepted' }, turnId);
      },
      onNativeTurn: ref => {
        this.events.panel(session.id, { type: 'framework.native_turn', ref: String(ref) }, turnId);
      },
      onTool: async (name, args, metadata = {}) => {
        setPhase('tool', { name, groupId: activeTeamId ?? null });
        try {
          return await this.panelTool(session.id, session.key, name, args, {
            ...metadata,
            turnId,
            activeTeamId,
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
          // 工具结束后回到内容阶段:有正文即输出中,否则回到思考中。
          const settled = this.panelStreams.get(turnId);
          if (settled) setPhase(settled.text ? 'writing' : 'thinking');
        }
      },
      onSession: value => {
        this.store.run(
          'UPDATE panel_sessions SET session=?,updated=? WHERE id=?',
          value,
          new Date().toISOString(),
          session.id,
        );
        session.session = value;
      },
      onModel: observation => this.events.panel(session.id, { type: 'framework.model', ...observation }, turnId),
      onSelection: selection => {
        if (selection?.model) this.events.panel(session.id, { type: 'framework.model_selection', ...selection }, turnId);
      },
      onToolCallDelta: payload => {
        if (toolStreamRun) {
          this.observeToolStreamDelta(
            toolStreamRun.scope,
            toolStreamRun.streams,
            payload,
          );
        }
      },
      onTextDelta: (delta, metadata = {}) => {
        if (typeof delta !== 'string' || !delta) return;
        const current = this.panelStreams.get(turnId);
        if (!current || current.text.length + delta.length > 2_000_000) return;
        current.text += delta;
        current.runPhase = 'writing';
        current.tool = null;
        current.updatedAt = new Date().toISOString();
        if (teamStream) {
          const teamCurrent = this.teamStreams.get(turnId);
          if (teamCurrent) {
            teamCurrent.text = current.text;
            teamCurrent.runPhase = 'writing';
            teamCurrent.tool = null;
            teamCurrent.updatedAt = current.updatedAt;
            this.publishTeamStream({
              type: 'delta',
              stream: { ...teamCurrent, text: '' },
              delta,
              metadata,
            });
          }
        }
        this.publishPanelStream({
          type: 'delta',
          stream: { ...current, text: '' },
          delta,
          metadata,
        });
      },
      onReasoningDelta: (delta, metadata = {}) => {
        if (typeof delta !== 'string' || !delta) return;
        const current = this.panelStreams.get(turnId);
        if (!current || current.reasoning.length + delta.length > 2_000_000) return;
        current.reasoning += delta;
        current.runPhase = 'thinking';
        current.tool = null;
        current.updatedAt = new Date().toISOString();
        if (teamStream) {
          const teamCurrent = this.teamStreams.get(turnId);
          if (teamCurrent) {
            teamCurrent.reasoning = current.reasoning;
            teamCurrent.runPhase = 'thinking';
            teamCurrent.tool = null;
            teamCurrent.updatedAt = current.updatedAt;
            this.publishTeamStream({
              type: 'reasoning-delta',
              stream: { ...teamCurrent, text: '', reasoning: '' },
              delta,
              metadata,
            });
          }
        }
        this.publishPanelStream({
          type: 'reasoning-delta',
          stream: { ...current, text: '', reasoning: '' },
          delta,
          metadata,
        });
      },
      onPolicy: observation => {
        if (observation.signature) {
          this.store.run('UPDATE panel_sessions SET policy_signature=?,updated=? WHERE id=?', observation.signature, new Date().toISOString(), session.id);
          session.policy_signature = observation.signature;
        }
        this.events.panel(session.id, { type: 'framework.policy', ...observation }, turnId);
      },
      onTelemetry: observation => {
        try {
          this.telemetry.record({
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
        if (!this.closing) this.events.panel(session.id, event, turnId);
      },
    }));
    live.done = promise;
    try {
      const result = await promise;
      this.store.run(
        "UPDATE panel_turns SET state=?,ended=? WHERE id=?",
        abort.signal.aborted ? 'cancelled' : 'completed',
        new Date().toISOString(),
        turnId,
      );
      this.events.panel(session.id, { type: 'framework.output', text: result }, turnId);
      if (result) {
        const finalActiveTeamId = this.store.get('SELECT active_team_id FROM panel_turns WHERE id=?', turnId)?.active_team_id ?? activeTeamId;
        this.store.panelAppend(panelAgent.id, session.context, 'assistant', String(result), finalActiveTeamId);
      }
      const publishedReplies = !abort.signal.aborted && session.context === 'coordination'
        ? this.teamDirectives.publishOutput(turnId, result, true)
        : [];
      const persistedReply = publishedReplies?.[0] ?? this.store.get("SELECT m.* FROM messages m JOIN panel_message_origins o ON o.message_id=m.id WHERE o.turn_id=? AND m.recipient='user' AND m.reply_to IS NOT NULL ORDER BY m.seq DESC LIMIT 1", turnId) ?? null;
      this.panelStreams.delete(turnId);
      this.publishPanelStream({
        type: 'complete',
        stream: { ...stream, text: String(result ?? stream.text), updatedAt: new Date().toISOString() },
      });
      if (teamStream) {
        this.teamStreams.delete(turnId);
        this.publishTeamStream({
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
      this.discardToolStreamRun(turnId);
      return result;
    } catch (error) {
      const state = error.runtimeUnknown ? 'unknown' : abort.signal.aborted ? 'cancelled' : 'failed';
      this.store.run(
        'UPDATE panel_turns SET state=?,ended=? WHERE id=?',
        state,
        new Date().toISOString(),
        turnId,
      );
      this.events.panel(session.id, {
        type: abort.signal.aborted ? 'framework.cancelled' : 'framework.error',
        error: error.message,
      }, turnId);
      this.panelStreams.delete(turnId);
      this.publishPanelStream({
        type: abort.signal.aborted ? 'cancelled' : 'error',
        stream: { ...stream, updatedAt: new Date().toISOString() },
        error: error.message,
      });
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
    } finally {
      try {
        this.telemetry.record({
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
      this.running.delete(session.id);
      setImmediate(() => this.pumpPanelUpdates());
      setImmediate(() => this.pump());
    }
  }
  async panelPrivateTurn(text, activeTeamId = null) {
    const panelAgent = this.panelAgent();
    if (!panelAgent) throw new Error('Panel Agent 尚未创建');
    if (typeof text !== 'string' || !text.trim() || text.length > 48000) throw new Error('Panel Agent 输入无效');
    if (activeTeamId) throw new Error('团队对话已迁移到团队协作会话，请从团队页面发送');
    const user = this.store.panelAppend(panelAgent.id, 'private', 'user', text.trim(), null);
    const session = this.store.panelSession(panelAgent.id, 'private');
    const updates = [];
    const prompt = text.trim();
    let accepted = false;
    let acceptedTurnId = null;
    try {
      const result = await this.runPanelTurn({
        session,
        panelAgent,
        sourceUserMessageId: user.id,
        prompt,
        activeTeamId: null,
        onAccepted: turnId => {
          accepted = true;
          acceptedTurnId = turnId;
        },
      });
      if (result && acceptedTurnId) {
        this.markPanelUpdatesDelivered(updates.map(update => update.id), acceptedTurnId);
      }
      let finalActiveTeamId = activeTeamId ?? null;
      if (acceptedTurnId) {
        finalActiveTeamId = this.store.get('SELECT active_team_id FROM panel_turns WHERE id=?', acceptedTurnId)?.active_team_id ?? finalActiveTeamId;
      }
      if (finalActiveTeamId && finalActiveTeamId !== (activeTeamId ?? null)) {
        this.store.run('UPDATE panel_messages SET active_team_id=? WHERE id=?', finalActiveTeamId, user.id);
        user.active_team_id = finalActiveTeamId;
      }
      return {
        message: user,
        reply: this.store.get("SELECT * FROM panel_messages WHERE panel_agent_id=? AND context='private' ORDER BY seq DESC LIMIT 1", panelAgent.id),
        result,
        activeTeamId: finalActiveTeamId,
      };
    } catch (error) {
      throw Object.assign(error, { panelMessageId: user.id, accepted });
    }
  }
  async stopPanel() {
    const agent = this.panelAgent();
    if (!agent) return { stopped: [] };
    const active = [...this.running.values()].filter(item => item.endpoint.context === 'panel-private');
    for (const item of active) item.abort.abort();
    await Promise.allSettled(active.map(item => item.done));
    return { stopped: active.map(item => item.turnId) };
  }
  resolvePanelRuntime(turnId, reason) {
    if (typeof reason !== 'string' || !reason.trim()) throw new Error('需要说明停止核实依据');
    const turn = this.store.get("SELECT * FROM panel_turns WHERE id=? AND state='unknown'", turnId);
    if (!turn) throw new Error('待核实 Panel Agent 运行不存在');
    this.store.run("UPDATE panel_turns SET state='stopped',ended=? WHERE id=?", new Date().toISOString(), turnId);
    this.events.panel(turn.session_id, {
      type: 'framework.runtime_verified_by_user',
      turnId,
      reason: reason.trim(),
    }, turnId);
    this.pump();
    return { turnId, state: 'stopped' };
  }
  panelInteractionAnchor(session, panelAgent, origin, text) {
    if (session.context === 'coordination') {
      const groupId = session.group_id;
      const message = this.store.append(groupId, panelAgent.id, 'user', 'send', text);
      this.emit('message', message);
      return { groupId, messageId: message.id, panelMessageId: null };
    }
    const row = this.store.panelAppend(panelAgent.id, 'private', 'assistant', text, null);
    return { groupId: null, messageId: null, panelMessageId: row.id };
  }
  requestPanelControllerAction(panelAgent, session, origin, action, groupId) {
    if (!['takeover', 'handback'].includes(action)) throw new Error('控制动作无效');
    const relation = this.panelTeamRelation(groupId);
    if (action === 'takeover' && relation !== 'observer') throw new Error('团队当前不是观察状态');
    if (action === 'handback' && relation !== 'main') throw new Error('Panel Agent 当前不是该团队主 Agent');
    const revision = this.store.get('SELECT * FROM team_lead_controllers WHERE group_id=?', groupId)?.revision ?? 0;
    const existing = this.store.get(
      "SELECT * FROM interactions WHERE panel_agent_id=? AND group_id=? AND kind=? AND state='pending' ORDER BY created DESC LIMIT 1",
      panelAgent.id,
      groupId,
      action,
    );
    if (existing) {
      if (JSON.parse(existing.payload).baseRevision === revision) return interactionView(existing);
      this.store.setInteractionState(existing.id, 'cancelled', null, null, '控制者版本已变化');
    }
    const groupName = this.store.group(groupId).name;
    const text = action === 'takeover'
      ? `请求接管团队「${groupName}」`
      : `请求将团队「${groupName}」交还原主 Agent`;
    const anchor = this.panelInteractionAnchor(session, panelAgent, origin, text);
    const row = this.store.createInteraction({
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
    const existing = this.store.get(
      "SELECT * FROM interactions WHERE panel_agent_id=? AND group_id=? AND kind='member_model' AND state='pending' ORDER BY created DESC LIMIT 1",
      panelAgent.id,
      group.id,
    );
    if (existing) {
      if (JSON.parse(existing.payload).text === text) return interactionView(existing);
      this.store.setInteractionState(existing.id, 'cancelled', null, null, '请求内容已变化');
    }
    const anchor = this.panelInteractionAnchor(session, panelAgent, origin, text);
    const row = this.store.createInteraction({
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
  decideInteraction(id, answer) {
    const row = this.store.interaction(id);
    if (!row) throw new Error('互动不存在');
    if (row.state !== 'pending') throw new Error('互动已经结束');
    const payload = JSON.parse(row.payload);
    if (actionInteractionKinds.has(row.kind)) return this.decideActionInteraction(row, payload, answer);
    let text;
    if (row.kind === 'choice') {
      if (!answer || typeof answer !== 'object' || Array.isArray(answer) || typeof answer.selected !== 'string' || !payload.options?.includes(answer.selected)) {
        throw new Error('答复必须是 options 中的一个选项');
      }
      text = `「${questionPreview(payload.text)}」用户选择:${answer.selected}`;
    } else if (row.kind === 'input') {
      if (!answer || typeof answer !== 'object' || Array.isArray(answer) || typeof answer.value !== 'string' || !answer.value.trim() || answer.value.length > 48000) {
        throw new Error('答复必须包含 1-48000 字符的文本');
      }
      text = `「${questionPreview(payload.text)}」用户填写:\n${answer.value}`;
    } else throw new Error(`未知互动类型: ${row.kind}`);
    if (row.panel_agent_id) {
      if (row.message_id) {
        // 协作上下文发起:答复进群记录,经 pump 唤醒 Panel 主控 coordination 会话。
        const message = this.store.transaction(() => {
          const value = this.store.append(row.group_id, 'user', row.panel_agent_id, 'send', text, row.message_id);
          this.store.setInteractionState(id, 'answered', answer, value.id);
          return value;
        });
        this.emit('message', message);
        queueMicrotask(() => this.pump());
      } else {
        // 私人上下文发起:答复写入 Panel 私人会话并唤醒。
        this.store.setInteractionState(id, 'answered', answer);
        this.deliverToPanelPrivate(row, text);
      }
      return interactionView(this.store.interaction(id));
    }
    const message = this.store.transaction(() => {
      const value = this.store.append(row.group_id, 'user', row.member_id, 'send', text, row.message_id);
      this.store.setInteractionState(id, 'answered', answer, value.id);
      return value;
    });
    this.emit('message', message);
    queueMicrotask(() => this.pump());
    return interactionView(this.store.interaction(id));
  }
  decideActionInteraction(row, payload, answer) {
    if (!answer || typeof answer !== 'object' || Array.isArray(answer) || typeof answer.approved !== 'boolean') {
      throw new Error('答复必须包含 approved 布尔值');
    }
    const executors = {
      takeover: () => this.takeoverTeam(payload.groupId, payload.baseRevision),
      handback: () => this.handbackTeam(payload.groupId, payload.baseRevision),
      group_create: () => this.createGroup(payload.args),
      group_add: () => this.addMember(row.group_id, payload.args),
      member_model: () => this.applyMemberModel(row.group_id, payload.args.member, payload.args.model ? {
        model_provider: payload.args.model_provider ?? null,
        model: payload.args.model,
        reasoning_effort: payload.args.reasoning_effort ?? null,
      } : null),
      // 群删除会级联清除本行,结果不再回送发起会话。
      group_delete: () => this.deleteGroup(row.group_id),
    };
    const deliverOutcome = text => {
      if (row.panel_agent_id) return this.deliverToPanelPrivate(row, text);
      const message = this.store.append(row.group_id, 'user', row.member_id, 'send', text, row.message_id);
      this.emit('message', message);
      queueMicrotask(() => this.pump());
      return message;
    };
    // 先落账再执行,避免执行中的控制者变更收尾把本行误判为待取消。
    this.store.setInteractionState(row.id, 'answered', answer);
    const decidedView = interactionView(this.store.interaction(row.id));
    let outcome;
    if (!answer.approved) {
      outcome = `${payload.text}:用户已拒绝。`;
    } else {
      try {
        executors[row.kind]();
      } catch (error) {
        this.store.setInteractionState(row.id, 'failed', null, null, error.message);
        this.deliverOutcomeSafe(row, deliverOutcome, `${payload.text}:用户已同意,但执行失败:${error.message}`);
        throw error;
      }
      outcome = `${payload.text}:用户已同意,已生效。`;
    }
    this.deliverOutcomeSafe(row, deliverOutcome, outcome);
    return row.kind === 'group_delete' ? decidedView : interactionView(this.store.interaction(row.id));
  }
  deliverOutcomeSafe(row, deliver, text) {
    try { deliver(text); } catch (error) {
      // 群删除等场景下发起会话可能已不存在;结果以卡片状态为准。
      if (!this.closing) console.warn(`互动结果投递失败: ${error.message}`);
    }
  }
  deliverToPanelPrivate(row, text) {
    const agent = this.panelAgent();
    if (!agent || agent.id !== row.panel_agent_id || this.closing) return;
    const session = this.store.panelSession(agent.id, 'private');
    if (this.running.has(session.id)) {
      this.panelPrivateDeliveries.push({ text, groupId: row.group_id });
      return;
    }
    void this.panelPrivateTurn(text, null).catch(() => {});
  }
  // 私人会话忙碌期间积压的互动答复/动作结果,在会话空闲后按序补投。
  flushPanelPrivateDeliveries() {
    if (this.closing || !this.panelPrivateDeliveries.length) return;
    const agent = this.panelAgent();
    if (!agent) return;
    const session = this.store.panelSession(agent.id, 'private');
    if (this.running.has(session.id) || this.store.get("SELECT 1 FROM panel_turns WHERE session_id=? AND state='unknown'", session.id)) return;
    const item = this.panelPrivateDeliveries.shift();
    void this.panelPrivateTurn(item.text, null).catch(() => {});
  }

  panelUnknown(groupId = null) {
    return this.store.all(
      `SELECT t.*,s.context AS session_context FROM panel_turns t JOIN panel_sessions s ON s.id=t.session_id
       WHERE t.state='unknown' ${groupId ? 'AND t.group_id=?' : ''} ORDER BY t.created`,
      ...(groupId ? [groupId] : []),
    );
  }
  controllerState(groupId) {
    const group = this.store.group(groupId);
    const assignment = this.store.get('SELECT * FROM team_lead_controllers WHERE group_id=?', groupId);
    return {
      groupId,
      controller: this.teamController(groupId),
      revision: assignment?.revision ?? 0,
      panelRelation: this.panelTeamRelation(groupId),
    };
  }
  assertControllerSwitchSafe(groupId) {
    if (!this.collaboration.communicationOpen(groupId)) throw new Error('团队已归档，不能切换控制者');
    const running = [...this.running.values()].filter(item => (
      item.endpoint.group_id === groupId || item.activeTeamId === groupId
    ));
    if (running.length) throw new Error('团队仍有运行中回合，不能切换控制者');
    if (this.collaboration.unknown(groupId).length) throw new Error('团队存在待核实运行，不能切换控制者');
    if (this.panelUnknown(groupId).length) throw new Error('Panel Agent 团队上下文存在待核实运行，不能切换控制者');
    const pending = this.store.pending().filter(message => message.group_id === groupId);
    if (pending.length) throw new Error(`团队仍有未处理正式消息，不能切换控制者: ${pending.map(message => `${message.seq}:${message.id}`).join(', ')}`);
    if (this.store.get('SELECT 1 FROM outbox WHERE accepted IS NULL AND error IS NULL AND endpoint_id IN (SELECT id FROM endpoints WHERE group_id=?)', groupId)
      || this.store.get('SELECT 1 FROM panel_outbox WHERE accepted IS NULL AND error IS NULL AND session_id IN (SELECT id FROM panel_sessions WHERE group_id=?)', groupId)) {
      throw new Error('团队仍有待投递消息，不能切换控制者');
    }
  }
  takeoverTeam(groupId, expectedRevision) {
    const panelAgent = this.panelAgent();
    if (!panelAgent) throw new Error('Panel Agent 尚未创建');
    const group = this.store.group(groupId);
    const relation = this.panelTeamRelation(groupId);
    if (relation === 'main') throw new Error('Panel Agent 已经是该团队的主 Agent');
    const current = this.store.get('SELECT * FROM team_lead_controllers WHERE group_id=?', groupId);
    const currentRevision = current?.revision ?? 0;
    if (expectedRevision !== undefined && expectedRevision !== currentRevision) throw new Error('控制者版本已变化，请重新读取');
    this.assertControllerSwitchSafe(groupId);
    const originalLeadId = current?.controller_kind === 'member'
      ? current.controller_id
      : current?.original_lead_id ?? group.lead;
    if (!originalLeadId) throw new Error('团队没有可暂停的原主 Agent');
    const now = new Date().toISOString();
    this.store.transaction(() => {
      this.store.run(
        `INSERT INTO team_lead_controllers(group_id,controller_kind,controller_id,state,original_lead_id,revision,updated)
         VALUES(?,'panel_agent',?,'active',?,1,?)
         ON CONFLICT(group_id) DO UPDATE SET controller_kind='panel_agent',controller_id=excluded.controller_id,state='active',original_lead_id=excluded.original_lead_id,revision=revision+1,updated=excluded.updated`,
        group.id,
        panelAgent.id,
        originalLeadId,
        now,
      );
      this.store.run(
        "INSERT INTO panel_team_bindings(panel_agent_id,group_id,relation,created,updated) VALUES(?,?,'main',?,?) ON CONFLICT(panel_agent_id,group_id) DO UPDATE SET relation='main',updated=excluded.updated",
        panelAgent.id,
        group.id,
        now,
        now,
      );
      this.store.panelSession(panelAgent.id, 'coordination', group.id);
      this.store.run(
        "UPDATE interactions SET state='cancelled',detail='控制者已变化',answered=? WHERE group_id=? AND kind IN ('takeover','handback') AND state='pending'",
        now,
        group.id,
      );
    });
    return this.controllerState(group.id);
  }
  handbackTeam(groupId, expectedRevision) {
    const panelAgent = this.panelAgent();
    if (!panelAgent) throw new Error('Panel Agent 尚未创建');
    this.requirePanelMain(panelAgent.id, groupId);
    const current = this.store.get('SELECT * FROM team_lead_controllers WHERE group_id=?', groupId);
    if (expectedRevision !== undefined && expectedRevision !== current.revision) throw new Error('控制者版本已变化，请重新读取');
    this.assertControllerSwitchSafe(groupId);
    const original = current.original_lead_id ? this.store.get('SELECT * FROM members WHERE id=? AND removed IS NULL', current.original_lead_id) : null;
    if (!original) throw new Error('原主 Agent 不存在或已移除，无法交还');
    const now = new Date().toISOString();
    this.store.transaction(() => {
      this.store.run(
        "UPDATE team_lead_controllers SET controller_kind='member',controller_id=?,state='active',original_lead_id=NULL,revision=revision+1,updated=? WHERE group_id=?",
        original.id,
        now,
        groupId,
      );
      this.store.run(
        "UPDATE panel_team_bindings SET relation='observer',updated=? WHERE panel_agent_id=? AND group_id=?",
        now,
        panelAgent.id,
        groupId,
      );
      this.store.run(
        "UPDATE interactions SET state='cancelled',detail='控制者已变化',answered=? WHERE group_id=? AND kind IN ('takeover','handback') AND state='pending'",
        now,
        groupId,
      );
    });
    return this.controllerState(groupId);
  }
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
  normalizeAgentTasks(value) {
    if (!Array.isArray(value)) throw new Error('任务列表必须是数组');
    if (value.length > 20) throw new Error('任务列表最多 20 条');
    return value.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('任务必须是对象');
      if (typeof item.text !== 'string' || !item.text.trim() || item.text.length > 500) throw new Error('任务文本需要 1-500 字符');
      if (!['doing', 'done', 'dropped'].includes(item.state)) throw new Error('任务状态必须是 doing、done 或 dropped');
      return { text: item.text.trim(), state: item.state };
    });
  }
  setAgentTasks({ groupId, ownerId, tasks }) {
    this.store.group(groupId);
    const normalized = this.normalizeAgentTasks(tasks);
    const updated = new Date().toISOString();
    if (normalized.length) {
      this.store.run(
        'INSERT INTO agent_tasks(owner_id,group_id,tasks,updated) VALUES(?,?,?,?) ON CONFLICT(owner_id,group_id) DO UPDATE SET tasks=excluded.tasks,updated=excluded.updated',
        ownerId,
        groupId,
        JSON.stringify(normalized),
        updated,
      );
    } else {
      this.store.run('DELETE FROM agent_tasks WHERE owner_id=? AND group_id=?', ownerId, groupId);
    }
    return { owner: ownerId, updated };
  }
  agentTasksView(groupId) {
    const panelAgent = this.panelAgent();
    return this.store.all('SELECT owner_id,group_id,tasks,updated FROM agent_tasks WHERE group_id=? ORDER BY updated DESC', groupId)
      .map(row => ({
        owner_id: row.owner_id,
        group_id: row.group_id,
        owner_kind: panelAgent && row.owner_id === panelAgent.id ? 'panel_agent' : 'member',
        tasks: JSON.parse(row.tasks),
        updated: row.updated,
      }));
  }
  // Group creation is direct: the requester (CLI user, Panel Agent on behalf of
  // its user, or a confirmed group_create tool call) supplies the people and an
  // optional charter. No contract negotiation or confirmation protocol.
  createGroup({ name, workspace, lead, members = [], panelAgentId, charter, policy, allowShell }) {
    const panelAgent = panelAgentId ? this.store.get('SELECT * FROM panel_agents WHERE id=?', panelAgentId) : null;
    if (panelAgentId && !panelAgent) throw new Error('Panel Agent 不存在');
    if (panelAgent) lead = { name: panelAgent.name, host: panelAgent.host, kind: 'panel_agent', id: panelAgent.id };
    if (!name?.trim() || !lead?.name || !lead?.host) throw new Error('需要群名、主 Agent 名称与宿主');
    if (name.length > 200) throw new Error('群名过长');
    workspace = resolve(workspace);
    if (!statSync(workspace).isDirectory()) throw new Error('工作目录无效');
    if (charter !== undefined && charter !== null && (typeof charter !== 'string' || charter.length > 48000)) throw new Error('团队说明过长');
    if (policy !== undefined && !['communication', 'read-only', 'workspace-write'].includes(policy)) throw new Error('执行策略无效');
    const people = panelAgent
      ? members.map(member => ({ ...member, role: 'member' }))
      : [{ ...lead, role: 'lead' }, ...members.map(member => ({ ...member, role: 'member' }))];
    const names = new Set();
    for (const person of people) {
      this.requireHost(person.host);
      const key = person.name?.trim() ? roleNameKey(person.name) : '';
      if (!key || person.name.length > 100 || names.has(key)) throw new Error('成员名称为空、重复或过长');
      names.add(key);
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.store.transaction(() => {
      this.store.run(
        'INSERT INTO groups(id,name,workspace,lead,created,charter,policy,allow_shell) VALUES(?,?,?,?,?,?,?,?)',
        id,
        name,
        workspace,
        null,
        now,
        typeof charter === 'string' && charter.trim() ? charter.trim() : null,
        policy ?? 'workspace-write',
        allowShell === undefined ? 1 : allowShell ? 1 : 0,
      );
      for (const person of people) {
        const memberId = randomUUID();
        const selection = this.defaultModelSelection(person.host);
        this.store.run(
          'INSERT INTO members(id,group_id,name,host,role,model_provider,model,reasoning_effort) VALUES(?,?,?,?,?,?,?,?)',
          memberId,
          id,
          person.name,
          person.host,
          person.role,
          selection?.model_provider ?? null,
          selection?.model ?? null,
          selection?.reasoning_effort ?? null,
        );
        this.collaboration.reserveMemberName(id, memberId, person.name);
        if (person.role === 'lead') this.store.run('UPDATE groups SET lead=? WHERE id=?', memberId, id);
      }
      if (panelAgent) {
        this.store.run(
          "INSERT INTO team_lead_controllers(group_id,controller_kind,controller_id,state,original_lead_id,revision,updated) VALUES(?,'panel_agent',?,'active',NULL,1,?)",
          id,
          panelAgent.id,
          now,
        );
        this.store.run(
          "INSERT INTO panel_team_bindings(panel_agent_id,group_id,relation,created,updated) VALUES(?,?,'main',?,?)",
          panelAgent.id,
          id,
          now,
          now,
        );
      } else if (this.panelAgent()) {
        const owner = this.panelAgent();
        this.store.run(
          "INSERT INTO panel_team_bindings(panel_agent_id,group_id,relation,created,updated) VALUES(?,?,'observer',?,?)",
          owner.id,
          id,
          now,
          now,
        );
      }
    });
    for (const member of this.members(id)) if (!member.profile) this.introduce(member);
    return this.store.group(id);
  }
  setGroupState(groupId, state) {
    if (!['open', 'archived'].includes(state)) throw new Error('团队状态无效');
    this.store.group(groupId);
    this.store.run('UPDATE groups SET state=? WHERE id=?', state === 'open' ? null : state, groupId);
    return this.store.group(groupId);
  }
  members(groupId) { this.store.group(groupId); return this.store.all('SELECT * FROM members WHERE group_id=? AND removed IS NULL ORDER BY rowid', groupId); }
  resolveMember(groupId, value) {
    const member = this.store.get('SELECT * FROM members WHERE group_id=? AND id=? AND removed IS NULL', groupId, value)
      ?? this.store.get(`SELECT m.* FROM members m JOIN role_names r ON r.member_id=m.id
        WHERE m.group_id=? AND m.removed IS NULL AND r.name_key=?`, groupId, roleNameKey(value));
    if (!member) throw new Error(`群内找不到成员: ${value}`);
    return member;
  }
  resolveRecipient(groupId, value) {
    const controller = this.teamController(groupId);
    if (value === controller.id || value === controller.name || value === '主 Agent' || value === '主Agent') {
      return { id: controller.id, name: controller.name, kind: controller.kind };
    }
    return this.resolveMember(groupId, value);
  }
  async addMember(groupId, { name, host }) {
    this.collaboration.requireCommunication(groupId); this.requireHost(host);
    if (!name?.trim() || name.length > 100) throw new Error('成员名称无效');
    if (this.store.get(
      'SELECT 1 FROM role_names WHERE group_id=? AND name_key=?',
      groupId,
      roleNameKey(name),
    )) throw new Error('名称已被本团队历史使用');
    const selection = this.defaultModelSelection(host);
    const id = randomUUID();
    this.store.transaction(() => {
      this.store.run(
        'INSERT INTO members(id,group_id,name,host,role,model_provider,model,reasoning_effort) VALUES(?,?,?,?,?,?,?,?)',
        id,
        groupId,
        name.trim(),
        host,
        'member',
        selection?.model_provider ?? null,
        selection?.model ?? null,
        selection?.reasoning_effort ?? null,
      );
      this.collaboration.reserveMemberName(groupId, id, name);
    });
    this.introduce(this.store.member(id));
    return this.store.member(id);
  }
  async removeMember(groupId, memberId) {
    const member = this.resolveMember(groupId, memberId);
    if (member.role === 'lead') throw new Error('不能移除主 Agent；可删除群');
    this.store.run('UPDATE members SET removed=? WHERE id=?', new Date().toISOString(), member.id);
    for (const row of this.store.pendingMemberInteractions(groupId, member.id)) this.store.setInteractionState(row.id, 'cancelled');
    await this.stopWhere(endpoint => endpoint.member_id === member.id);
    return { removed: member.id };
  }
  async deleteGroup(groupId) {
    this.store.group(groupId);
    const endpoints = this.store.all('SELECT id FROM endpoints WHERE group_id=?', groupId);
    const panelSessions = this.store.all("SELECT id FROM panel_sessions WHERE group_id=? AND context='coordination'", groupId);
    await this.stopWhere(endpoint => endpoint.group_id === groupId);
    this.store.run('DELETE FROM groups WHERE id=?', groupId);
    this.store.run('DELETE FROM information_measurements WHERE group_id=?', groupId);
    this.information.pruneOrphanTurnSchemas();
    for (const { id } of endpoints) rmSync(resolve(this.store.directory, 'endpoints', id), { recursive: true, force: true });
    for (const { id } of panelSessions) rmSync(resolve(this.store.directory, 'endpoints', id), { recursive: true, force: true });
    return { deleted: groupId };
  }
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
  memberInteractionAnchor(member, text) {
    const message = this.store.append(member.group_id, member.id, 'user', 'send', text);
    this.emit('message', message);
    return message;
  }
  requestGroupAction(member, endpoint, origin, kind, text, args) {
    const existing = this.store.get(
      "SELECT * FROM interactions WHERE member_id=? AND group_id=? AND kind=? AND state='pending' ORDER BY created DESC LIMIT 1",
      member.id,
      member.group_id,
      kind,
    );
    if (existing) {
      if (JSON.parse(existing.payload).text === text) return interactionView(existing);
      this.store.setInteractionState(existing.id, 'cancelled', null, null, '请求内容已变化');
    }
    const message = this.memberInteractionAnchor(member, text);
    const row = this.store.createInteraction({
      id: randomUUID(),
      groupId: member.group_id,
      memberId: member.id,
      endpointId: endpoint.id,
      context: endpoint.context,
      turnId: origin?.turnId ?? '',
      callId: origin?.callId ?? randomUUID(),
      messageId: message.id,
      kind,
      payload: { kind, text, args },
    });
    return interactionView(row);
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
  failPanelDelivery(session, input, entry, error) {
    this.store.run('UPDATE panel_outbox SET error=? WHERE id=?', error.message, entry.id);
    if (this.closing) return;
    const message = this.store.get('SELECT sender FROM messages WHERE id=?', input.message.id);
    if (message?.sender) {
      const notice = this.store.append(session.group_id, 'system', message.sender, 'system',
        `消息 ${input.message.id} 发给 Panel Agent 的会话失败：${error.message}。不会自动重试。`);
      this.emit('notice', notice);
    }
  }
  deliverPanel(entry) {
    const session = this.store.get('SELECT * FROM panel_sessions WHERE id=?', entry.session_id);
    if (!session || session.context !== 'coordination') return;
    const panelAgent = this.store.get('SELECT * FROM panel_agents WHERE id=?', session.panel_agent_id);
    if (!panelAgent) return;
    const input = JSON.parse(entry.payload);
    const schema = this.information.panelSchemaForStart(session);
    let prompt;
    try {
      if (schema === CONTEXT_SCHEMA_VERSION) {
        const group = this.store.group(session.group_id);
        prompt = JSON.stringify(this.information.turnInput({
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
      this.failPanelDelivery(session, input, entry, error);
      return;
    }
    this.runPanelTurn({
      session: { ...session, group_id: session.group_id },
      panelAgent,
      prompt,
      activeTeamId: session.group_id,
      inputs: [input.message, ...(input.additionalMessages ?? []), ...input.notes],
      onAccepted: () => this.store.run('UPDATE panel_outbox SET accepted=? WHERE id=?', new Date().toISOString(), entry.id),
    }).catch(error => {
      this.failPanelDelivery(session, input, entry, error);
    });
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
  async archiveGroup(groupId) {
    await this.stopWhere(e => e.group_id === groupId);
    return this.setGroupState(groupId, 'archived');
  }
  restoreGroup(groupId) {
    const group = this.setGroupState(groupId, 'open');
    setImmediate(() => this.pump());
    return group;
  }
  directive(groupId, text) {
    this.collaboration.requireCommunication(groupId);
    const controller = this.teamController(groupId);
    const message = this.store.append(groupId, 'user', controller.id, 'send', text);
    queueMicrotask(() => this.pump()); return { messageId: message.id };
  }
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
      endpoints: visibleEndpoints,
      sessionBindings,
      modelPolicy: this.modelPolicy(),
      modelPolicyDefaults: {
        smart: {
          performance: SMART_PERFORMANCE_RULES,
          cost: SMART_COST_RULES,
        },
        user: DEFAULT_USER_MODEL_RULES,
      },
      // This is an observation of the processes currently owned by this bus, not stored business state.
      runningEndpoints: [...this.running.values()]
        .filter(({ endpoint }) => endpoint.context !== 'private' && endpoint.context !== 'panel-private')
        .map(({ endpoint }) => endpoint.id),
      panelRunning: [...this.running.values()]
        .filter(({ endpoint }) => String(endpoint.context).startsWith('panel-'))
        .map(({ endpoint, turnId, activeTeamId }) => ({ endpoint: endpoint.id, groupId: activeTeamId ?? endpoint.group_id ?? null, turnId })),
      panelUnknown: panelAgent ? this.panelUnknown() : [],
      agentTasks: groupId ? this.agentTasksView(groupId) : [],
      groupStates: this.store.all('SELECT id,state,charter,policy,allow_shell FROM groups'),
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
