import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { statSync, rmSync } from 'node:fs';
import { roleNameKey } from './collaboration.mjs';
import * as messagesAgg from './aggregates/messages.mjs';
import * as conversationsAgg from './aggregates/conversations.mjs';
import * as teamsAgg from './aggregates/teams.mjs';
import * as readState from './aggregates/read-state.mjs';

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
      this.freezeCurrentPlan(group.id, now);
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
      this.freezeCurrentPlan(groupId, now);
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
  planIdFor(revision) {
    return `plan-${revision}`;
  }
  /** 当前任期的计划:控制者在本任期写过的、且每条都带 id 的列表;否则 null。 */
  currentPlan(groupId) {
    const controller = this.bus.teamController(groupId);
    const revision = controller.assignment?.revision ?? 0;
    const row = this.bus.store.get(
      'SELECT owner_id,tasks,updated,revision FROM agent_tasks WHERE owner_id=? AND group_id=?',
      controller.id, groupId,
    );
    if (!row || Number(row.revision) !== revision) return null;
    const tasks = JSON.parse(row.tasks);
    // 迁移前的旧列表没有 id,不自动当作计划;由迁移阶段统一提升。
    if (!tasks.every(task => typeof task.id === 'string')) return null;
    return {
      planId: this.planIdFor(revision),
      revision,
      ownerId: controller.id,
      ownerKind: controller.kind,
      tasks,
      updated: row.updated,
    };
  }
  normalizeAgentTasks(value, { plan = false } = {}) {
    if (!Array.isArray(value)) throw new Error('任务列表必须是数组');
    if (value.length > 20) throw new Error('任务列表最多 20 条');
    const ids = new Set();
    return value.map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('任务必须是对象');
      if (typeof item.text !== 'string' || !item.text.trim() || item.text.length > 500) throw new Error('任务文本需要 1-500 字符');
      if (!['doing', 'done', 'dropped'].includes(item.state)) throw new Error('任务状态必须是 doing、done 或 dropped');
      if (plan) {
        if (typeof item.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(item.id)) throw new Error(`第 ${index + 1} 步的 id 需为 1-32 位小写字母、数字或连字符`);
        if (ids.has(item.id)) throw new Error(`步骤 id 不能重复: ${item.id}`);
        ids.add(item.id);
        if (item.parent !== undefined) throw new Error('计划步骤不能带 parent');
        return { id: item.id, text: item.text.trim(), state: item.state };
      }
      if (item.id !== undefined) throw new Error('成员任务不需要 id');
      if (item.parent === undefined) return { text: item.text.trim(), state: item.state };
      const parent = item.parent;
      if (!parent || typeof parent !== 'object' || Array.isArray(parent)) throw new Error('parent 必须是 {planId, stepId}');
      if (typeof parent.planId !== 'string' || !/^plan-\d+$/.test(parent.planId)) throw new Error('parent.planId 无效');
      if (typeof parent.stepId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(parent.stepId)) throw new Error('parent.stepId 无效');
      return { text: item.text.trim(), state: item.state, parent: { planId: parent.planId, stepId: parent.stepId } };
    });
  }
  /** 成员任务挂靠校验:计划必须存在;步骤不存在时保留为孤儿并返回警告。 */
  parentWarning(groupId, parent) {
    const revision = this.bus.teamController(groupId).assignment?.revision ?? 0;
    if (parent.planId === this.planIdFor(revision)) {
      const plan = this.currentPlan(groupId);
      if (!plan) return { planId: parent.planId, stepId: parent.stepId, reason: '当前计划尚未建立' };
      if (!plan.tasks.some(task => task.id === parent.stepId)) return { planId: parent.planId, stepId: parent.stepId, reason: '步骤已移除' };
      return null;
    }
    const frozen = teamsAgg.frozenPlan(this.bus.store, groupId, parent.planId);
    if (!frozen) throw new Error(`parent.planId 不存在: ${parent.planId}`);
    const tasks = JSON.parse(frozen.payload).tasks ?? [];
    if (!tasks.some(task => task.id === parent.stepId)) return { planId: parent.planId, stepId: parent.stepId, reason: '步骤已移除' };
    return null;
  }
  /** 派工引用:只有当前主控、且指向当前计划的已有步骤才有效。 */
  assertStepRef(groupId, senderId, stepRef) {
    if (!stepRef) return null;
    const controller = this.bus.teamController(groupId);
    if (controller.id !== senderId) throw new Error('只有当前主控可以引用计划步骤');
    const plan = this.currentPlan(groupId);
    if (!plan) throw new Error('当前计划尚未建立，请先写自己的计划步骤');
    if (stepRef.planId !== plan.planId) throw new Error('step_ref 必须指向当前计划');
    if (!plan.tasks.some(task => task.id === stepRef.stepId)) throw new Error(`当前计划不存在步骤: ${stepRef.stepId}`);
    return { planId: stepRef.planId, stepId: stepRef.stepId };
  }
  setAgentTasks({ groupId, ownerId, tasks }) {
    this.bus.store.group(groupId);
    const controller = this.bus.teamController(groupId);
    const revision = controller.assignment?.revision ?? 0;
    const isController = controller.id === ownerId;
    const normalized = this.normalizeAgentTasks(tasks, { plan: isController });
    const updated = new Date().toISOString();
    const planId = this.planIdFor(revision);
    const warnings = isController ? [] : normalized
      .filter(task => task.parent)
      .map(task => this.parentWarning(groupId, task.parent))
      .filter(Boolean);
    let cancellations = [];
    if (isController) {
      const previous = this.currentPlan(groupId);
      const used = new Set(this.cancelledStepIds(groupId, planId));
      for (const step of normalized) {
        if (used.has(step.id)) throw new Error(`步骤 id 已被使用过: ${step.id}，请使用新 id`);
      }
      cancellations = this.detectCancellations(groupId, planId, previous?.tasks ?? [], normalized);
    }
    this.bus.store.transaction(() => {
      teamsAgg.setAgentTasks(this.bus.store, { ownerId, groupId, tasks: normalized, updated, revision });
      for (const cancellation of cancellations) this.recordCancellation(groupId, planId, controller, cancellation, updated);
    });
    return {
      owner: ownerId,
      revision,
      ...(isController ? { planId } : {}),
      updated,
      tasks: normalized,
      ...(warnings.length ? { warnings } : {}),
      ...(cancellations.length ? { cancellations } : {}),
    };
  }
  cancelledStepIds(groupId, planId) {
    return this.bus.store.all(
      "SELECT payload FROM plan_events WHERE group_id=? AND plan_id=? AND kind='step_cancelled'",
      groupId, planId,
    ).map(row => JSON.parse(row.payload).stepId);
  }
  affectedOwners(groupId, planId, stepId) {
    const ownerKind = id => this.taskOwnerKind(groupId, id);
    const owners = new Map();
    for (const row of teamsAgg.agentTasksForGroup(this.bus.store, groupId)) {
      const tasks = JSON.parse(row.tasks);
      if (!tasks.some(task => task.state === 'doing'
        && task.parent?.planId === planId
        && task.parent?.stepId === stepId)) continue;
      owners.set(row.owner_id, {
        owner_id: row.owner_id,
        owner_kind: ownerKind(row.owner_id),
      });
    }
    return [...owners.values()];
  }
  /** 对比前后两份计划:显式 dropped 与直接移除都算取消,并记录仍在进行中的受影响成员。 */
  detectCancellations(groupId, planId, previousTasks, nextTasks) {
    const next = new Map(nextTasks.map(step => [step.id, step]));
    const result = [];
    for (const old of previousTasks) {
      const current = next.get(old.id);
      const removed = !current;
      const dropped = current && current.state === 'dropped' && old.state !== 'dropped';
      if (!removed && !dropped) continue;
      result.push({
        stepId: old.id,
        text: old.text,
        source: removed ? 'removed' : 'dropped',
        affected: this.affectedOwners(groupId, planId, old.id),
      });
    }
    return result;
  }
  recordCancellation(groupId, planId, controller, cancellation, now) {
    teamsAgg.insertPlanEvent(this.bus.store, {
      id: randomUUID(),
      groupId,
      planId,
      kind: 'step_cancelled',
      ownerId: controller.id,
      revision: controller.assignment?.revision ?? 0,
      payload: {
        stepId: cancellation.stepId,
        text: cancellation.text,
        source: cancellation.source,
        affected: cancellation.affected,
      },
      created: now,
    });
  }
  /** 取消的影响何时消失:取消者或当前主控已向该成员发过消息,或该成员不再有该步骤下的进行中任务。 */
  unresolvedAffected(groupId, controllerId, event) {
    const payload = JSON.parse(event.payload);
    const senders = [...new Set([controllerId, event.owner_id].filter(Boolean))];
    const placeholders = senders.map(() => '?').join(',');
    return (payload.affected ?? []).filter(person => {
      const sent = this.bus.store.get(
        `SELECT 1 FROM messages WHERE group_id=? AND sender IN (${placeholders}) AND recipient=? AND kind='send' AND created>? LIMIT 1`,
        groupId, ...senders, person.owner_id, event.created,
      );
      if (sent) return false;
      const row = this.bus.store.get('SELECT tasks FROM agent_tasks WHERE owner_id=? AND group_id=?', person.owner_id, groupId);
      const tasks = row ? JSON.parse(row.tasks) : [];
      return tasks.some(task => task.state === 'doing'
        && task.parent?.planId === event.plan_id
        && task.parent?.stepId === payload.stepId);
    });
  }
  /** 主控回合输入里的待办:仍未处置的取消。 */
  pendingCancellations(groupId) {
    const controller = this.bus.teamController(groupId);
    return this.bus.store.all(
      "SELECT id,plan_id,owner_id,payload,created FROM plan_events WHERE group_id=? AND kind='step_cancelled' ORDER BY created",
      groupId,
    ).flatMap(event => {
      const payload = JSON.parse(event.payload);
      const affected = this.unresolvedAffected(groupId, controller.id, event);
      if (!affected.length) return [];
      return [{
        id: event.id,
        planId: event.plan_id,
        stepId: payload.stepId,
        text: payload.text,
        source: payload.source,
        created: event.created,
        affected,
      }];
    });
  }
  /** 当前计划里仍影响成员的取消,供面板提示。 */
  cancelledStepsForPlan(groupId, planId, controllerId) {
    return this.bus.store.all(
      "SELECT id,plan_id,owner_id,payload,created FROM plan_events WHERE group_id=? AND plan_id=? AND kind='step_cancelled' ORDER BY created",
      groupId, planId,
    ).flatMap(event => {
      const payload = JSON.parse(event.payload);
      const affected = this.unresolvedAffected(groupId, controllerId, event);
      if (!affected.length) return [];
      return [{
        id: event.id,
        plan_id: planId,
        step_id: payload.stepId,
        text: payload.text,
        source: payload.source,
        created: event.created,
        affected,
      }];
    });
  }
  agentTasksView(groupId) {
    return teamsAgg.agentTasksForGroup(this.bus.store, groupId)
      .map(row => ({
        owner_id: row.owner_id,
        group_id: row.group_id,
        owner_kind: this.taskOwnerKind(groupId, row.owner_id),
        tasks: JSON.parse(row.tasks),
        updated: row.updated,
      }));
  }
  /** 面板的三段投影:当前计划、仍有子任务挂靠的历史计划、未挂靠的成员任务。 */
  agentTasksPlanView(groupId) {
    const ownerKind = id => this.taskOwnerKind(groupId, id);
    const current = this.currentPlan(groupId);
    const memberTasks = [];
    for (const row of teamsAgg.agentTasksForGroup(this.bus.store, groupId)) {
      if (current && row.owner_id === current.ownerId && Number(row.revision) === current.revision) continue;
      const tasks = JSON.parse(row.tasks);
      // 交接后旧主控的 live 列表若与冻结快照完全相同,不在成员区重复显示。
      if (this.isFrozenSnapshot(groupId, row.owner_id, tasks)) continue;
      memberTasks.push({
        owner_id: row.owner_id,
        group_id: row.group_id,
        owner_kind: ownerKind(row.owner_id),
        tasks,
        updated: row.updated,
      });
    }
    const referenced = new Set();
    for (const row of memberTasks) {
      for (const task of row.tasks) {
        if (task.parent) referenced.add(`${task.parent.planId}\u0000${task.parent.stepId}`);
      }
    }
    const historicalPlans = teamsAgg.planEventsForGroup(this.bus.store, groupId)
      .filter(event => event.kind === 'frozen')
      .map(event => {
        const payload = JSON.parse(event.payload);
        return {
          plan_id: event.plan_id,
          group_id: groupId,
          owner_id: event.owner_id,
          owner_kind: payload.ownerKind ?? ownerKind(event.owner_id),
          revision: event.revision,
          frozen_at: event.created,
          steps: payload.tasks ?? [],
        };
      })
      .filter(plan => plan.steps.some(step => referenced.has(`${plan.plan_id}\u0000${step.id}`)));
    const controller = this.bus.teamController(groupId);
    const revision = current?.revision ?? (controller.assignment?.revision ?? 0);
    const cancelledSteps = this.cancelledStepsForPlan(groupId, this.planIdFor(revision), controller.id);
    return {
      currentPlan: current
        ? {
            plan_id: current.planId,
            group_id: groupId,
            owner_id: current.ownerId,
            owner_kind: current.ownerKind,
            revision: current.revision,
            updated: current.updated,
            steps: current.tasks,
          }
        : null,
      historicalPlans,
      memberTasks,
      cancelledSteps,
    };
  }
  taskOwnerKind(groupId, ownerId) {
    const controller = this.bus.teamController(groupId);
    if (controller.id === ownerId) return controller.kind;
    return 'member';
  }
  isFrozenSnapshot(groupId, ownerId, tasks) {
    const row = this.bus.store.get(
      "SELECT payload FROM plan_events WHERE group_id=? AND owner_id=? AND kind='frozen' ORDER BY created DESC LIMIT 1",
      groupId, ownerId,
    );
    if (!row) return false;
    return JSON.stringify(JSON.parse(row.payload).tasks ?? []) === JSON.stringify(tasks);
  }
  /** 控制者变化前冻结当前任期的计划;没有带 id 的计划时不做任何事。 */
  freezeCurrentPlan(groupId, now = new Date().toISOString()) {
    const plan = this.currentPlan(groupId);
    if (!plan) return null;
    const id = randomUUID();
    teamsAgg.insertPlanEvent(this.bus.store, {
      id,
      groupId,
      planId: plan.planId,
      kind: 'frozen',
      ownerId: plan.ownerId,
      revision: plan.revision,
      payload: { ownerKind: plan.ownerKind, tasks: plan.tasks },
      created: now,
    });
    return id;
  }
  /** 一次性迁移:把当前控制者的旧形状任务列表提升为当前任期计划,生成 step id。 */
  migrateLegacyPlans() {
    const groups = this.bus.store.all('SELECT id FROM groups');
    this.bus.store.transaction(() => {
      for (const group of groups) {
        let controller;
        try { controller = this.bus.teamController(group.id); } catch { continue; }
        const revision = controller.assignment?.revision ?? 0;
        const row = this.bus.store.get(
          'SELECT tasks FROM agent_tasks WHERE owner_id=? AND group_id=?',
          controller.id, group.id,
        );
        if (!row) continue;
        const tasks = JSON.parse(row.tasks);
        if (!tasks.length) continue;
        if (tasks.every(task => typeof task.id === 'string' && task.id)) continue;
        const used = new Set(tasks.map(task => task.id).filter(id => typeof id === 'string' && id));
        const migrated = tasks.map((task, index) => {
          const id = typeof task.id === 'string' && task.id ? task.id : this.migratedStepId(used, index);
          used.add(id);
          return { id, text: task.text, state: task.state };
        });
        this.bus.store.run(
          'UPDATE agent_tasks SET tasks=?,revision=? WHERE owner_id=? AND group_id=?',
          JSON.stringify(migrated), revision, controller.id, group.id,
        );
      }
    });
  }
  migratedStepId(used, index) {
    let cursor = index + 1;
    let id = `step-${cursor}`;
    while (used.has(id)) id = `step-${++cursor}`;
    return id;
  }
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
        const selection = person.selection ?? this.bus.defaultModelSelection(person.host);
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
    // 归档本身就表示「这段时间不看」:恢复时把水位推到最后一条,不补课。
    readState.resetGroupToCurrent(this.bus.store, groupId);
    const agent = this.bus.panelAgent();
    if (agent) readState.resetPanelTeamToCurrent(this.bus.store, agent.id, groupId);
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
