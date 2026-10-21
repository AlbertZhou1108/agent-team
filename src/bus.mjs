import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { statSync, rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { Store } from './store.mjs';
import { toolsFor, validateTool } from './tools.mjs';
import { Collaboration, roleNameKey } from './collaboration.mjs';

export class Bus extends EventEmitter {
  constructor({ directory, hosts, confirm = async () => false }) {
    super();
    this.store = new Store(directory);
    this.collaboration = new Collaboration(this.store);
    this.hosts = hosts;
    this.collaboration.policyValidator = (member, policy) => {
      const host = this.hosts.get(member.host);
      return host?.supportsPolicy?.({ member, policy }) ?? { supported: true };
    };
    this.confirm = confirm;
    this.running = new Map();
    this.closing = false;
    this.preparing = new Map();
  }
  start() {
    // Serving the panel does not implicitly resume historical work.
    for (const s of this.store.all("SELECT group_id FROM team_state WHERE phase='closing'")) this.reconcile(s.group_id);
    this.pump();
  }
  requireHost(host) { if (!this.hosts.has(host)) throw new Error(`宿主未配置: ${host}`); }
  requirePolicy(member, policy) {
    const host = this.hosts.get(member.host);
    const support = host?.supportsPolicy?.({ member, policy }) ?? { supported: true };
    if (support === false || support.supported === false) throw new Error(`${member.name}（${member.host}）不支持${policy.mode}${policy.allowShell ? ' + 命令' : ''}：${support.reason ?? '宿主能力不足'}`);
  }
  prepareGroup({ name, workspace, lead, members = [], existingGroupId }) {
    if (existingGroupId) {
      const g = this.store.group(existingGroupId);
      if (this.collaboration.state(g.id)) throw new Error('该群已有目标契约');
      const people = this.members(g.id);
      name = g.name; workspace = g.workspace;
      lead = people.find(m => m.id === g.lead);
      members = people.filter(m => m.id !== g.lead);
    }
    if (!name?.trim() || !lead?.name || !lead?.host) throw new Error('需要群名、主 Agent 名称与宿主');
    if (name.length > 200) throw new Error('群名过长');
    workspace = resolve(workspace);
    if (!statSync(workspace).isDirectory()) throw new Error('工作目录无效');
    const people = [{ ...lead, role: 'lead' }, ...members.map(member => ({ ...member, role: 'member' }))];
    const names = new Set();
    for (const person of people) {
      this.requireHost(person.host);
      const key = person.name?.trim() ? roleNameKey(person.name) : '';
      if (!key || person.name.length > 100 || names.has(key)) throw new Error('成员名称为空、重复或过长');
      names.add(key);
    }
    return this.collaboration.prepare({ name, workspace, lead, members, ...(existingGroupId ? { existingGroupId } : {}) });
  }
  createGroup() { throw new Error('请先准备并由用户确认目标契约，再创建团队'); }
  confirmPreparation(id, revision, hash) {
    const group = this.collaboration.confirmPreparation(id, revision, hash, spec => {
      if (spec.existingGroupId) return this.store.group(spec.existingGroupId);
      const { name, workspace, lead, members } = spec;
      const people = [{ ...lead, role: 'lead' }, ...members.map(m => ({ ...m, role: 'member' }))];
      const id = randomUUID();
      this.store.run('INSERT INTO groups VALUES(?,?,?,?,?)', id, name, workspace, null, new Date().toISOString());
      for (const person of people) {
        const memberId = randomUUID();
        this.store.run('INSERT INTO members(id,group_id,name,host,role) VALUES(?,?,?,?,?)', memberId, id, person.name, person.host, person.role);
        this.collaboration.reserveMemberName(id, memberId, person.name);
        if (person.role === 'lead') this.store.run('UPDATE groups SET lead=? WHERE id=?', memberId, id);
      }
      return this.store.group(id);
    });
    for (const member of this.members(group.id)) if (!member.profile && ![...this.running.values()].some(r => r.endpoint.member_id === member.id)) this.introduce(member);
    return group;
  }
  members(groupId) { this.store.group(groupId); return this.store.all('SELECT * FROM members WHERE group_id=? AND removed IS NULL ORDER BY rowid', groupId); }
  resolveMember(groupId, value) {
    const member = this.store.get('SELECT * FROM members WHERE group_id=? AND id=? AND removed IS NULL', groupId, value)
      ?? this.store.get(`SELECT m.* FROM members m JOIN role_names r ON r.member_id=m.id
        WHERE m.group_id=? AND m.removed IS NULL AND r.name_key=?`, groupId, roleNameKey(value));
    if (!member) throw new Error(`群内找不到成员: ${value}`);
    return member;
  }
  async addMember(groupId, { name, host }) {
    this.collaboration.requireActive(groupId); this.requireHost(host);
    if (!name?.trim() || name.length > 100) throw new Error('成员名称无效');
    const state = this.collaboration.state(groupId);
    const id = randomUUID();
    this.store.transaction(() => {
      this.store.run('INSERT INTO members(id,group_id,name,host,role,joined_goal_version) VALUES(?,?,?,?,?,?)', id, groupId, name.trim(), host, 'member', state.goal_version);
      this.collaboration.reserveMemberName(groupId, id, name);
    });
    this.introduce(this.store.member(id));
    return this.store.member(id);
  }
  async removeMember(groupId, memberId) {
    const member = this.resolveMember(groupId, memberId);
    if (member.role === 'lead') throw new Error('不能移除主 Agent；可删除群');
    if (this.collaboration.read(groupId).items.some(i => !['accepted', 'cancelled'].includes(i.state) && i.participants.some(p => p.memberId === member.id))) throw new Error('成员仍有未完成责任，请先重新分配工作');
    const state = this.collaboration.state(groupId);
    this.store.run('UPDATE members SET removed=?,removed_goal_version=? WHERE id=?', new Date().toISOString(), state?.goal_version ?? null, member.id);
    await this.stopWhere(endpoint => endpoint.member_id === member.id);
    return { removed: member.id };
  }
  async deleteGroup(groupId) {
    this.store.group(groupId);
    const endpoints = this.store.all('SELECT id FROM endpoints WHERE group_id=?', groupId);
    await this.stopWhere(endpoint => endpoint.group_id === groupId);
    this.store.run('DELETE FROM groups WHERE id=?', groupId);
    for (const { id } of endpoints) rmSync(resolve(this.store.directory, 'endpoints', id), { recursive: true, force: true });
    return { deleted: groupId };
  }
  rules(endpoint) {
    const member = this.store.member(endpoint.member_id);
    return `你是本机 Agent 群成员 ${member.name}，成员编号 ${member.id}，角色 ${member.role}。群编号 ${member.group_id}。
成员与参考能力：${JSON.stringify(this.members(member.group_id).map(({ id, name, profile }) => ({ id, name, profile })))}
使用 send/note 在群里发言，正文是自然语言。最终文本只属于宿主会话，不会自动进入群。
send 只发给一个接收者；note 不唤醒，用于涉及自己的对话补充或轻通知，随接收者下一条正式消息一起交付。
不要介入与自己无关的对话。需要上下文时自行 read，members 可查能力。profile_set 只能写自己的能力自述。
同一消息编号出现两次表示同一条消息重发；先查本会话上下文，避免重复操作。
普通成员之间的对话上下文独立；用户私聊不进群。主 Agent依据共享契约和工作状态协调团队。
成员要由用户确认后加入；不要自行扩充团队。不需要回复时可以沉默，避免无意义的相互致谢。
主 Agent的团队消息统一进入coordination会话；用户私聊独立，不能直接派工。工作项由主 Agent调度会话维护，成员用send自然语言汇报。契约不可自行修改，需用户批准。
收到汇报后依据目标缺口决定继续、等待、接受或收尾，不必回复致谢。不存在固定讨论轮数。
目标完成或失败终止后，群仍可继续沟通。后续消息只用于交流、解释结果和追问；不得改写上一目标的工作项、重新派工、执行命令、读写项目、重复收尾或扩大原契约权限。用户明确要求下一项执行任务时，只能调用next_goal_request提交完整新契约，等待用户批准后启动新的目标版本；聊天内容本身不会自动成为新目标。
团队唤醒由框架负责。不得创建、等待、打断或管理 Codex 原生子 Agent；不要调用 spawn/wait/agent 类原生协同工具。需要等待新信息时只结束当前回合，不要阻塞等待；框架会把下一条群消息作为同一个调度会话的新回合投递。
当前有效契约与执行状态：${JSON.stringify(this.collaboration.read(member.group_id))}`;
  }
  introduce(member) {
    if (this.closing) return;
    const endpoint = this.store.endpoint(member.id, 'profile');
    this.runEndpoint(endpoint, '入群说明：请用 profile_set 写一小段真实的能力自述。只写你自己的；然后结束本回合，不必给其他成员发消息。').catch(error => {
      if (!this.closing) this.notify(member.group_id, this.store.get('SELECT lead FROM groups WHERE id=?', member.group_id)?.lead, `成员 ${member.name} 入群说明失败：${error.message}`);
    });
  }
  async tool(endpointId, key, name, args, provenance = {}) {
    if (endpointId.startsWith('preparation:')) return this.preparationTool(endpointId.slice(12), key, name, args, provenance.turnId);
    const endpoint = this.store.authenticate(endpointId, key);
    validateTool(this.store.member(endpoint.member_id).role, name, args, endpoint.context);
    const { turnId, nativeCallId = null } = provenance;
    if (turnId && this.running.get(endpointId)?.turnId !== turnId) throw new Error('工具不属于当前执行回合');
    const origin = turnId ? { turnId, callId: randomUUID(), nativeCallId } : null;
    if (origin) origin.eventSeq = this.store.history(endpointId, { type: 'framework.tool_call', name, args, callId: origin.callId, nativeCallId }, turnId);
    try {
      const result = await this.executeTool(endpointId, key, name, args, origin);
      if (origin) this.store.history(endpointId, { type: 'framework.tool_result', callId: origin.callId, result }, turnId);
      return result;
    } catch (error) {
      if (origin) this.store.history(endpointId, { type: 'framework.tool_result', callId: origin.callId, error: error.message }, turnId);
      throw error;
    }
  }
  async executeTool(endpointId, key, name, args, origin) {
    const endpoint = this.store.authenticate(endpointId, key);
    const member = this.store.member(endpoint.member_id);
    validateTool(member.role, name, args, endpoint.context);
    const groupId = member.group_id;
    if (name === 'collaboration_read') return this.collaboration.read(groupId, args.after ?? 0);
    if (name === 'work_item_update' || name === 'team_finish') {
      const command = JSON.parse(args.command);
      if (name === 'team_finish') command.action = 'finish';
      else if (command.action) throw new Error('工作项工具不能调用其他动作');
      const result = this.collaboration.apply({ ...member, context: endpoint.context }, command, args.revision, args.operationId);
      return result;
    }
    if (name === 'contract_change_request') return this.collaboration.request(groupId, 'contract', { contract: JSON.parse(args.contract), reason: args.reason });
    if (name === 'next_goal_request') return this.collaboration.request(groupId, 'next_goal', { contract: JSON.parse(args.contract), reason: args.reason });
    if (name === 'finish_withdraw') { this.collaboration.reopen(groupId, args.reason); return { phase: 'active' }; }
    if (name === 'members') return this.members(groupId).map(({ id, name: displayName, host, role, profile }) => ({ id, name: displayName, host, role, profile }));
    if (name === 'read') {
      const rows = this.store.all(`SELECT * FROM messages WHERE group_id=? AND seq>? ${args.sender ? 'AND sender=?' : ''} ORDER BY seq LIMIT ?`, groupId, args.after ?? 0, ...(args.sender ? [this.resolveMember(groupId, args.sender).id] : []), args.limit ?? 50);
      return { messages: rows, nextAfter: rows.at(-1)?.seq ?? args.after ?? 0 };
    }
    if (name === 'profile_set') { this.store.run('UPDATE members SET profile=? WHERE id=?', args.text, member.id); return { member: member.id, profile: args.text }; }
    if (name === 'send' || name === 'note') {
      this.collaboration.requireCommunication(groupId);
      const target = this.resolveMember(groupId, args.to);
      if (target.id === member.id) throw new Error('不能向自己发消息');
      const message = this.store.transaction(() => {
        const inherited = origin ? this.store.all('SELECT DISTINCT c.work_item_id FROM turn_inputs i JOIN message_context c ON c.message_id=i.message_id WHERE i.turn_id=? AND c.work_item_id IS NOT NULL', origin.turnId) : [];
        const itemId = args.workItemId ?? (inherited.length === 1 ? inherited[0].work_item_id : null);
        const context = this.collaboration.messageContext(groupId, itemId);
        const message = this.store.append(groupId, member.id, target.id, name, args.text);
        this.store.run('INSERT INTO message_context VALUES(?,?,?)', message.id, context.workItemId, context.contractVersion);
        if (origin) this.store.run('INSERT INTO message_origins VALUES(?,?,?,?,?)', message.id, origin.turnId, origin.eventSeq, origin.callId, origin.nativeCallId);
        return message;
      });
      this.emit('message', message);
      queueMicrotask(() => this.pump());
      return { messageId: message.id };
    }
    if (name === 'groups') return this.store.all('SELECT * FROM groups ORDER BY created');
    if (name === 'group_create') {
      const people = (args.members ?? '').split(',').filter(Boolean).map(item => {
        const [name, host, ...extra] = item.trim().split('=');
        if (!name || !host || extra.length) throw new Error('成员格式应为 名称=宿主');
        this.requireHost(host);
        return { name, host };
      });
      return this.prepareGroup({ name: args.name, workspace: args.workspace, lead: { name: member.name, host: member.host }, members: people });
    }
    if (name === 'group_add') {
      this.requireHost(args.host);
      if (args.name.trim().length > 100) throw new Error('成员名称无效');
      return this.collaboration.request(groupId, 'member_add', args);
    }
    if (name === 'group_remove') return this.removeMember(groupId, args.member);
    if (name === 'group_delete') {
      if (!await this.confirm(`删除群 ${this.store.group(groupId).name} 的配置与消息记录？`)) throw new Error('用户未确认删除');
      this.store.authenticate(endpointId, key);
      return this.deleteGroup(groupId);
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
    for (const entry of this.store.all('SELECT * FROM outbox WHERE accepted IS NULL AND error IS NULL ORDER BY rowid')) {
      const endpoint = this.store.get('SELECT * FROM endpoints WHERE id=?', entry.endpoint_id);
      if (endpoint && this.canRun(endpoint.group_id) && !this.running.has(entry.endpoint_id) && !this.disposed(entry)) this.deliver(entry);
    }
    for (const message of this.store.pending()) {
      if (this.store.get('SELECT 1 FROM attached WHERE message_id=?', message.id)) continue;
      if (!this.canRun(message.group_id)) continue;
      const lead = this.store.group(message.group_id).lead;
      const endpoint = this.store.endpoint(message.recipient, message.recipient === lead ? 'coordination' : `pair:${message.sender}`, message.recipient === lead ? null : message.sender);
      if (this.running.has(endpoint.id) || this.store.get('SELECT 1 FROM outbox WHERE endpoint_id=? AND accepted IS NULL', endpoint.id)) continue;
      let policy;
      try { policy = this.collaboration.policy(endpoint, [message]); } catch { /* Persist this input and let deliver record the policy rejection. */ }
      const entry = this.store.prepare(message, endpoint, candidates => {
        try {
          const candidatePolicy = this.collaboration.policy(endpoint, candidates);
          return policy !== undefined && candidatePolicy.mode === policy.mode && candidatePolicy.allowShell === policy.allowShell;
        }
        catch { return false; }
      });
      if (entry) this.deliver(entry);
    }
  }
  canRun(groupId) {
    return this.collaboration.communicationOpen(groupId) && !this.collaboration.unknown(groupId).length;
  }
  disposed(entry) {
    const input = JSON.parse(entry.payload);
    return [input.message, ...(input.additionalMessages ?? [])].some(m => this.store.get('SELECT 1 FROM message_dispositions WHERE message_id=?', m.id));
  }
  deliver(entry) {
    const endpoint = this.store.get('SELECT * FROM endpoints WHERE id=?', entry.endpoint_id);
    if (!endpoint || !this.store.get('SELECT 1 FROM members WHERE id=? AND removed IS NULL', endpoint.member_id)) return;
    const input = JSON.parse(entry.payload);
    this.runEndpoint(endpoint, `当前正式群消息与附带待阅留言（一次输入；此前回合的临时指令已结束）：\n${JSON.stringify(input)}`, () => {
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
    const policy = this.collaboration.policy(endpoint, inputs);
    this.requirePolicy(member, policy);
    const sessionKey = typeof host.sessionKey === 'function' ? host.sessionKey({ policy, endpoint, member }) : 'default';
    if (typeof sessionKey !== 'string' || !sessionKey.trim()) throw new Error('宿主会话域无效');
    const binding = this.store.get('SELECT * FROM endpoint_session_bindings WHERE endpoint_id=? AND session_key=?', endpoint.id, sessionKey);
    const fallbackSession = sessionKey === 'default' ? endpoint.session : null;
    const effectiveEndpoint = { ...endpoint, session: binding?.session ?? fallbackSession };
    const previousPolicy = this.store.get('SELECT signature FROM endpoint_session_policies WHERE endpoint_id=? AND session_key=?', endpoint.id, sessionKey)
      ?? (!binding && fallbackSession ? this.store.get('SELECT signature FROM endpoint_policy WHERE endpoint_id=?', endpoint.id) : null);
    const turnId = this.store.createTurn(effectiveEndpoint, inputs);
    this.store.run('INSERT INTO runtime_attempts(turn_id,group_id,endpoint_id,state,policy,contract_version,created) VALUES(?,?,?,?,?,?,?)', turnId, group.id, endpoint.id, 'running', JSON.stringify(policy), policy.contractVersion, new Date().toISOString());
    const live = { endpoint: effectiveEndpoint, abort, turnId, done: null };
    this.running.set(endpoint.id, live);
    this.store.history(endpoint.id, { type: 'input', text }, turnId);
    this.store.history(endpoint.id, {
      type: 'framework.session_scope',
      domain: policy.domain,
      sessionKey,
      session: binding?.session ?? fallbackSession,
      reused: Boolean(binding?.session ?? fallbackSession),
    }, turnId);
    const promise = Promise.resolve().then(() => host.run({
      endpoint: effectiveEndpoint, turnId, workspace: group.workspace, prompt: text, instructions: this.rules(endpoint),
      tools: toolsFor(member.role, endpoint.context), policy, previousPolicy, signal: abort.signal,
      onAccepted: () => { onAccepted(); this.store.history(endpoint.id, { type: 'framework.input_accepted' }, turnId); },
      onNativeTurn: ref => { this.store.run('INSERT OR IGNORE INTO native_turn_refs VALUES(?,?)', turnId, String(ref)); },
      onTool: (name, args, metadata = {}) => this.tool(endpoint.id, endpoint.key, name, args, { ...metadata, turnId }),
      onSession: session => {
        this.store.run('INSERT INTO endpoint_session_bindings VALUES(?,?,?,?) ON CONFLICT(endpoint_id,session_key) DO UPDATE SET session=excluded.session,updated=excluded.updated', endpoint.id, sessionKey, session, new Date().toISOString());
        this.store.run('UPDATE endpoints SET session=? WHERE id=?', session, endpoint.id);
        endpoint.session = session;
        effectiveEndpoint.session = session;
        this.store.run('UPDATE turns SET session=? WHERE id=?', session, turnId);
      },
      onModel: observation => { this.store.history(endpoint.id, { type: 'framework.model', ...observation }, turnId); },
      onPolicy: observation => {
        if (observation.signature) {
          this.store.run('INSERT INTO endpoint_session_policies VALUES(?,?,?) ON CONFLICT(endpoint_id,session_key) DO UPDATE SET signature=excluded.signature', endpoint.id, sessionKey, observation.signature);
          this.store.run('INSERT INTO endpoint_policy VALUES(?,?) ON CONFLICT(endpoint_id) DO UPDATE SET signature=excluded.signature', endpoint.id, observation.signature);
        }
        this.store.history(endpoint.id, { type: 'framework.policy', ...observation }, turnId);
      },
      onEvent: event => { if (!this.closing) this.store.history(endpoint.id, event, turnId); },
    }));
    live.done = promise;
    try {
      const result = await promise;
      this.store.run("UPDATE runtime_attempts SET state=?,ended=? WHERE turn_id=?", abort.signal.aborted ? 'cancelled' : 'completed', new Date().toISOString(), turnId);
      this.store.history(endpoint.id, { type: 'framework.output', text: result }, turnId); return result;
    }
    catch (error) {
      this.store.run('UPDATE runtime_attempts SET state=?,detail=?,ended=? WHERE turn_id=?', error.runtimeUnknown ? 'unknown' : abort.signal.aborted ? 'cancelled' : 'failed', error.message, new Date().toISOString(), turnId);
      this.store.history(endpoint.id, { type: abort.signal.aborted ? 'framework.cancelled' : 'framework.error', error: error.message }, turnId); throw error;
    }
    finally { this.running.delete(endpoint.id); this.reconcile(group.id); setImmediate(() => this.pump()); }
  }
  async privateTurn(groupId, text) {
    const group = this.store.group(groupId);
    return this.runEndpoint(this.store.endpoint(group.lead, 'private'), text);
  }
  async stopWhere(predicate) {
    const active = [...this.running.values()].filter(({ endpoint }) => predicate(endpoint));
    for (const { abort } of active) abort.abort();
    await Promise.allSettled(active.map(item => item.done));
  }
  retry(groupId) { this.collaboration.requireCommunication(groupId); this.store.run('UPDATE outbox SET error=NULL WHERE accepted IS NULL AND endpoint_id IN (SELECT id FROM endpoints WHERE group_id=?)', groupId); this.pump(); return { retryRequested: true }; }
  reconcile(groupId) {
    if (this.collaboration.reconcile(groupId, [...this.running.values()].some(r => r.endpoint.group_id === groupId))) this.emit('finished', { groupId });
  }
  async terminate(groupId, reason) { this.collaboration.terminate(groupId, reason); await this.stopWhere(e => e.group_id === groupId); this.reconcile(groupId); return this.collaboration.read(groupId); }
  async decideRequest(groupId, id, approved, version) {
    const decision = this.collaboration.decideRequest(groupId, id, approved, version, [...this.running.values()].some(r => r.endpoint.group_id === groupId));
    if (decision.approved && decision.kind === 'member_add') await this.addMember(groupId, decision);
    if (decision.approved) this.directive(groupId, `用户已批准请求${id}，请读取当前契约和执行状态后继续。`);
    return decision;
  }
  directive(groupId, text) {
    this.collaboration.requireCommunication(groupId);
    const group = this.store.group(groupId);
    const message = this.store.append(groupId, 'user', group.lead, 'send', text);
    this.store.run('INSERT INTO message_context VALUES(?,?,?)', message.id, null, this.collaboration.state(groupId).contract_version);
    queueMicrotask(() => this.pump()); return { messageId: message.id };
  }
  resetSession(endpointId, reason, sessionKey = null) {
    const e = this.store.get('SELECT * FROM endpoints WHERE id=?', endpointId);
    if (!e || this.running.has(e.id) || this.collaboration.unknown(e.group_id).some(r => r.endpoint_id === e.id)) throw new Error('会话不存在、运行中或停止状态未核实');
    if (typeof reason !== 'string' || !reason.trim()) throw new Error('需要明确重建会话的原因');
    this.store.history(e.id, { type: 'framework.session_rotated', previousSession: e.session, reason });
    if (sessionKey) {
      this.store.run('DELETE FROM endpoint_session_bindings WHERE endpoint_id=? AND session_key=?', e.id, sessionKey);
      this.store.run('DELETE FROM endpoint_session_policies WHERE endpoint_id=? AND session_key=?', e.id, sessionKey);
    } else {
      this.store.run('DELETE FROM endpoint_session_bindings WHERE endpoint_id=?', e.id);
      this.store.run('DELETE FROM endpoint_session_policies WHERE endpoint_id=?', e.id);
      this.store.run('DELETE FROM endpoint_policy WHERE endpoint_id=?', e.id);
    }
    const remaining = this.store.get('SELECT session FROM endpoint_session_bindings WHERE endpoint_id=? ORDER BY updated DESC LIMIT 1', e.id);
    this.store.run('UPDATE endpoints SET session=? WHERE id=?', remaining?.session ?? null, e.id);
    return { endpointId: e.id, previousSession: e.session, sessionKey, historyRetained: true };
  }
  snapshot() {
    const endpoints = this.store.all("SELECT id,group_id,member_id,context,peer,session FROM endpoints WHERE context!='private'")
      .map(endpoint => ({ ...endpoint, modelState: this.store.endpointModelSummary(endpoint.id) }));
    const sessionBindings = this.store.all('SELECT endpoint_id,session_key,session,updated FROM endpoint_session_bindings ORDER BY endpoint_id,session_key');
    return {
      groups: this.store.all('SELECT * FROM groups ORDER BY created'),
      members: this.store.all('SELECT * FROM members ORDER BY rowid'),
      endpoints,
      sessionBindings,
      // This is an observation of the processes currently owned by this bus, not stored business state.
      runningEndpoints: [...this.running.values()].filter(({ endpoint }) => endpoint.context !== 'private').map(({ endpoint }) => endpoint.id),
      collaboration: this.store.all('SELECT group_id,goal_version,phase,outcome,revision FROM team_state'),
    };
  }
  async close() {
    this.closing = true;
    for (const p of this.preparing.values()) p.abort.abort();
    await Promise.allSettled([...this.preparing.values()].map(p => p.done));
    await this.stopWhere(() => true);
    await Promise.allSettled([...this.hosts.values()].map(host => host.close?.()));
    this.store.close();
  }
  endpointTools(id, key) {
    if (id.startsWith('preparation:')) {
      const p = this.store.get('SELECT key FROM preparations WHERE id=?', id.slice(12));
      if (!p || p.key !== key) throw new Error('准备会话来源无效');
      return toolsFor('preparation');
    }
    const e = this.store.authenticate(id, key);
    return toolsFor(this.store.member(e.member_id).role, e.context);
  }
  async preparationTool(id, key, name, args, turnId) {
    this.endpointTools(`preparation:${id}`, key);
    if (this.preparing.get(id)?.turnId !== turnId) throw new Error('准备工具不属于当前回合');
    validateTool('preparation', name, args);
    if (name === 'preparation_read') return this.collaboration.preparation(id);
    if (name === 'contract_propose') return this.collaboration.propose(id, JSON.parse(args.contract), args.revision);
    throw new Error('准备阶段工具不可用');
  }
  async preparationTurn(id, text) {
    if (typeof text !== 'string' || !text.trim() || text.length > 48000) throw new Error('准备输入无效');
    const p = this.collaboration.preparation(id);
    if (p.groupId || this.preparing.has(id)) throw new Error('准备会话已结束或正在运行');
    const raw = this.store.get('SELECT * FROM preparations WHERE id=?', id);
    const endpoint = { id: `preparation:${id}`, key: raw.key, session: raw.session, context: 'preparation', group_id: null };
    const host = this.hosts.get(p.spec.lead.host);
    const abort = new AbortController(), turnId = randomUUID();
    const live = { abort, turnId, done: null }; this.preparing.set(id, live);
    const instructions = `你是用户的主 Agent。当前对话处于建群前准备，尚未创建任何团队。只与用户明确目标契约，不执行项目任务。通过contract_propose更新草案，用户确认权不在你手中。
契约JSON字段：goal、scope、boundary、confirmation、delivery均为文本；criteria为非空完成条件文本数组；policy为communication、read-only、workspace-write之一；allowShell为是否允许必要命令的布尔值，默认false。Codex项目只读需要允许沙箱命令才能读取项目，否则应选择可直接读取文件的其他宿主。只提出必要权限，不默认扩大。
当前准备记录：${JSON.stringify(p)}。没有关键歧义时整理草案；存在重要不确定性时向用户提问。不得自行批准。`;
    live.done = Promise.resolve().then(() => host.run({ endpoint, turnId, workspace: p.spec.workspace, prompt: text, instructions, tools: toolsFor('preparation'), policy: { mode: 'communication', contractVersion: 0 }, previousPolicy: this.store.get('SELECT signature FROM preparation_policy WHERE preparation_id=?', id), signal: abort.signal,
      onSession: session => this.store.run('UPDATE preparations SET session=? WHERE id=?', session, id), onAccepted() {}, onNativeTurn() {}, onModel() {}, onEvent() {},
      onPolicy: observation => { if (observation.signature) this.store.run('INSERT INTO preparation_policy VALUES(?,?) ON CONFLICT(preparation_id) DO UPDATE SET signature=excluded.signature', id, observation.signature); },
      onTool: (name, args) => this.preparationTool(id, raw.key, name, args, turnId),
    }));
    try { return await live.done; } finally { this.preparing.delete(id); }
  }
}
