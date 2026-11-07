import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../src/server.mjs';
import { createTestGroup } from '../support/fixture.mjs';
import { validateTool } from '../../src/tools.mjs';

async function until(fn) { for (let i = 0; i < 300; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)); } throw Error('timeout'); }
async function waitFor(fn) { for (let i = 0; i < 300; i++) { const value = fn(); if (value) return value; await new Promise(r => setTimeout(r, 5)); } throw Error('timeout'); }

function makeHost(calls = []) {
  return {
    calls,
    async listModels() { return { version: 1, host: 'fake', source: 'test', defaultModel: 'test', models: [{ id: 'test', key: 'test', reasoningEfforts: [{ id: 'low' }] }] }; },
    async run(c) {
      calls.push(c);
      c.onSession(c.endpoint.session ?? c.endpoint.id);
      if (c.endpoint.context === 'profile') { await c.onTool('profile_set', { text: 'ready' }); c.onAccepted(); return ''; }
      c.onAccepted(); return 'done';
    },
  };
}

async function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-tasks-'));
  const calls = [];
  const server = await startServer({ directory, hosts: new Map([['fake', makeHost(calls)]]) });
  t.after(async () => { await server.close(); rmSync(directory, { recursive: true, force: true }); });
  const group = createTestGroup(server.bus, {
    name: 'tasks', workspace: directory,
    lead: { name: 'Lead', host: 'fake' },
    members: [{ name: '助手', host: 'fake' }],
  });
  await until(() => !server.bus.running.size);
  const lead = server.bus.store.get("SELECT * FROM members WHERE group_id=? AND role='lead'", group.id);
  const member = server.bus.store.get("SELECT * FROM members WHERE group_id=? AND role!='lead'", group.id);
  const leadEndpoint = server.bus.store.endpoint(lead.id, 'coordination');
  return { server, group, lead, member, leadEndpoint, calls };
}

test('tasks_set writes, replaces and clears the member task list', async t => {
  const f = await setup(t);
  const first = await f.server.bus.tool(f.leadEndpoint.id, f.leadEndpoint.key, 'tasks_set', {
    tasks: [
      { id: 'step-1', text: '梳理接口设计', state: 'doing' },
      { id: 'step-2', text: '准备评审材料', state: 'doing' },
    ],
  });
  assert.ok(first.updated);
  assert.equal(first.planId, 'plan-0');
  // 用公共视图（snapshot/agentTasksView 的同一投影）断言，不直接读 agent_tasks 行。
  let entry = f.server.bus.agentTasksView(f.group.id).find(item => item.owner_id === f.lead.id);
  assert.deepEqual(entry.tasks, [
    { id: 'step-1', text: '梳理接口设计', state: 'doing' },
    { id: 'step-2', text: '准备评审材料', state: 'doing' },
  ]);

  // 整体替换:状态推进
  await f.server.bus.tool(f.leadEndpoint.id, f.leadEndpoint.key, 'tasks_set', {
    tasks: [
      { id: 'step-1', text: '梳理接口设计', state: 'done' },
      { id: 'step-2', text: '准备评审材料', state: 'dropped' },
    ],
  });
  entry = f.server.bus.agentTasksView(f.group.id).find(item => item.owner_id === f.lead.id);
  assert.deepEqual(entry.tasks.map(item => item.state), ['done', 'dropped']);

  // 空数组清空
  await f.server.bus.tool(f.leadEndpoint.id, f.leadEndpoint.key, 'tasks_set', { tasks: [] });
  assert.equal(f.server.bus.agentTasksView(f.group.id).some(item => item.owner_id === f.lead.id), false);
});

