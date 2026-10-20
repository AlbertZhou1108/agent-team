import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { statSync, rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { Store } from './store.mjs';
import { toolsFor, validateTool } from './tools.mjs';

export class Bus extends EventEmitter {
  constructor({ directory, hosts, confirm = async () => false }) {
    super();
    this.store = new Store(directory);
    this.hosts = hosts;
    this.confirm = confirm;
    this.running = new Map();
    this.closing = false;
    this.store.run('UPDATE outbox SET error=NULL WHERE accepted IS NULL');
  }
  start() {
    for (const member of this.store.all("SELECT * FROM members WHERE removed IS NULL AND profile=''")) this.introduce(member);
    this.pump();
  }
  requireHost(host) { if (!this.hosts.has(host)) throw new Error(`宿主未配置: ${host}`); }
  createGroup({ name, workspace, lead, members = [] }) {
    if (!name?.trim() || !lead?.name || !lead?.host) throw new Error('需要群名、主 Agent 名称与宿主');
    if (name.length > 200) throw new Error('群名过长');
    workspace = resolve(workspace);
    if (!statSync(workspace).isDirectory()) throw new Error('工作目录无效');
    const people = [{ ...lead, role: 'lead' }, ...members.map(member => ({ ...member, role: 'member' }))];
    const names = new Set();
    for (const person of people) {
      this.requireHost(person.host);
      if (!person.name?.trim() || person.name.length > 100 || names.has(person.name)) throw new Error('成员名称为空、重复或过长');
      names.add(person.name);
    }
    const id = randomUUID();
    this.store.transaction(() => {
      this.store.run('INSERT INTO groups VALUES(?,?,?,?,?)', id, name, workspace, null, new Date().toISOString());
      for (const person of people) {
        const memberId = randomUUID();
        this.store.run('INSERT INTO members(id,group_id,name,host,role) VALUES(?,?,?,?,?)', memberId, id, person.name, person.host, person.role);
        if (person.role === 'lead') this.store.run('UPDATE groups SET lead=? WHERE id=?', memberId, id);
      }
    });
    for (const member of this.members(id)) this.introduce(member);
    return this.store.group(id);
  }
  members(groupId) { this.store.group(groupId); return this.store.all('SELECT * FROM members WHERE group_id=? AND removed IS NULL ORDER BY rowid', groupId); }
  resolveMember(groupId, value) {
    const member = this.store.get('SELECT * FROM members WHERE group_id=? AND (id=? OR name=?) AND removed IS NULL', groupId, value, value);
    if (!member) throw new Error(`群内找不到成员: ${value}`);
    return member;
  }
  async addMember(groupId, { name, host }) {
    this.store.group(groupId); this.requireHost(host);
    if (!name?.trim() || name.length > 100) throw new Error('成员名称无效');
    const id = randomUUID();
    this.store.run('INSERT INTO members(id,group_id,name,host,role) VALUES(?,?,?,?,?)', id, groupId, name, host, 'member');
    this.introduce(this.store.member(id));
    return this.store.member(id);
  }
  async removeMember(groupId, memberId) {
    const member = this.resolveMember(groupId, memberId);
    if (member.role === 'lead') throw new Error('不能移除主 Agent；可删除群');
    this.store.run('UPDATE members SET removed=? WHERE id=?', new Date().toISOString(), member.id);
    await this.stopWhere(endpoint => endpoint.member_id === member.id);
    return { removed: member.id };
  }
  async deleteGroup(groupId) {
    this.store.group(groupId);
    const endpoints = this.store.all('SELECT id FROM endpoints WHERE group_id=?', groupId);
    await this.stopWhere(endpoint => endpoint.group_id === groupId && endpoint.context !== 'private');
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
群内每对成员的对话上下文独立，用户私聊不进群；任务、完成与审查由 Agent 和用户判断，框架不维护这些状态。
成员要由用户确认后加入；不要自行扩充团队。不需要回复时可以沉默，避免无意义的相互致谢。`;
  }
  introduce(member) {
    if (this.closing) return;
    const endpoint = this.store.endpoint(member.id, 'profile');
    this.runEndpoint(endpoint, '入群说明：请用 profile_set 写一小段真实的能力自述。只写你自己的；然后结束本回合，不必给其他成员发消息。').catch(error => {
      if (!this.closing) this.notify(member.group_id, this.store.get('SELECT lead FROM groups WHERE id=?', member.group_id)?.lead, `成员 ${member.name} 入群说明失败：${error.message}`);
    });
  }
  async tool(endpointId, key, name, args, provenance = {}) {
    const endpoint = this.store.authenticate(endpointId, key);
    validateTool(this.store.member(endpoint.member_id).role, name, args);
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
    validateTool(member.role, name, args);
    const groupId = member.group_id;
    if (name === 'members') return this.members(groupId).map(({ id, name: displayName, host, role, profile }) => ({ id, name: displayName, host, role, profile }));
    if (name === 'read') {
      const rows = this.store.all(`SELECT * FROM messages WHERE group_id=? AND seq>? ${args.sender ? 'AND sender=?' : ''} ORDER BY seq LIMIT ?`, groupId, args.after ?? 0, ...(args.sender ? [this.resolveMember(groupId, args.sender).id] : []), args.limit ?? 50);
      return { messages: rows, nextAfter: rows.at(-1)?.seq ?? args.after ?? 0 };
    }
    if (name === 'profile_set') { this.store.run('UPDATE members SET profile=? WHERE id=?', args.text, member.id); return { member: member.id, profile: args.text }; }
    if (name === 'send' || name === 'note') {
      const target = this.resolveMember(groupId, args.to);
      if (target.id === member.id) throw new Error('不能向自己发消息');
      const message = this.store.transaction(() => {
        const message = this.store.append(groupId, member.id, target.id, name, args.text);
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
      if (!await this.confirm(`建立群 ${args.name}，主 Agent ${member.name} (${member.host})，成员 ${people.map(person => `${person.name} (${person.host})`).join(', ') || '无'}？`)) throw new Error('用户尚未确认建群');
      this.store.authenticate(endpointId, key);
      return this.createGroup({ name: args.name, workspace: args.workspace, lead: { name: member.name, host: member.host }, members: people });
    }
    if (name === 'group_add') {
      this.requireHost(args.host);
      if (!await this.confirm(`将 ${args.name} (${args.host}) 加入群 ${this.store.group(groupId).name}？`)) throw new Error('用户尚未确认；可在 CLI 使用 /add 名称=宿主');
      this.store.authenticate(endpointId, key);
      return this.addMember(groupId, args);
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
      if (!this.running.has(entry.endpoint_id)) this.deliver(entry);
    }
    for (const message of this.store.pending()) {
      if (this.store.get('SELECT 1 FROM attached WHERE message_id=?', message.id)) continue;
      const endpoint = this.store.endpoint(message.recipient, `pair:${message.sender}`, message.sender);
      if (this.running.has(endpoint.id) || this.store.get('SELECT 1 FROM outbox WHERE endpoint_id=? AND accepted IS NULL', endpoint.id)) continue;
      const entry = this.store.prepare(message, endpoint);
      if (entry) this.deliver(entry);
    }
  }
  deliver(entry) {
    const endpoint = this.store.get('SELECT * FROM endpoints WHERE id=?', entry.endpoint_id);
    if (!endpoint || !this.store.get('SELECT 1 FROM members WHERE id=? AND removed IS NULL', endpoint.member_id)) return;
    const input = JSON.parse(entry.payload);
    this.runEndpoint(endpoint, `当前正式群消息与附带待阅留言（一次输入；此前回合的临时指令已结束）：\n${JSON.stringify(input)}`, () => {
      this.store.run('UPDATE outbox SET accepted=? WHERE id=?', new Date().toISOString(), entry.id);
    }, [input.message, ...(input.additionalMessages ?? []), ...input.notes]).catch(error => {
      if (this.closing) return;
      this.store.run('UPDATE outbox SET error=? WHERE id=?', error.message, entry.id);
      const accepted = this.store.get('SELECT accepted FROM outbox WHERE id=?', entry.id)?.accepted;
      this.notify(endpoint.group_id, input.message.sender, `消息 ${input.message.id} 发给成员 ${endpoint.member_id} 的会话失败：${error.message}。${accepted ? '宿主已经接受输入；请查看宿主记录决定是否另发消息。' : '不会自动重试；可用 /retry 或重启恢复未发出的消息。'}`);
    });
  }
  async runEndpoint(endpoint, text, onAccepted = () => {}, inputs = []) {
    if (this.running.has(endpoint.id)) throw new Error('该会话正在运行');
    const member = this.store.member(endpoint.member_id);
    const group = this.store.group(member.group_id);
    const host = this.hosts.get(member.host);
    if (!host) throw new Error(`宿主未配置: ${member.host}`);
    const abort = new AbortController();
    const turnId = this.store.createTurn(endpoint, inputs);
    const live = { endpoint, abort, turnId, done: null };
    this.running.set(endpoint.id, live);
    this.store.history(endpoint.id, { type: 'input', text }, turnId);
    const promise = Promise.resolve().then(() => host.run({
      endpoint, turnId, workspace: group.workspace, prompt: text, instructions: this.rules(endpoint),
      tools: toolsFor(member.role), signal: abort.signal,
      onAccepted: () => { onAccepted(); this.store.history(endpoint.id, { type: 'framework.input_accepted' }, turnId); },
      onNativeTurn: ref => { this.store.run('INSERT OR IGNORE INTO native_turn_refs VALUES(?,?)', turnId, String(ref)); },
      onTool: (name, args, metadata = {}) => this.tool(endpoint.id, endpoint.key, name, args, { ...metadata, turnId }),
      onSession: session => { this.store.run('UPDATE endpoints SET session=? WHERE id=?', session, endpoint.id); endpoint.session = session; this.store.run('UPDATE turns SET session=? WHERE id=?', session, turnId); },
      onModel: observation => { this.store.history(endpoint.id, { type: 'framework.model', ...observation }, turnId); },
      onEvent: event => { if (!this.closing) this.store.history(endpoint.id, event, turnId); },
    }));
    live.done = promise;
    try { const result = await promise; this.store.history(endpoint.id, { type: 'framework.output', text: result }, turnId); return result; }
    catch (error) { this.store.history(endpoint.id, { type: 'framework.error', error: error.message }, turnId); throw error; }
    finally { this.running.delete(endpoint.id); setImmediate(() => this.pump()); }
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
  retry(groupId) { this.store.group(groupId); this.store.run('UPDATE outbox SET error=NULL WHERE accepted IS NULL AND endpoint_id IN (SELECT id FROM endpoints WHERE group_id=?)', groupId); this.pump(); return { retryRequested: true }; }
  snapshot() {
    const endpoints = this.store.all("SELECT id,group_id,member_id,context,peer,session FROM endpoints WHERE context!='private'")
      .map(endpoint => ({ ...endpoint, modelState: this.store.endpointModelSummary(endpoint.id) }));
    return {
      groups: this.store.all('SELECT * FROM groups ORDER BY created'),
      members: this.store.all('SELECT * FROM members ORDER BY rowid'),
      endpoints,
      // This is an observation of the processes currently owned by this bus, not stored business state.
      runningEndpoints: [...this.running.values()].filter(({ endpoint }) => endpoint.context !== 'private').map(({ endpoint }) => endpoint.id),
    };
  }
  async close() {
    this.closing = true;
    await this.stopWhere(() => true);
    await Promise.allSettled([...this.hosts.values()].map(host => host.close?.()));
    this.store.close();
  }
}
