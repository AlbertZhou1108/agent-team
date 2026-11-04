import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from '../../src/server.mjs';
import { Bus } from '../../src/bus.mjs';
import { Store } from '../../src/store.mjs';
import { createTestGroup } from '../support/fixture.mjs';
import { validateTool } from '../../src/tools.mjs';

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
  const group = createTestGroup(server.bus, { name: 'interactions', workspace: directory, lead: { name: 'Lead', host: 'fake' }, members });
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
  assert.throws(() => validateTool('member', 'ask', { kind: 'choice', text: 'x', options: ['只有一个'] }, 'coordination'), /至少需要2项/);
  assert.throws(() => validateTool('member', 'ask', { kind: 'choice', text: 'x', options: ['同意', '同意'] }, 'coordination'), /存在重复项/);
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
  const userEndpoint = f.server.bus.store.get("SELECT * FROM conversations WHERE member_id=? AND context='pair:user'", f.member.id);
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

function panelAnswerHost(calls, { busyGate = null, failText = null, dieText = null } = {}) {
  return {
    async listModels() { return { version: 1, host: 'fake', source: 'test', defaultModel: 'test', models: [{ id: 'test', key: 'test', reasoningEfforts: [{ id: 'low' }] }] }; },
    async run(c) {
      calls.push(c);
      c.onSession(c.endpoint.session ?? c.endpoint.id);
      if (c.endpoint.context !== 'panel-private') { c.onAccepted(); return 'done'; }
      if (busyGate && String(c.prompt) === busyGate.text) {
        c.onAccepted();
        return new Promise((resolve, reject) => {
          busyGate.release = resolve;
          c.signal.addEventListener('abort', () => reject(new Error('宿主随总线停止')));
        });
      }
      if (dieText && String(c.prompt) === dieText) {
        c.onAccepted();
        throw Object.assign(new Error('宿主失联，无法确认是否停止'), { runtimeUnknown: true });
      }
      if (failText && String(c.prompt).includes(failText)) throw new Error('宿主拒绝输入');
      c.onAccepted();
      return 'done';
    },
  };
}