test('snapshot exposes agentTasks scoped to the group with owner kind', async t => {
  const f = await setup(t);
  await f.server.bus.tool(f.leadEndpoint.id, f.leadEndpoint.key, 'tasks_set', {
    tasks: [{ id: 'step-1', text: '成员任务', state: 'doing' }],
  });
  const snapshot = f.server.bus.snapshot(f.group.id);
  const entry = snapshot.agentTasks.find(item => item.owner_id === f.lead.id);
  assert.ok(entry);
  assert.equal(entry.owner_kind, 'member');
  assert.deepEqual(entry.tasks, [{ id: 'step-1', text: '成员任务', state: 'doing' }]);

  await f.server.bus.createPanelAgent({ name: 'Panel', host: 'fake', model: 'test', reasoning_effort: 'low' });
  const agent = f.server.bus.panelAgent();
  // Panel 接管后用协作工具写自己的任务
  const session = f.server.bus.store.panelSession(agent.id, 'private');
  const takeover = await f.server.bus.panelTool(session.id, session.key, 'request_team_takeover', { groupId: f.group.id }, { activeTeamId: f.group.id });
  f.server.bus.decideInteraction(takeover.id, { approved: true });
  await until(() => !f.server.bus.running.size);
  const coordination = f.server.bus.store.panelSession(agent.id, 'coordination', f.group.id);
  await f.server.bus.panelTool(
    coordination.id, coordination.key, 'group_tasks_set',
    { groupId: f.group.id, tasks: [{ id: 'step-1', text: '主控任务', state: 'doing' }] },
    { activeTeamId: f.group.id },
  );
  const next = f.server.bus.snapshot(f.group.id);
  const panelEntry = next.agentTasks.find(item => item.owner_id === agent.id);
  assert.ok(panelEntry);
  assert.equal(panelEntry.owner_kind, 'panel_agent');
  assert.deepEqual(panelEntry.tasks, [{ id: 'step-1', text: '主控任务', state: 'doing' }]);
  assert.ok(next.agentTasks.some(item => item.owner_id === f.lead.id), 'member tasks still listed');
});

test('panel agent keeps a separate task list per group', async t => {
  const f = await setup(t);
  await f.server.bus.createPanelAgent({ name: 'Panel', host: 'fake', model: 'test', reasoning_effort: 'low' });
  const agent = f.server.bus.panelAgent();
  const session = f.server.bus.store.panelSession(agent.id, 'private');
  const takeover = await f.server.bus.panelTool(session.id, session.key, 'request_team_takeover', { groupId: f.group.id }, { activeTeamId: f.group.id });
  f.server.bus.decideInteraction(takeover.id, { approved: true });
  await until(() => !f.server.bus.running.size);
  const coordination = f.server.bus.store.panelSession(agent.id, 'coordination', f.group.id);
  const write = tasks => f.server.bus.panelTool(
    coordination.id, coordination.key, 'group_tasks_set',
    { groupId: f.group.id, tasks },
    { activeTeamId: f.group.id },
  );
  await write([{ id: 'step-1', text: '团队一任务', state: 'doing' }]);
  // 第二个团队:主控接管后写入,不得覆盖第一个团队的任务列表
  const other = createTestGroup(f.server.bus, { name: 'tasks2', workspace: f.server.bus.store.directory, lead: { name: 'Lead2', host: 'fake' }, members: [] });
  await until(() => !f.server.bus.running.size);
  const session2 = f.server.bus.store.panelSession(agent.id, 'private');
  const takeover2 = await f.server.bus.panelTool(session2.id, session2.key, 'request_team_takeover', { groupId: other.id }, { activeTeamId: other.id });
  f.server.bus.decideInteraction(takeover2.id, { approved: true });
  await until(() => !f.server.bus.running.size);
  const coordination2 = f.server.bus.store.panelSession(agent.id, 'coordination', other.id);
  await f.server.bus.panelTool(
    coordination2.id, coordination2.key, 'group_tasks_set',
    { groupId: other.id, tasks: [{ id: 'step-1', text: '团队二任务', state: 'doing' }] },
    { activeTeamId: other.id },
  );
  const first = f.server.bus.snapshot(f.group.id).agentTasks.find(item => item.owner_id === agent.id);
  const second = f.server.bus.snapshot(other.id).agentTasks.find(item => item.owner_id === agent.id);
  assert.deepEqual(first?.tasks.map(item => item.text), ['团队一任务']);
  assert.deepEqual(second?.tasks.map(item => item.text), ['团队二任务']);
});

