import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.mjs';
import { confirmedGroup } from './helpers.mjs';
import { validateTool } from '../src/tools.mjs';

async function until(fn) { for (let i = 0; i < 300; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)); } throw Error('timeout'); }

function makeHost(script) {
  return {
    async listModels() { return { version: 1, host: 'fake', source: 'test', defaultModel: 'test', models: [{ id: 'test', key: 'test', reasoningEfforts: [{ id: 'low' }] }] }; },
    async run(c) {
      c.onSession(c.endpoint.session ?? c.endpoint.id);
      if (c.endpoint.context === 'profile') { await c.onTool('profile_set', { text: 'ready' }); c.onAccepted(); return ''; }
      return script(c);
    },
  };
}

async function setup(t, script, { members = [] } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'interactions-'));
  const calls = [];
  const host = makeHost(async c => { calls.push(c); return script(c); });
  const server = await startServer({ directory, hosts: new Map([['fake', host]]) });
  t.after(async () => { await server.close(); rmSync(directory, { recursive: true, force: true }); });
  const group = confirmedGroup(server.bus, { name: 'interactions', workspace: directory, lead: { name: 'Lead', host: 'fake' }, members });
  await until(() => !server.bus.running.size);
  const memberRow = server.bus.store.get("SELECT * FROM members WHERE group_id=? AND role!='lead'", group.id);
  return { server, group, calls, lead: group.lead, member: memberRow };
}

test('ask tool is available to every member context except private and profile', () => {
  for (const role of ['lead', 'member']) {
    assert.ok(validateTool(role, 'ask', { kind: 'input', text: '需要什么' }, 'coordination'));
    assert.ok(validateTool(role, 'ask', { kind: 'choice', text: '确认？', options: ['同意', '拒绝'] }, 'pair:someone'));
    assert.throws(() => validateTool(role, 'ask', { kind: 'input', text: 'x' }, 'private'), /不可使用/);
    assert.throws(() => validateTool(role, 'ask', { kind: 'input', text: 'x' }, 'profile'), /不可使用/);
  }
  assert.throws(() => validateTool('member', 'ask', { kind: 'choice', text: 'x', options: ['只有一个'] }, 'coordination'), /无效列表/);
  assert.throws(() => validateTool('member', 'ask', { kind: 'choice', text: 'x', options: ['同意', '同意'] }, 'coordination'), /重复/);
  // options 与 kind 的配对约束在 Bus 层执行：choice 缺 options 时 validateTool 放行、executeTool 拒绝。
  assert.doesNotThrow(() => validateTool('member', 'ask', { kind: 'choice', text: 'x' }, 'coordination'));
});

test('lead ask records a pending interaction and the answer wakes coordination with the choice', async t => {
  let phase = 'ask';
  const f = await setup(t, async c => {
    if (phase === 'ask') { phase = 'done'; await c.onTool('ask', { kind: 'choice', text: '是否继续部署？', options: ['同意', '拒绝'] }); c.onAccepted(); return 'asked'; }
    c.onAccepted(); return 'done';
  });
  f.server.bus.directive(f.group.id, '开始部署');
  await until(() => f.server.bus.store.get("SELECT * FROM interactions WHERE group_id=?", f.group.id));
  const row = f.server.bus.store.get("SELECT * FROM interactions WHERE group_id=?", f.group.id);
  assert.equal(row.kind, 'choice');
  assert.equal(row.state, 'pending');
  const payload = JSON.parse(row.payload);
  assert.equal(payload.kind, 'choice');
  assert.equal(payload.options.join(','), '同意,拒绝');
  const request = f.server.bus.store.get('SELECT * FROM messages WHERE id=?', row.message_id);
  assert.equal(request.sender, f.lead);
  assert.equal(request.recipient, 'user');

  assert.throws(() => f.server.bus.decideInteraction(row.id, { selected: '不支持' }), /选项/);
  assert.throws(() => f.server.bus.decideInteraction(row.id, {}), /选项/);
  const answered = f.server.bus.decideInteraction(row.id, { selected: '同意' });
  assert.equal(answered.state, 'answered');
  assert.deepEqual(answered.answer, { selected: '同意' });
  assert.throws(() => f.server.bus.decideInteraction(row.id, { selected: '同意' }), /已经结束/);

  await until(() => f.calls.length === 2 && !f.server.bus.running.size);
  assert.ok(f.calls[1].prompt.includes('用户选择:同意'));
  const answerMessage = f.server.bus.store.get('SELECT * FROM messages WHERE id=?', answered.answer_message_id);
  assert.equal(answerMessage.sender, 'user');
  assert.equal(answerMessage.recipient, f.lead);
  assert.equal(answerMessage.reply_to, row.message_id);

  const list = await (await fetch(new URL(`/api/interactions?group=${f.group.id}`, f.server.url))).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].state, 'answered');
});