async function setupPanelAnswer(t, host) {
  const directory = mkdtempSync(join(tmpdir(), 'panel-answer-queue-'));
  const bus = new Bus({ directory, hosts: new Map([['fake', host]]) });
  bus.start();
  t.after(async () => {
    if (!bus.closing) await bus.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await bus.createPanelAgent({ name: 'Panel', host: 'fake', model: 'test', reasoning_effort: 'low' });
  const agent = bus.panelAgent();
  const session = bus.store.panelSession(agent.id, 'private');
  const askCard = async options => {
    const card = await bus.panelTool(session.id, session.key, 'ask', { kind: 'choice', text: '选择方案', options }, { activeTeamId: null });
    return bus.store.interaction(card.interaction);
  };
  return { bus, directory, agent, session, askCard };
}

const panelPrivateCalls = calls => calls.filter(c => c.endpoint.context === 'panel-private');

test('panel private answers survive a restart through the outbox', async t => {
  const busyGate = { text: 'BUSY', release: null };
  const calls = [];
  const f = await setupPanelAnswer(t, panelAnswerHost(calls, { busyGate }));
  const busy = f.bus.panelPrivateTurn({ text: 'BUSY' });
  await until(() => typeof busyGate.release === 'function');

  const row = await f.askCard(['A', 'B']);
  const answered = f.bus.decideInteraction(row.id, { selected: 'A' });
  assert.equal(answered.state, 'answered');
  // 答复文本立即入私聊记录;宿主在忙碌期间不会收到新回合
  await until(() => f.bus.store.get("SELECT 1 FROM panel_messages WHERE panel_agent_id=? AND role='user' AND text LIKE '%用户选择:A%'", f.agent.id));
  assert.equal(panelPrivateCalls(calls).length, 1);

  await f.bus.close();
  await busy.catch(() => {});
  // 重启后由 outbox 补投:答复文本原样送达宿主
  const callsAfter = [];
  const revived = new Bus({ directory: f.directory, hosts: new Map([['fake', panelAnswerHost(callsAfter)]]) });
  t.after(async () => { if (!revived.closing) await revived.close(); });
  revived.start();
  await until(() => panelPrivateCalls(callsAfter).some(c => String(c.prompt).includes('用户选择:A')));
  await until(() => !revived.running.size);
});

test('panel private answers wait out an unverified turn and deliver after resolution', async t => {
  const calls = [];
  const f = await setupPanelAnswer(t, panelAnswerHost(calls, { dieText: 'DIE' }));
  await assert.rejects(f.bus.panelPrivateTurn({ text: 'DIE' }), /宿主失联/);
  const unknown = f.bus.panelUnknown();
  assert.equal(unknown.length, 1);

  const row = await f.askCard(['B', 'C']);
  f.bus.decideInteraction(row.id, { selected: 'B' });
  // 答复先持久化;存在待核实运行时不投递,宿主不会收到新回合
  await until(() => f.bus.store.get("SELECT 1 FROM panel_messages WHERE panel_agent_id=? AND role='user' AND text LIKE '%用户选择:B%'", f.agent.id));
  f.bus.pump();
  assert.equal(panelPrivateCalls(calls).length, 1);

  f.bus.resolvePanelRuntime(unknown[0].id, '用户核实宿主已停止');
  await until(() => panelPrivateCalls(calls).some(c => String(c.prompt).includes('用户选择:B')));
  await until(() => !f.bus.running.size);
});

test('failed panel private answer delivery leaves a visible system notice', async t => {
  const calls = [];
  const f = await setupPanelAnswer(t, panelAnswerHost(calls, { failText: '用户选择:C' }));
  const row = await f.askCard(['C', 'D']);
  f.bus.decideInteraction(row.id, { selected: 'C' });
  await until(() => panelPrivateCalls(calls).length === 1);
  await until(() => !f.bus.running.size);
  const notice = f.bus.store.get(
    "SELECT * FROM panel_messages WHERE panel_agent_id=? AND role='system' ORDER BY seq DESC LIMIT 1",
    f.agent.id,
  );
  assert.ok(notice, 'system notice recorded');
  assert.ok(notice.text.includes('投递失败'));
  assert.ok(notice.text.includes('宿主拒绝输入'));
});

test('queued panel private answers deliver in enqueue order', async t => {
  const busyGate = { text: 'BUSY', release: null };
  const calls = [];
  const f = await setupPanelAnswer(t, panelAnswerHost(calls, { busyGate }));
  const busy = f.bus.panelPrivateTurn({ text: 'BUSY' });
  await until(() => typeof busyGate.release === 'function');
  const first = await f.askCard(['A', 'X']);
  const second = await f.askCard(['B', 'Y']);
  f.bus.decideInteraction(first.id, { selected: 'A' });
  f.bus.decideInteraction(second.id, { selected: 'B' });
  await until(() => f.bus.store.get("SELECT 1 FROM panel_messages WHERE panel_agent_id=? AND role='user' AND text LIKE '%用户选择:A%'", f.agent.id));
  await until(() => f.bus.store.get("SELECT 1 FROM panel_messages WHERE panel_agent_id=? AND role='user' AND text LIKE '%用户选择:B%'", f.agent.id));
  assert.equal(panelPrivateCalls(calls).length, 1);

  busyGate.release();
  await busy;
  await until(() => panelPrivateCalls(calls).length === 3 && !f.bus.running.size);
  const prompts = panelPrivateCalls(calls).map(c => String(c.prompt));
  assert.ok(prompts[1].includes('用户选择:A'));
  assert.ok(prompts[2].includes('用户选择:B'));
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

test('member_model becomes an interaction card and approval updates the member model', async t => {
  let requested = 0;
  const f = await setup(t, async c => {
    if (c.endpoint.context === 'coordination' && requested < 3) {
      requested += 1;
      if (requested === 1) {
        await c.onTool('member_model', { member: '助手', model: 'test', reasoning_effort: 'low' });
        await c.onTool('member_model', { member: '助手', model: 'test', reasoning_effort: 'low' });
      } else {
        await c.onTool('member_model', { member: '助手' });
      }
      c.onAccepted(); return 'requested';
    }
    c.onAccepted(); return 'done';
  }, { members: [{ name: '助手', host: 'fake' }] });
  f.server.bus.directive(f.group.id, '调整模型');
  await until(() => f.server.bus.store.get("SELECT * FROM interactions WHERE group_id=? AND kind='member_model'", f.group.id));
  // 同参数重复申请复用同一张卡
  assert.equal(f.server.bus.store.get(
    "SELECT COUNT(*) n FROM interactions WHERE group_id=? AND kind='member_model' AND state='pending'",
    f.group.id,
  ).n, 1);
  const row = f.server.bus.store.get("SELECT * FROM interactions WHERE group_id=? AND kind='member_model' AND state='pending'", f.group.id);
  const payload = JSON.parse(row.payload);
  assert.equal(payload.args.member, '助手');
  assert.equal(payload.args.model, 'test');
  assert.equal(payload.args.reasoning_effort, 'low');
  assert.equal(row.state, 'pending');
  assert.equal(f.server.bus.store.member(f.member.id).model, null);

  // 拒绝 → 模型不变,结果回送主 Agent
  const rejected = f.server.bus.decideInteraction(row.id, { approved: false });
  assert.equal(rejected.state, 'answered');
  assert.equal(f.server.bus.store.member(f.member.id).model, null);
  await until(() => f.server.bus.store.get("SELECT 1 FROM messages WHERE group_id=? AND text LIKE '%用户已拒绝%'", f.group.id));

  // 再次申请(恢复宿主默认) → 新卡;同意 → 三列写 NULL,成员收到系统通知
  await f.server.bus.directive(f.group.id, '恢复默认');
  await until(() => f.server.bus.store.get("SELECT 1 FROM interactions WHERE group_id=? AND kind='member_model' AND state='pending'", f.group.id));
  f.server.bus.store.run("UPDATE members SET model='test',reasoning_effort='low' WHERE id=?", f.member.id);
  const second = f.server.bus.store.get("SELECT * FROM interactions WHERE group_id=? AND kind='member_model' AND state='pending'", f.group.id);
  assert.ok(JSON.parse(second.payload).text.includes('宿主默认模型'));
  const approved = f.server.bus.decideInteraction(second.id, { approved: true });
  assert.equal(approved.state, 'answered');
  const memberRow = f.server.bus.store.member(f.member.id);
  assert.equal(memberRow.model, null);
  assert.equal(memberRow.reasoning_effort, null);
  await until(() => f.server.bus.store.get("SELECT 1 FROM messages WHERE group_id=? AND recipient=? AND sender='system' AND text LIKE '%模型配置%'", f.group.id, f.member.id));
  await until(() => f.server.bus.store.get("SELECT 1 FROM messages WHERE group_id=? AND text LIKE '%已生效%'", f.group.id));

  // 工具侧校验:目录外模型、不受支持的强度、非普通成员均直接报错
  const leadEndpoint = f.server.bus.store.get("SELECT * FROM conversations WHERE member_id=? AND context='coordination'", f.lead);
  await assert.rejects(() => f.server.bus.tool(leadEndpoint.id, leadEndpoint.key, 'member_model', { member: '助手', model: 'nope', reasoning_effort: 'low' }), /不在该成员宿主目录/);
  await assert.rejects(() => f.server.bus.tool(leadEndpoint.id, leadEndpoint.key, 'member_model', { member: '助手', model: 'test', reasoning_effort: 'high' }), /思考强度不受支持/);
  await assert.rejects(() => f.server.bus.tool(leadEndpoint.id, leadEndpoint.key, 'member_model', { member: 'Lead', model: 'test', reasoning_effort: 'low' }), /只能调整普通成员/);
  await assert.rejects(() => f.server.bus.tool(leadEndpoint.id, leadEndpoint.key, 'member_model', { member: 'ghost', model: 'test', reasoning_effort: 'low' }), /找不到成员/);
});

test('member_model cards for different members stay independent; same member supersedes', async t => {
  let requested = 0;
  const f = await setup(t, async c => {
    if (c.endpoint.context === 'coordination' && requested < 2) {
      requested += 1;
      if (requested === 1) {
        await c.onTool('member_model', { member: '助手', model: 'test', reasoning_effort: 'low' });
        await c.onTool('member_model', { member: '助手二', model: 'test', reasoning_effort: 'low' });
      } else {
        await c.onTool('member_model', { member: '助手' });
      }
      c.onAccepted(); return 'requested';
    }
    c.onAccepted(); return 'done';
  }, { members: [{ name: '助手', host: 'fake' }, { name: '助手二', host: 'fake' }] });
  f.server.bus.directive(f.group.id, '调整模型');
  const pendingRows = () => f.server.bus.store.all(
    "SELECT * FROM interactions WHERE group_id=? AND kind='member_model' AND state='pending' ORDER BY created",
    f.group.id,
  );
  await until(() => pendingRows().length === 2);
  // 不同成员是独立决策,两张卡并存
  assert.deepEqual(pendingRows().map(row => JSON.parse(row.payload).args.member).sort(), ['助手', '助手二']);

  // 同成员换内容 → 只替换该成员的旧卡,另一成员的卡不受影响
  await f.server.bus.directive(f.group.id, '助手恢复默认');
  await until(() => f.server.bus.store.get(
    "SELECT COUNT(*) n FROM interactions WHERE group_id=? AND kind='member_model' AND state='cancelled'",
    f.group.id,
  ).n === 1);
  assert.deepEqual(pendingRows().map(row => JSON.parse(row.payload).args.member).sort(), ['助手', '助手二']);
  const cancelled = f.server.bus.store.get(
    "SELECT * FROM interactions WHERE group_id=? AND kind='member_model' AND state='cancelled'",
    f.group.id,
  );
  assert.equal(JSON.parse(cancelled.payload).args.member, '助手');
  assert.equal(cancelled.detail, '请求内容已变化');
});

test('panel coordination group_member_model creates a card and approval updates the member', async t => {
  const f = await setup(t, async c => { c.onAccepted(); return 'done'; }, { members: [{ name: '助手', host: 'fake' }] });
  await f.server.bus.createPanelAgent({ name: 'Panel', host: 'fake', model: 'test', reasoning_effort: 'low' });
  const agent = f.server.bus.panelAgent();
  const session = f.server.bus.store.panelSession(agent.id, 'private');
  const takeover = await f.server.bus.panelTool(session.id, session.key, 'request_team_takeover', { groupId: f.group.id }, { activeTeamId: f.group.id });
  f.server.bus.decideInteraction(takeover.id, { approved: true });
  await until(() => !f.server.bus.running.size);

  const coordination = f.server.bus.store.panelSession(agent.id, 'coordination', f.group.id);
  const card = await f.server.bus.panelTool(
    coordination.id, coordination.key, 'group_member_model',
    { groupId: f.group.id, member: f.member.id, model: 'test', reasoning_effort: 'low' },
    { activeTeamId: f.group.id },
  );
  assert.equal(card.kind, 'member_model');
  assert.equal(card.state, 'pending');
  // 幂等:同文本重复请求复用同一张卡
  const again = await f.server.bus.panelTool(
    coordination.id, coordination.key, 'group_member_model',
    { groupId: f.group.id, member: f.member.id, model: 'test', reasoning_effort: 'low' },
    { activeTeamId: f.group.id },
  );
  assert.equal(again.id, card.id);

  const approved = f.server.bus.decideInteraction(card.id, { approved: true });
  assert.equal(approved.state, 'answered');
  const memberRow = f.server.bus.store.member(f.member.id);
  assert.equal(memberRow.model, 'test');
  assert.equal(memberRow.reasoning_effort, 'low');
  await until(() => !f.server.bus.running.size);
});

test('panel group_member_model cards for different members stay independent', async t => {
  const f = await setup(t, async c => { c.onAccepted(); return 'done'; }, { members: [{ name: '助手', host: 'fake' }, { name: '助手二', host: 'fake' }] });
  await f.server.bus.createPanelAgent({ name: 'Panel', host: 'fake', model: 'test', reasoning_effort: 'low' });
  const agent = f.server.bus.panelAgent();
  const session = f.server.bus.store.panelSession(agent.id, 'private');
  const takeover = await f.server.bus.panelTool(session.id, session.key, 'request_team_takeover', { groupId: f.group.id }, { activeTeamId: f.group.id });
  f.server.bus.decideInteraction(takeover.id, { approved: true });
  await until(() => !f.server.bus.running.size);

  const coordination = f.server.bus.store.panelSession(agent.id, 'coordination', f.group.id);
  const second = f.server.bus.store.get("SELECT * FROM members WHERE group_id=? AND name='助手二'", f.group.id);
  const setModel = member => f.server.bus.panelTool(
    coordination.id, coordination.key, 'group_member_model',
    { groupId: f.group.id, member, model: 'test', reasoning_effort: 'low' },
    { activeTeamId: f.group.id },
  );
  const resetModel = member => f.server.bus.panelTool(
    coordination.id, coordination.key, 'group_member_model',
    { groupId: f.group.id, member },
    { activeTeamId: f.group.id },
  );

  // 不同成员是独立决策,两张卡并存(后发的卡不挤掉先发的)
  const cardA = await setModel(f.member.id);
  const cardB = await setModel(second.id);
  assert.equal(cardA.state, 'pending');
  assert.equal(cardB.state, 'pending');
  assert.notEqual(cardA.id, cardB.id);
  assert.equal(f.server.bus.store.interaction(cardA.id).state, 'pending');

  // 同成员改内容 → 只替换该成员的旧卡
  const changed = await resetModel(f.member.id);
  assert.equal(changed.state, 'pending');
  assert.notEqual(changed.id, cardA.id);
  assert.equal(f.server.bus.store.interaction(cardA.id).state, 'cancelled');
  assert.equal(f.server.bus.store.interaction(cardA.id).detail, '请求内容已变化');
  assert.equal(f.server.bus.store.interaction(cardB.id).state, 'pending');

  // 同成员同参数 → 幂等复用
  const again = await resetModel(f.member.id);
  assert.equal(again.id, changed.id);
});

test('member model HTTP route applies directly with catalog validation', async t => {
  const f = await setup(t, async c => { c.onAccepted(); return 'done'; }, { members: [{ name: '助手', host: 'fake' }] });
  const good = await fetch(new URL(`/api/teams/${f.group.id}/members/${f.member.id}/model`, f.server.url), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'test', reasoning_effort: 'low' }),
  });
  assert.equal(good.status, 200);
  const updated = await good.json();
  assert.equal(updated.model, 'test');
  assert.equal(updated.reasoning_effort, 'low');

  const bad = await fetch(new URL(`/api/teams/${f.group.id}/members/${f.member.id}/model`, f.server.url), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'nope' }),
  });
  assert.equal(bad.status, 400);

  const reset = await fetch(new URL(`/api/teams/${f.group.id}/members/${f.member.id}/model`, f.server.url), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(reset.status, 200);
  assert.equal((await reset.json()).model, null);
});