test('tasks_set validates shape, states and limits', async t => {
  const f = await setup(t);
  const normalize = tasks => f.server.bus.normalizeAgentTasks(tasks);
  const normalizePlan = tasks => f.server.bus.normalizeAgentTasks(tasks, { plan: true });
  assert.throws(() => normalize('不是数组'), /数组/);
  assert.throws(() => normalize([{ text: '缺少状态' }]), /状态/);
  assert.throws(() => normalize([{ text: '非法状态', state: 'blocked' }]), /状态/);
  assert.throws(() => normalize([{ text: '', state: 'doing' }]), /文本/);
  assert.throws(() => normalize([{ text: 'x'.repeat(501), state: 'doing' }]), /文本/);
  assert.throws(() => normalize(Array.from({ length: 21 }, () => ({ text: '任务', state: 'doing' }))), /20/);
  // 计划步骤的身份与父引用
  assert.deepEqual(
    normalizePlan([{ id: 'step-1', text: '计划', state: 'doing' }]),
    [{ id: 'step-1', text: '计划', state: 'doing' }],
  );
  assert.throws(() => normalizePlan([{ text: '缺 id', state: 'doing' }]), /id/);
  assert.throws(() => normalizePlan([{ id: 'Step_1', text: '非法 id', state: 'doing' }]), /id/);
  assert.throws(() => normalizePlan([
    { id: 'step-1', text: 'a', state: 'doing' },
    { id: 'step-1', text: 'b', state: 'doing' },
  ]), /重复/);
  assert.throws(() => normalizePlan([
    { id: 'step-1', text: 'a', state: 'doing', parent: { planId: 'plan-0', stepId: 'step-1' } },
  ]), /parent/);
  assert.deepEqual(
    normalize([{ text: '子任务', state: 'doing', parent: { planId: 'plan-0', stepId: 'step-1' } }]),
    [{ text: '子任务', state: 'doing', parent: { planId: 'plan-0', stepId: 'step-1' } }],
  );
  assert.throws(() => normalize([{ id: 'step-1', text: '成员任务', state: 'doing' }]), /不需要 id/);
  assert.throws(() => normalize([{ text: 'x', state: 'doing', parent: { planId: 'bad', stepId: 'step-1' } }]), /planId/);
  // 工具层先于总线校验拦截畸形参数
  const call = tasks => f.server.bus.tool(f.leadEndpoint.id, f.leadEndpoint.key, 'tasks_set', { tasks });
  await assert.rejects(() => call('不是数组'), /tasks类型无效/);
  await assert.rejects(() => call([{ text: '任务', state: 'blocked' }]), /必须是以下值之一/);
});