test('member ask creates the pair:user session and the HTTP answer delivers into it', async t => {
  let phase = 'send';
  let asked = false;
  const f = await setup(t, async c => {
    if (c.endpoint.context === 'coordination' && phase === 'send') {
      phase = 'wait';
      await c.onTool('send', { to: '助手', text: '请准备部署' });
      c.onAccepted(); return 'sent';
    }
    if (c.endpoint.member_id === f.member.id && c.endpoint.context.startsWith('pair:') && !asked) {
      asked = true;
      await c.onTool('ask', { kind: 'input', text: '请提供部署路径' });
      c.onAccepted(); return 'asked';
    }
    c.onAccepted(); return 'done';
  }, { members: [{ name: '助手', host: 'fake' }] });
  assert.ok(f.member, 'member exists');
  f.server.bus.directive(f.group.id, '部署新版本');
  await until(() => f.server.bus.store.get("SELECT * FROM interactions WHERE member_id=?", f.member.id));
  const row = f.server.bus.store.get("SELECT * FROM interactions WHERE member_id=?", f.member.id);
  assert.equal(row.kind, 'input');
  assert.equal(row.state, 'pending');
  // 互动记录发起会话（pair:<lead>）；ask 同时为成员建立 pair:user 会话供答复投递。
  assert.equal(row.context.startsWith('pair:'), true);
  const userEndpoint = f.server.bus.store.get("SELECT * FROM endpoints WHERE member_id=? AND context='pair:user'", f.member.id);
  assert.ok(userEndpoint, 'pair:user endpoint created with the ask');

  const bad = await fetch(new URL(`/api/interactions/${row.id}/answer`, f.server.url), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer: {} }),
  });
  assert.equal(bad.status, 400);
  const good = await fetch(new URL(`/api/interactions/${row.id}/answer`, f.server.url), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer: { value: '/srv/app' } }),
  });
  assert.equal(good.status, 200);
  const answered = await good.json();
  assert.equal(answered.state, 'answered');
  const answerMessage = f.server.bus.store.get('SELECT * FROM messages WHERE id=?', answered.answer_message_id);
  assert.equal(answerMessage.sender, 'user');
  assert.equal(answerMessage.recipient, f.member.id);

  await until(() => f.calls.length === 3 && !f.server.bus.running.size);
  const memberTurns = f.calls.filter(c => c.endpoint.member_id === f.member.id);
  assert.equal(memberTurns.length, 2);
  assert.ok(memberTurns[1].prompt.includes('用户填写'));
  assert.ok(memberTurns[1].prompt.includes('/srv/app'));
  assert.equal(memberTurns[1].endpoint.context, 'pair:user');
});

