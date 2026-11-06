import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { statSync, rmSync } from 'node:fs';
import { roleNameKey } from './collaboration.mjs';
import * as messagesAgg from './aggregates/messages.mjs';
import * as conversationsAgg from './aggregates/conversations.mjs';
import * as teamsAgg from './aggregates/teams.mjs';

// 团队生命周期:创建/删除、成员增删、归档恢复、控制者切换与任务面板。
// 本模块不反向依赖 Bus;跨职责调用经 bus 引用。

export class GroupLifecycle {
  constructor(bus) {
    this.bus = bus;
  }
  controllerState(groupId) {
    this.bus.store.group(groupId);
    const assignment = teamsAgg.controllerAssignment(this.bus.store, groupId);
    return {
      groupId,
      controller: this.bus.teamController(groupId),
      revision: assignment?.revision ?? 0,
      panelRelation: this.bus.panelTeamRelation(groupId),
    };
  }
  assertControllerSwitchSafe(groupId) {
    if (!this.bus.collaboration.communicationOpen(groupId)) throw new Error('团队已归档，不能切换控制者');
    const running = [...this.bus.running.values()].filter(item => (
      item.endpoint.group_id === groupId || item.activeTeamId === groupId
    ));
    if (running.length) throw new Error('团队仍有运行中回合，不能切换控制者');
    if (this.bus.collaboration.unknown(groupId).length) throw new Error('团队存在待核实运行，不能切换控制者');
    if (this.bus.panelUnknown(groupId).length) throw new Error('Panel Agent 团队上下文存在待核实运行，不能切换控制者');
    const pending = messagesAgg.pending(this.bus.store).filter(message => message.group_id === groupId);
    if (pending.length) throw new Error(`团队仍有未处理正式消息，不能切换控制者: ${pending.map(message => `${message.seq}:${message.id}`).join(', ')}`);
    if (messagesAgg.hasPendingDeliveryForGroup(this.bus.store, groupId)) {
      throw new Error('团队仍有待投递消息，不能切换控制者');
    }
  }
  takeoverTeam(groupId, expectedRevision) {
    const panelAgent = this.bus.panelAgent();
    if (!panelAgent) throw new Error('Panel Agent 尚未创建');
    const group = this.bus.store.group(groupId);
    const relation = this.bus.panelTeamRelation(groupId);
    if (relation === 'main') throw new Error('Panel Agent 已经是该团队的主 Agent');
    const current = teamsAgg.controllerAssignment(this.bus.store, groupId);
    const currentRevision = current?.revision ?? 0;
    if (expectedRevision !== undefined && expectedRevision !== currentRevision) throw new Error('控制者版本已变化，请重新读取');
    this.bus.assertControllerSwitchSafe(groupId);
    const originalLeadId = current?.controller_kind === 'member'
      ? current.controller_id
      : current?.original_lead_id ?? group.lead;
    if (!originalLeadId) throw new Error('团队没有可暂停的原主 Agent');
    const now = new Date().toISOString();
    this.bus.store.transaction(() => {
      teamsAgg.promoteToPanelController(this.bus.store, {
        groupId: group.id,
        panelAgentId: panelAgent.id,
        originalLeadId,
        now,
      });
      this.bus.store.run(
        "INSERT INTO panel_team_bindings(panel_agent_id,group_id,relation,created,updated) VALUES(?,?,'main',?,?) ON CONFLICT(panel_agent_id,group_id) DO UPDATE SET relation='main',updated=excluded.updated",
        panelAgent.id,
        group.id,
        now,
        now,
      );
      conversationsAgg.forPanelAgent(this.bus.store, panelAgent.id, 'coordination', { groupId: group.id });
      this.bus.store.run(
        "UPDATE interactions SET state='cancelled',detail='控制者已变化',answered=? WHERE group_id=? AND kind IN ('takeover','handback') AND state='pending'",
        now,
        group.id,
      );
    });
    return this.bus.controllerState(group.id);
  }
  handbackTeam(groupId, expectedRevision) {
    const panelAgent = this.bus.panelAgent();
    if (!panelAgent) throw new Error('Panel Agent 尚未创建');
    this.bus.requirePanelMain(panelAgent.id, groupId);
    const current = teamsAgg.controllerAssignment(this.bus.store, groupId);
    if (expectedRevision !== undefined && expectedRevision !== current.revision) throw new Error('控制者版本已变化，请重新读取');
    this.bus.assertControllerSwitchSafe(groupId);
    const original = current.original_lead_id ? teamsAgg.activeMemberById(this.bus.store, current.original_lead_id) : null;
    if (!original) throw new Error('原主 Agent 不存在或已移除，无法交还');
    const now = new Date().toISOString();
    this.bus.store.transaction(() => {
      teamsAgg.handbackToMember(this.bus.store, { groupId, memberId: original.id, now });
      this.bus.store.run(
        "UPDATE panel_team_bindings SET relation='observer',updated=? WHERE panel_agent_id=? AND group_id=?",
        now,
        panelAgent.id,
        groupId,
      );
      this.bus.store.run(
        "UPDATE interactions SET state='cancelled',detail='控制者已变化',answered=? WHERE group_id=? AND kind IN ('takeover','handback') AND state='pending'",
        now,
        groupId,
      );
    });
    return this.bus.controllerState(groupId);
  }
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
    this.bus.store.group(groupId);
    const normalized = this.bus.normalizeAgentTasks(tasks);
    const updated = new Date().toISOString();
    teamsAgg.setAgentTasks(this.bus.store, { ownerId, groupId, tasks: normalized, updated });
    return { owner: ownerId, updated };
  }
  agentTasksView(groupId) {
    const panelAgent = this.bus.panelAgent();
    return teamsAgg.agentTasksForGroup(this.bus.store, groupId)
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
  createGroup({ name, workspace, lead, members = [], panelAgentId, charter, policy, allowShell, operationId }) {
    if (operationId !== undefined && (typeof operationId !== 'string' || !/^[\w-]{1,128}$/.test(operationId))) throw new Error('请求编号无效');
    const creationPayload = JSON.stringify({ name, workspace, lead, members, panelAgentId, charter, policy, allowShell });
    if (operationId) {
      const previous = teamsAgg.groupCreateOperation(this.bus.store, operationId);
      if (previous) {
        if (previous.payload !== creationPayload) throw new Error('请求编号已用于不同建群内容');
        if (!previous.ref) throw new Error('该请求创建的团队已删除');
        return this.bus.store.group(previous.ref);
      }
    }
    const panelAgent = panelAgentId ? this.bus.store.get('SELECT * FROM panel_agents WHERE id=?', panelAgentId) : null;
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
      this.bus.requireHost(person.host);
      const key = person.name?.trim() ? roleNameKey(person.name) : '';
      if (!key || person.name.length > 100 || names.has(key)) throw new Error('成员名称为空、重复或过长');
      names.add(key);
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.bus.store.transaction(() => {
      teamsAgg.insertGroup(this.bus.store, {
        id,
        name,
        workspace,
        created: now,
        charter: typeof charter === 'string' && charter.trim() ? charter.trim() : null,
        policy: policy ?? 'workspace-write',
        allowShell: allowShell === undefined ? 1 : allowShell ? 1 : 0,
      });
      for (const person of people) {
        const memberId = randomUUID();
        const selection = this.bus.defaultModelSelection(person.host);
        teamsAgg.insertMember(this.bus.store, {
          id: memberId,
          groupId: id,
          name: person.name,
          host: person.host,
          role: person.role,
          selection,
        });
        this.bus.collaboration.reserveMemberName(id, memberId, person.name);
        if (person.role === 'lead') teamsAgg.setGroupLead(this.bus.store, id, memberId);
      }
      if (operationId) teamsAgg.recordGroupCreate(this.bus.store, { operationId, payload: creationPayload, groupId: id, created: new Date().toISOString() });
      if (panelAgent) {
        teamsAgg.insertPanelController(this.bus.store, { groupId: id, panelAgentId: panelAgent.id, now });
        this.bus.store.run(
          "INSERT INTO panel_team_bindings(panel_agent_id,group_id,relation,created,updated) VALUES(?,?,'main',?,?)",
          panelAgent.id,
          id,
          now,
          now,
        );
      } else if (this.bus.panelAgent()) {
        const owner = this.bus.panelAgent();
        this.bus.store.run(
          "INSERT INTO panel_team_bindings(panel_agent_id,group_id,relation,created,updated) VALUES(?,?,'observer',?,?)",
          owner.id,
          id,
          now,
          now,
        );
      }
    });
    for (const member of this.bus.members(id)) if (!member.profile) this.bus.introduce(member);
    return this.bus.store.group(id);
  }
  setGroupState(groupId, state) {
    if (this.bus.deletingGroups.has(groupId)) throw new Error('团队正在删除');
    if (!['open', 'archived'].includes(state)) throw new Error('团队状态无效');
    const group = this.bus.store.group(groupId);
    this.bus.store.transaction(() => {
      if (state === 'archived') {
        if (group.state !== 'archived') this.bus.archiveSnapshots.capture(group);
      } else this.bus.archiveSnapshots.discard(groupId);
      teamsAgg.updateGroupState(this.bus.store, groupId, state);
    });
    return this.bus.store.group(groupId);
  }
  members(groupId) { this.bus.store.group(groupId); return teamsAgg.activeMembers(this.bus.store, groupId); }
  resolveMember(groupId, value) {
    const member = teamsAgg.findMember(this.bus.store, groupId, value)
      ?? teamsAgg.findMemberByRoleName(this.bus.store, groupId, roleNameKey(value));
    if (!member) throw new Error(`群内找不到成员: ${value}`);
    return member;
  }
  resolveRecipient(groupId, value) {
    const controller = this.bus.teamController(groupId);
    if (value === controller.id || value === controller.name || value === '主 Agent' || value === '主Agent') {
      return { id: controller.id, name: controller.name, kind: controller.kind };
    }
    return this.bus.resolveMember(groupId, value);
  }
  async addMember(groupId, { name, host }) {
    this.bus.collaboration.requireCommunication(groupId); this.bus.requireHost(host);
    if (!name?.trim() || name.length > 100) throw new Error('成员名称无效');
    if (teamsAgg.roleNameTaken(this.bus.store, groupId, roleNameKey(name))) throw new Error('名称已被本团队历史使用');
    const selection = this.bus.defaultModelSelection(host);
    const id = randomUUID();
    this.bus.store.transaction(() => {
      teamsAgg.insertMember(this.bus.store, {
        id,
        groupId,
        name: name.trim(),
        host,
        role: 'member',
        selection,
      });
      this.bus.collaboration.reserveMemberName(groupId, id, name);
    });
    this.bus.introduce(this.bus.store.member(id));
    return this.bus.store.member(id);
  }
  async removeMember(groupId, memberId) {
    const member = this.bus.resolveMember(groupId, memberId);
    if (member.role === 'lead') throw new Error('不能移除主 Agent；可删除群');
    teamsAgg.markMemberRemoved(this.bus.store, member.id);
    messagesAgg.clearAwaitingForRecipient(this.bus.store, member.id);
    for (const row of this.bus.store.pendingMemberInteractions(groupId, member.id)) this.bus.store.setInteractionState(row.id, 'cancelled');
    await this.bus.stopWhere(endpoint => endpoint.member_id === member.id);
    // 已移除成员不会再接收输入。等待回合收尾后丢弃未接受的投递队列，
    // 消息与回合历史仍保留；避免重试重新激活永远无法投递的条目。
    messagesAgg.discardPendingDeliveriesForMember(this.bus.store, member.id);
    return { removed: member.id };
  }
  async deleteGroup(groupId, { archivedOnly = false } = {}) {
    const group = this.bus.store.group(groupId);
    if (archivedOnly && group.state !== 'archived') throw new Error('请先归档团队，再永久删除');
    if (this.bus.deletingGroups.has(groupId)) throw new Error('团队正在删除');
    this.bus.deletingGroups.add(groupId);
    try {
      await this.bus.stopWhere(endpoint => endpoint.group_id === groupId);
      const snapshot = this.bus.store.get('SELECT id FROM archive_snapshots WHERE group_id=?', groupId);
      if (snapshot) await this.bus.archiveSnapshots.pending.get(snapshot.id);
      const s = this.bus.store;
      const conversations = conversationsAgg.idsForGroup(s, groupId);
      s.transaction(() => {
        // 这些引用没有外键，需要在级联删除来源行之前清理。
        s.run(`DELETE FROM workbench_dismissals WHERE
          (category='interaction' AND item_id IN (SELECT id FROM interactions WHERE group_id=?)) OR
          (category IN ('waiting:user','waiting:agent') AND item_id IN (SELECT id FROM messages WHERE group_id=?))`, groupId, groupId);
        s.run('DELETE FROM telemetry_session_generations WHERE endpoint_id IN (SELECT id FROM conversations WHERE group_id=?)', groupId);
        s.run("DELETE FROM panel_messages WHERE context='coordination' AND active_team_id=?", groupId);
        // 全局私人聊天保留正文，解除已删除团队的上下文引用。
        s.run('UPDATE panel_messages SET active_team_id=NULL WHERE active_team_id=?', groupId);
        s.run('DELETE FROM information_measurements WHERE group_id=? OR endpoint_id IN (SELECT id FROM conversations WHERE group_id=?)', groupId, groupId);
        s.run('DELETE FROM groups WHERE id=?', groupId);
        this.bus.information.pruneOrphanTurnSchemas();
      });
      const cleanupWarnings = [];
      for (const { id } of conversations) {
        try { rmSync(resolve(s.directory, 'endpoints', id), { recursive: true, force: true }); }
        catch (error) { cleanupWarnings.push(error.message); }
      }
      // 数据库已提交，文件清理失败不能再报告“团队删除失败”。
      return { deleted: groupId, ...(cleanupWarnings.length ? { cleanupWarnings } : {}) };
    } finally {
      this.bus.deletingGroups.delete(groupId);
    }
  }
  async archiveGroup(groupId) {
    const group = this.bus.store.group(groupId);
    if (group.state === 'archived') return group;
    await this.bus.stopWhere(e => e.group_id === groupId);
    return this.bus.setGroupState(groupId, 'archived');
  }
  restoreGroup(groupId) {
    const group = this.bus.setGroupState(groupId, 'open');
    setImmediate(() => this.bus.pump());
    return group;
  }
  directive(groupId, text) {
    this.bus.collaboration.requireCommunication(groupId);
    const controller = this.bus.teamController(groupId);
    const message = messagesAgg.append(this.bus.store, groupId, 'user', controller.id, 'send', text);
    queueMicrotask(() => this.bus.pump()); return { messageId: message.id };
  }
}