test('plan identity, parent warnings and step_ref validation', async t => {
  const f = await setup(t);
  const plan = await f.server.bus.tool(f.leadEndpoint.id, f.leadEndpoint.key, 'tasks_set', {
    tasks: [{ id: 'step-1', text: '计划一', state: 'doing' }],
  });
  assert.equal(plan.planId, 'plan-0');
  const current = f.server.bus.currentPlan(f.group.id);
  assert.equal(current.planId, 'plan-0');
  assert.deepEqual(current.tasks.map(task => task.id), ['step-1']);

  const memberEndpoint = f.server.bus.store.endpoint(f.member.id, 'coordination');
  const withParent = await f.server.bus.tool(memberEndpoint.id, memberEndpoint.key, 'tasks_set', {
    tasks: [{ text: '执行步骤一', state: 'doing', parent: { planId: 'plan-0', stepId: 'step-1' } }],
  });
  assert.equal(withParent.warnings, undefined);

  await assert.rejects(() => f.server.bus.tool(memberEndpoint.id, memberEndpoint.key, 'tasks_set', {
    tasks: [{ text: '错误挂靠', state: 'doing', parent: { planId: 'plan-99', stepId: 'step-1' } }],
  }), /parent\.planId 不存在/);

  await assert.rejects(() => f.server.bus.tool(memberEndpoint.id, memberEndpoint.key, 'send', {
    to: f.lead.name, text: '派工', step_ref: { planId: 'plan-0', stepId: 'step-1' },
  }), /只有当前主控/);

  const sent = await f.server.bus.tool(f.leadEndpoint.id, f.leadEndpoint.key, 'send', {
    to: f.member.name, text: '请执行步骤一', step_ref: { planId: 'plan-0', stepId: 'step-1' },
  });
  assert.ok(sent.messageId);
  const ref = f.server.bus.store.get('SELECT plan_id,step_id FROM message_step_refs WHERE message_id=?', sent.messageId);
  assert.equal(ref.plan_id, 'plan-0');
  assert.equal(ref.step_id, 'step-1');
});

test('tasks_set is available to every member context except private and profile', () => {
  const valid = { tasks: [{ text: '任务', state: 'doing' }] };
  for (const role of ['lead', 'member']) {
    assert.ok(validateTool(role, 'tasks_set', valid, 'coordination'));
    assert.ok(validateTool(role, 'tasks_set', valid, 'pair:someone'));
    assert.throws(() => validateTool(role, 'tasks_set', valid, 'private'), /不可使用/);
    assert.throws(() => validateTool(role, 'tasks_set', valid, 'profile'), /不可使用/);
  }
  assert.throws(() => validateTool('member', 'tasks_set', { tasks: [{ text: 'x', state: 'blocked' }] }, 'coordination'), /必须是以下值之一/);
  assert.doesNotThrow(() => validateTool('member', 'tasks_set', { tasks: [] }, 'coordination'));
});

test('turn input carries plan, task budget and step_ref', async t => {
  const f = await setup(t);
  await f.server.bus.tool(f.leadEndpoint.id, f.leadEndpoint.key, 'tasks_set', {
    tasks: [{ id: 'step-1', text: '计划一', state: 'doing' }],
  });
  const memberEndpoint = f.server.bus.store.endpoint(f.member.id, 'coordination');
  await f.server.bus.tool(f.leadEndpoint.id, f.leadEndpoint.key, 'send', {
    to: f.member.name, text: '请执行步骤一', step_ref: { planId: 'plan-0', stepId: 'step-1' },
  });
  const memberInput = await waitFor(() => f.calls
    .filter(c => c.endpoint.member_id === f.member.id && c.endpoint.context !== 'profile')
    .map(c => JSON.parse(c.prompt))
    .find(input => input.input?.message?.stepRef));
  assert.ok(memberInput);
  assert.equal(memberInput.input.message.stepRef.planId, 'plan-0');
  assert.equal(memberInput.input.message.stepRef.stepId, 'step-1');
  assert.equal(memberInput.taskBudget.limit, 20);

  await f.server.bus.tool(memberEndpoint.id, memberEndpoint.key, 'send', { to: f.lead.name, text: '汇报' });
  const leadInput = await waitFor(() => f.calls
    .filter(c => c.endpoint.member_id === f.lead.id && c.endpoint.context === 'coordination')
    .map(c => JSON.parse(c.prompt))
    .find(input => input.plan));
  assert.ok(leadInput);
  assert.equal(leadInput.plan.planId, 'plan-0');
  assert.deepEqual(leadInput.plan.steps.map(step => step.id), ['step-1']);
  assert.equal(leadInput.plan.limit, 20);
});