test('removing a member cancels its pending interactions', async t => {
  let phase = 'send';
  let asked = false;
  const f = await setup(t, async c => {
    if (c.endpoint.context === 'coordination' && phase === 'send') {
      phase = 'wait';
      await c.onTool('send', { to: '助手', text: '请准备' });
      c.onAccepted(); return 'sent';
    }
    if (c.endpoint.member_id === f.member.id && c.endpoint.context.startsWith('pair:') && !asked) {
      asked = true;
      await c.onTool('ask', { kind: 'choice', text: '用哪个方案？', options: ['A', 'B'] });
      c.onAccepted(); return 'asked';
    }
    c.onAccepted(); return 'done';
  }, { members: [{ name: '助手', host: 'fake' }] });
  f.server.bus.directive(f.group.id, '开始');
  await until(() => f.server.bus.store.get("SELECT * FROM interactions WHERE member_id=?", f.member.id));
  await f.server.bus.removeMember(f.group.id, f.member.id);
  const row = f.server.bus.store.get("SELECT * FROM interactions WHERE member_id=?", f.member.id);
  assert.equal(row.state, 'cancelled');
});

test('panel agent ask in private chat creates a card and the answer wakes its private turn', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'panel-ask-'));
  const calls = [];
  const host = {
    async listModels() { return { version: 1, host: 'fake', source: 'test', defaultModel: 'test', models: [{ id: 'test', key: 'test', reasoningEfforts: [{ id: 'low' }] }] }; },
    async run(c) {
      calls.push(c);
      c.onSession(c.endpoint.session ?? c.endpoint.id);
      c.onAccepted();
      return 'done';
    },
  };
  const server = await startServer({ directory, hosts: new Map([['fake', host]]) });
  t.after(async () => { await server.close(); rmSync(directory, { recursive: true, force: true }); });
  await server.bus.createPanelAgent({ name: 'Panel', host: 'fake', model: 'test', reasoning_effort: 'low' });
  const agent = server.bus.panelAgent();
  const session = server.bus.store.panelSession(agent.id, 'private');

  const result = await server.bus.panelTool(
    session.id, session.key, 'ask',
    { kind: 'choice', text: '是否创建新团队？', options: ['创建', '先不'] },
    { activeTeamId: null },
  );
  assert.equal(result.state, 'pending');
  const row = server.bus.store.interaction(result.interaction);
  assert.equal(row.panel_agent_id, agent.id);
  assert.equal(row.member_id, null);
  assert.ok(row.panel_message_id, 'private ask anchors to a panel message');
  assert.equal(JSON.parse(row.payload).kind, 'choice');

  const answered = server.bus.decideInteraction(row.id, { selected: '创建' });
  assert.equal(answered.state, 'answered');
  assert.equal(answered.message_id, row.panel_message_id);
  await until(() => calls.some(c => c.endpoint.context === 'panel-private' && String(c.prompt).includes('用户选择:创建')));
  const userMessage = server.bus.store.get(
    "SELECT * FROM panel_messages WHERE panel_agent_id=? AND role='user' ORDER BY seq DESC LIMIT 1",
    agent.id,
  );
  assert.ok(userMessage.text.includes('用户选择:创建'));
});

