import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.mjs';
import { confirmedGroup } from './helpers.mjs';
import { validateTool } from '../src/tools.mjs';

async function until(fn) { for (let i = 0; i < 300; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)); } throw Error('timeout'); }

function makeHost() {
  return {
    async listModels() { return { version: 1, host: 'fake', source: 'test', defaultModel: 'test', models: [{ id: 'test', key: 'test', reasoningEfforts: [{ id: 'low' }] }] }; },
    async run(c) {
      c.onSession(c.endpoint.session ?? c.endpoint.id);
      if (c.endpoint.context === 'profile') { await c.onTool('profile_set', { text: 'ready' }); c.onAccepted(); return ''; }
      c.onAccepted(); return 'done';
    },
  };
}

async function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-tasks-'));
  const server = await startServer({ directory, hosts: new Map([['fake', makeHost()]]) });
  t.after(async () => { await server.close(); rmSync(directory, { recursive: true, force: true }); });
  const group = confirmedGroup(server.bus, {
    name: 'tasks', workspace: directory,
    lead: { name: 'Lead', host: 'fake' },
    members: [{ name: '助手', host: 'fake' }],
  });
  await until(() => !server.bus.running.size);
  const lead = server.bus.store.get("SELECT * FROM members WHERE group_id=? AND role='lead'", group.id);
  const member = server.bus.store.get("SELECT * FROM members WHERE group_id=? AND role!='lead'", group.id);
  const leadEndpoint = server.bus.store.endpoint(lead.id, 'coordination');
  return { server, group, lead, member, leadEndpoint };
}

test('tasks_set writes, replaces and clears the member task list', async t => {
  const f = await setup(t);
  const first = await f.server.bus.tool(f.leadEndpoint.id, f.leadEndpoint.key, 'tasks_set', {
    tasks: [
      { text: '梳理接口设计', state: 'doing' },
      { text: '准备评审材料', state: 'doing' },
    ],
  });
  assert.ok(first.updated);
  let row = f.server.bus.store.get('SELECT * FROM agent_tasks WHERE owner_id=?', f.lead.id);
  assert.deepEqual(JSON.parse(row.tasks), [
    { text: '梳理接口设计', state: 'doing' },
    { text: '准备评审材料', state: 'doing' },
  ]);

  // 整体替换:状态推进
  await f.server.bus.tool(f.leadEndpoint.id, f.leadEndpoint.key, 'tasks_set', {
    tasks: [
      { text: '梳理接口设计', state: 'done' },
      { text: '准备评审材料', state: 'dropped' },
    ],
  });
  row = f.server.bus.store.get('SELECT * FROM agent_tasks WHERE owner_id=?', f.lead.id);
  assert.deepEqual(JSON.parse(row.tasks).map(item => item.state), ['done', 'dropped']);

  // 空数组清空
  await f.server.bus.tool(f.leadEndpoint.id, f.leadEndpoint.key, 'tasks_set', { tasks: [] });
  assert.ok(!f.server.bus.store.get('SELECT * FROM agent_tasks WHERE owner_id=?', f.lead.id));
});

test('snapshot exposes agentTasks scoped to the group with owner kind', async t => {
  const f = await setup(t);
  await f.server.bus.tool(f.leadEndpoint.id, f.leadEndpoint.key, 'tasks_set', {
    tasks: [{ text: '成员任务', state: 'doing' }],
  });
  const snapshot = f.server.bus.snapshot(f.group.id);
  const entry = snapshot.agentTasks.find(item => item.owner_id === f.lead.id);
  assert.ok(entry);
  assert.equal(entry.owner_kind, 'member');
  assert.deepEqual(entry.tasks, [{ text: '成员任务', state: 'doing' }]);

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
    { groupId: f.group.id, tasks: [{ text: '主控任务', state: 'doing' }] },
    { activeTeamId: f.group.id },
  );
  const next = f.server.bus.snapshot(f.group.id);
  const panelEntry = next.agentTasks.find(item => item.owner_id === agent.id);
  assert.ok(panelEntry);
  assert.equal(panelEntry.owner_kind, 'panel_agent');
  assert.deepEqual(panelEntry.tasks, [{ text: '主控任务', state: 'doing' }]);
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
  await write([{ text: '团队一任务', state: 'doing' }]);
  // 第二个团队:主控接管后写入,不得覆盖第一个团队的任务列表
  const other = confirmedGroup(f.server.bus, { name: 'tasks2', workspace: f.server.bus.store.directory, lead: { name: 'Lead2', host: 'fake' }, members: [] });
  await until(() => !f.server.bus.running.size);
  const session2 = f.server.bus.store.panelSession(agent.id, 'private');
  const takeover2 = await f.server.bus.panelTool(session2.id, session2.key, 'request_team_takeover', { groupId: other.id }, { activeTeamId: other.id });
  f.server.bus.decideInteraction(takeover2.id, { approved: true });
  await until(() => !f.server.bus.running.size);
  const coordination2 = f.server.bus.store.panelSession(agent.id, 'coordination', other.id);
  await f.server.bus.panelTool(
    coordination2.id, coordination2.key, 'group_tasks_set',
    { groupId: other.id, tasks: [{ text: '团队二任务', state: 'doing' }] },
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
  assert.throws(() => normalize('不是数组'), /数组/);
  assert.throws(() => normalize([{ text: '缺少状态' }]), /状态/);
  assert.throws(() => normalize([{ text: '非法状态', state: 'blocked' }]), /状态/);
  assert.throws(() => normalize([{ text: '', state: 'doing' }]), /文本/);
  assert.throws(() => normalize([{ text: 'x'.repeat(501), state: 'doing' }]), /文本/);
  assert.throws(() => normalize(Array.from({ length: 21 }, () => ({ text: '任务', state: 'doing' }))), /20/);
  // 工具层先于总线校验拦截畸形参数
  const call = tasks => f.server.bus.tool(f.leadEndpoint.id, f.leadEndpoint.key, 'tasks_set', { tasks });
  await assert.rejects(() => call('不是数组'), /无效列表/);
  await assert.rejects(() => call([{ text: '任务', state: 'blocked' }]), /无效列表项/);
});

test('tasks_set is available to every member context except private and profile', () => {
  const valid = { tasks: [{ text: '任务', state: 'doing' }] };
  for (const role of ['lead', 'member']) {
    assert.ok(validateTool(role, 'tasks_set', valid, 'coordination'));
    assert.ok(validateTool(role, 'tasks_set', valid, 'pair:someone'));
    assert.throws(() => validateTool(role, 'tasks_set', valid, 'private'), /不可使用/);
    assert.throws(() => validateTool(role, 'tasks_set', valid, 'profile'), /不可使用/);
  }
  assert.throws(() => validateTool('member', 'tasks_set', { tasks: [{ text: 'x', state: 'blocked' }] }, 'coordination'), /无效列表项/);
  assert.doesNotThrow(() => validateTool('member', 'tasks_set', { tasks: [] }, 'coordination'));
});