test('takeover freezes the plan, handback starts a new tenure', async t => {
  const f = await setup(t);
  await f.server.bus.tool(f.leadEndpoint.id, f.leadEndpoint.key, 'tasks_set', {
    tasks: [{ id: 'step-1', text: '计划一', state: 'doing' }],
  });
  const memberEndpoint = f.server.bus.store.endpoint(f.member.id, 'coordination');
  await f.server.bus.tool(memberEndpoint.id, memberEndpoint.key, 'tasks_set', {
    tasks: [{ text: '执行步骤一', state: 'doing', parent: { planId: 'plan-0', stepId: 'step-1' } }],
  });

  await f.server.bus.createPanelAgent({ name: 'Panel', host: 'fake', model: 'test', reasoning_effort: 'low' });
  const agent = f.server.bus.panelAgent();
  const session = f.server.bus.store.panelSession(agent.id, 'private');
  const takeover = await f.server.bus.panelTool(session.id, session.key, 'request_team_takeover', { groupId: f.group.id }, { activeTeamId: f.group.id });
  f.server.bus.decideInteraction(takeover.id, { approved: true });
  await until(() => !f.server.bus.running.size);

  const afterTakeover = f.server.bus.agentTasksPlanView(f.group.id);
  assert.equal(afterTakeover.currentPlan, null);
  assert.equal(afterTakeover.historicalPlans.length, 1);
  assert.equal(afterTakeover.historicalPlans[0].plan_id, 'plan-0');
  assert.deepEqual(afterTakeover.historicalPlans[0].steps.map(step => step.id), ['step-1']);
  assert.ok(afterTakeover.memberTasks.some(row => row.owner_id === f.member.id));
  // 旧主控的 live 列表与冻结快照相同,不在成员区重复显示。
  assert.equal(afterTakeover.memberTasks.some(row => row.owner_id === f.lead.id), false);

  const coordination = f.server.bus.store.panelSession(agent.id, 'coordination', f.group.id);
  await f.server.bus.panelTool(coordination.id, coordination.key, 'group_tasks_set', {
    groupId: f.group.id,
    tasks: [{ id: 'step-1', text: '接管后计划', state: 'doing' }],
  }, { activeTeamId: f.group.id });
  const withPanelPlan = f.server.bus.agentTasksPlanView(f.group.id);
  assert.equal(withPanelPlan.currentPlan.plan_id, 'plan-1');
  assert.deepEqual(withPanelPlan.currentPlan.steps.map(step => step.id), ['step-1']);
  assert.equal(withPanelPlan.historicalPlans.length, 1);

  const handback = await f.server.bus.panelTool(session.id, session.key, 'request_team_handback', { groupId: f.group.id }, { activeTeamId: f.group.id });
  f.server.bus.decideInteraction(handback.id, { approved: true });
  await until(() => !f.server.bus.running.size);
  const afterHandback = f.server.bus.agentTasksPlanView(f.group.id);
  assert.equal(afterHandback.currentPlan, null);
  // plan-0 仍有子任务挂靠,保留;plan-1 没有子任务,不渲染。
  assert.ok(afterHandback.historicalPlans.some(plan => plan.plan_id === 'plan-0'));
  assert.equal(afterHandback.historicalPlans.some(plan => plan.plan_id === 'plan-1'), false);
});