test('group_add becomes an interaction card and approval performs the add', async t => {
  let addCount = 0;
  const f = await setup(t, async c => {
    if (c.endpoint.context === 'coordination' && addCount < 2) {
      addCount += 1;
      await c.onTool('group_add', { name: '新成员', host: 'fake' });
      c.onAccepted(); return 'requested';
    }
    c.onAccepted(); return 'done';
  }, { members: [{ name: '助手', host: 'fake' }] });
  f.server.bus.directive(f.group.id, '加一个人');
  await until(() => f.server.bus.store.get("SELECT * FROM interactions WHERE group_id=? AND kind='group_add'", f.group.id));
  const row = f.server.bus.store.get("SELECT * FROM interactions WHERE group_id=? AND kind='group_add'", f.group.id);
  assert.equal(row.state, 'pending');
  assert.equal(f.server.bus.store.get("SELECT COUNT(*) n FROM members WHERE group_id=? AND name='新成员'", f.group.id).n, 0);

  // 拒绝 → 不加入,结果回送
  const rejected = f.server.bus.decideInteraction(row.id, { approved: false });
  assert.equal(rejected.state, 'answered');
  assert.equal(f.server.bus.store.get("SELECT COUNT(*) n FROM members WHERE group_id=? AND name='新成员'", f.group.id).n, 0);
  await until(() => f.server.bus.store.get("SELECT 1 FROM messages WHERE group_id=? AND text LIKE '%用户已拒绝%'", f.group.id));

  // 再次请求 → 新卡;同意 → 成员加入
  await f.server.bus.directive(f.group.id, '再加一次');
  await until(() => {
    const rows = f.server.bus.store.all("SELECT * FROM interactions WHERE group_id=? AND kind='group_add' AND state='pending'", f.group.id);
    return rows.length === 1;
  });
  const second = f.server.bus.store.get("SELECT * FROM interactions WHERE group_id=? AND kind='group_add' AND state='pending'", f.group.id);
  const approved = f.server.bus.decideInteraction(second.id, { approved: true });
  assert.equal(approved.state, 'answered');
  assert.equal(f.server.bus.store.get("SELECT COUNT(*) n FROM members WHERE group_id=? AND name='新成员' AND removed IS NULL", f.group.id).n, 1);
  await until(() => f.server.bus.store.get("SELECT 1 FROM messages WHERE group_id=? AND text LIKE '%已生效%'", f.group.id));
});

test('takeover and handback requests become interaction cards and decide control', async t => {
  const f = await setup(t, async c => { c.onAccepted(); return 'done'; }, { members: [{ name: '助手', host: 'fake' }] });
  await f.server.bus.createPanelAgent({ name: 'Panel', host: 'fake', model: 'test', reasoning_effort: 'low' });
  const agent = f.server.bus.panelAgent();
  const session = f.server.bus.store.panelSession(agent.id, 'private');

  const request = await f.server.bus.panelTool(
    session.id, session.key, 'request_team_takeover', { groupId: f.group.id }, { activeTeamId: f.group.id },
  );
  assert.equal(request.kind, 'takeover');
  assert.equal(request.state, 'pending');
  // 幂等:同版本重复请求复用同一张卡
  const again = await f.server.bus.panelTool(
    session.id, session.key, 'request_team_takeover', { groupId: f.group.id }, { activeTeamId: f.group.id },
  );
  assert.equal(again.id, request.id);

  const approved = f.server.bus.decideInteraction(request.id, { approved: true });
  assert.equal(approved.state, 'answered');
  assert.equal(approved.answer.approved, true);
  assert.equal(f.server.bus.controllerState(f.group.id).controller.kind, 'panel_agent');
  assert.equal(f.server.bus.panelTeamRelation(f.group.id), 'main');
  // 等接管结果通知的私人回合结束,否则控制者切换守卫会拒绝后续交还
  await until(() => !f.server.bus.running.size);

  // 拒绝交还 → 主控保持不变
  const handback = await f.server.bus.panelTool(
    session.id, session.key, 'request_team_handback', { groupId: f.group.id }, { activeTeamId: f.group.id },
  );
  const rejected = f.server.bus.decideInteraction(handback.id, { approved: false });
  assert.equal(rejected.state, 'answered');
  assert.equal(rejected.answer.approved, false);
  assert.equal(f.server.bus.controllerState(f.group.id).controller.kind, 'panel_agent');
  assert.equal(f.server.bus.panelTeamRelation(f.group.id), 'main');
  await until(() => !f.server.bus.running.size);

  // 同意交还 → 回到成员主控
  const handbackAgain = await f.server.bus.panelTool(
    session.id, session.key, 'request_team_handback', { groupId: f.group.id }, { activeTeamId: f.group.id },
  );
  const returned = f.server.bus.decideInteraction(handbackAgain.id, { approved: true });
  assert.equal(returned.state, 'answered');
  assert.equal(f.server.bus.controllerState(f.group.id).controller.kind, 'member');
  assert.equal(f.server.bus.panelTeamRelation(f.group.id), 'observer');
});