test('legacy interactions table rebuilds to accept member_model kind', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'interactions-migrate-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  {
    // 直接构造一个只含旧 interactions 的 v1 数据目录；Store 启动时补齐其余 v1 表再迁移到 v2。
    const raw = new DatabaseSync(join(directory, 'groups.sqlite'));
    raw.exec(`CREATE TABLE interactions(id TEXT PRIMARY KEY,group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,member_id TEXT REFERENCES members(id) ON DELETE CASCADE,panel_agent_id TEXT REFERENCES panel_agents(id) ON DELETE CASCADE,endpoint_id TEXT,context TEXT NOT NULL,turn_id TEXT NOT NULL,call_id TEXT NOT NULL,message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,panel_message_id TEXT,kind TEXT NOT NULL CHECK(kind IN ('choice','input','takeover','handback','group_create','group_add','group_delete')),payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','answered','cancelled','failed')),answer TEXT,detail TEXT,answer_message_id TEXT,created TEXT NOT NULL,answered TEXT)`);
    raw.close();
  }
  const store = new Store(directory);
  const sql = store.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='interactions'").sql;
  assert.ok(sql.includes("'member_model'"));
  store.run("INSERT INTO interactions(id,group_id,member_id,panel_agent_id,conversation_id,context,turn_id,call_id,message_id,panel_message_id,kind,payload,state,detail,created) VALUES('m1',NULL,NULL,NULL,NULL,'coordination','t','c',NULL,NULL,'member_model','{}','pending',NULL,'2026-01-01T00:00:00.000Z')");
  assert.equal(store.interaction('m1').kind, 'member_model');
  store.close();
});