test('cancelling a step records impact and pending until the controller notifies', async t => {
  const f = await setup(t);
  await f.server.bus.tool(f.leadEndpoint.id, f.leadEndpoint.key, 'tasks_set', {
    tasks: [
      { id: 'step-1', text: '计划一', state: 'doing' },
      { id: 'step-2', text: '计划二', state: 'doing' },
    ],
  });
  const memberEndpoint = f.server.bus.store.endpoint(f.member.id, 'coordination');
  await f.server.bus.tool(memberEndpoint.id, memberEndpoint.key, 'tasks_set', {
    tasks: [{ text: '执行一', state: 'doing', parent: { planId: 'plan-0', stepId: 'step-1' } }],
  });

  const cancelled = await f.server.bus.tool(f.leadEndpoint.id, f.leadEndpoint.key, 'tasks_set', {
    tasks: [{ id: 'step-2', text: '计划二', state: 'doing' }],
  });
  assert.equal(cancelled.cancellations.length, 1);
  assert.equal(cancelled.cancellations[0].stepId, 'step-1');
  assert.equal(cancelled.cancellations[0].source, 'removed');
  assert.deepEqual(cancelled.cancellations[0].affected.map(person => person.owner_id), [f.member.id]);
  assert.equal(f.server.bus.pendingCancellations(f.group.id).length, 1);
  assert.equal(f.server.bus.agentTasksPlanView(f.group.id).cancelledSteps.length, 1);

  // 已取消的 stepId 不能在同一个计划里复用。
  await assert.rejects(() => f.server.bus.tool(f.leadEndpoint.id, f.leadEndpoint.key, 'tasks_set', {
    tasks: [{ id: 'step-1', text: '复用', state: 'doing' }],
  }), /已被使用/);

  // 主控通知受影响成员后,待办与面板提示解除;成员任务仍保持 doing。
  await new Promise(resolve => setTimeout(resolve, 5));
  await f.server.bus.tool(f.leadEndpoint.id, f.leadEndpoint.key, 'send', {
    to: f.member.name, text: '步骤一取消，请调整',
  });
  assert.equal(f.server.bus.pendingCancellations(f.group.id).length, 0);
  assert.equal(f.server.bus.agentTasksPlanView(f.group.id).cancelledSteps.length, 0);
});

test('member_stop is only available to the lead', () => {
  assert.doesNotThrow(() => validateTool('lead', 'member_stop', { to: 'someone' }, 'coordination'));
  assert.throws(() => validateTool('member', 'member_stop', { to: 'someone' }, 'coordination'), /不可使用/);
});

test('legacy controller lists are promoted once and stale plans are not restored', async t => {
  const f = await setup(t);
  const now = new Date().toISOString();
  f.server.bus.store.run(
    'INSERT INTO agent_tasks(owner_id,group_id,tasks,updated,revision) VALUES(?,?,?,?,0)',
    f.lead.id, f.group.id, JSON.stringify([
      { text: '旧计划一', state: 'doing' },
      { text: '旧计划二', state: 'done' },
    ]), now,
  );
  f.server.bus.lifecycle.migrateLegacyPlans();
  let view = f.server.bus.agentTasksPlanView(f.group.id);
  assert.equal(view.currentPlan.plan_id, 'plan-0');
  assert.deepEqual(
    view.currentPlan.steps.map(step => [step.id, step.text]),
    [['step-1', '旧计划一'], ['step-2', '旧计划二']],
  );

  // 幂等:再次迁移不会重新生成 id。
  f.server.bus.lifecycle.migrateLegacyPlans();
  view = f.server.bus.agentTasksPlanView(f.group.id);
  assert.deepEqual(view.currentPlan.steps.map(step => step.id), ['step-1', 'step-2']);

  // 已有 id 但 revision 落后的列表属于旧任期,迁移不得把它恢复成当前计划。
  f.server.bus.store.run(
    "INSERT INTO team_lead_controllers(group_id,controller_kind,controller_id,state,original_lead_id,revision,updated) VALUES(?,'member',?,'active',NULL,2,?)",
    f.group.id, f.lead.id, now,
  );
  f.server.bus.lifecycle.migrateLegacyPlans();
  const after = f.server.bus.agentTasksPlanView(f.group.id);
  assert.equal(after.currentPlan, null);
  const row = f.server.bus.store.get('SELECT revision FROM agent_tasks WHERE owner_id=? AND group_id=?', f.lead.id, f.group.id);
  assert.equal(row.revision, 0);
});
