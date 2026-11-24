import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from '../../server.mjs';
import { Bus } from '../../bus.mjs';
import { Store } from '../../store.mjs';
import { createTestGroup } from '../support/fixture.mjs';
import { validateTool } from '../../tools/registry.mjs';

describe('interactions', () => {
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
  t.after(async () => { await server.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
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

test('ask takes either a single question or 2-8 steps and rejects a mixture', async t => {
  const f = await setup(t, async c => { c.onAccepted(); return 'done'; });
  const endpoint = f.server.bus.store.conversation('member', f.lead, 'coordination');
  const ask = args => f.server.bus.tool(endpoint.id, endpoint.key, 'ask', args);
  const step = (kind, text, options) => ({ kind, text, ...(options ? { options } : {}) });

  // schema 层:每步都要 kind+text,steps 2-8,单问与多步共用一个工具
  assert.throws(
    () => validateTool('member', 'ask', { steps: [step('input', '只有一个')] }, 'coordination'),
    /至少需要2项/,
  );
  assert.throws(
    () => validateTool('member', 'ask', { steps: [step('input', '一'), { kind: 'input' }] }, 'coordination'),
    /text为必填项/,
  );
  assert.doesNotThrow(() => validateTool('member', 'ask', { steps: [step('choice', '一', ['A', 'B']), step('input', '二')] }, 'coordination'));

  // Bus 层:两种形态互斥,每步的 kind/options 配对
  await assert.rejects(
    () => ask({ text: '混合', kind: 'choice', options: ['A', 'B'], steps: [step('input', '一'), step('input', '二')] }),
    /不能与 kind\/options 同时使用/,
  );
  await assert.rejects(
    () => ask({ steps: [step('choice', '一'), step('choice', '二')] }),
    /第 1 步choice 必须提供 options/,
  );
  await assert.rejects(
    () => ask({ steps: [step('input', '一'), step('input', '二', ['A', 'B'])] }),
    /第 2 步input 不接受 options/,
  );
  // 形态合法但不在执行回合内:不建卡
  await assert.rejects(
    () => ask({ steps: [step('input', '一'), step('input', '二')] }),
    /只能在执行回合内发出/,
  );
  // 公共 HTTP 投影：没有建出任何互动卡。
  assert.deepEqual(await (await fetch(new URL(`/api/interactions?group=${f.group.id}`, f.server.url))).json(), []);
});

test('multi-step ask keeps one pending card and delivers one combined answer', async t => {
  let asked = false;
  const f = await setup(t, async c => {
    if (c.endpoint.context === 'coordination' && !asked) {
      asked = true;
      await c.onTool('ask', {
        text: '上线前确认',
        steps: [
          { kind: 'choice', text: '是否切换流量？', options: ['切换', '暂不'] },
          { kind: 'input', text: '灰度比例？' },
        ],
      });
      c.onAccepted(); return 'asked';
    }
    c.onAccepted(); return 'done';
  });
  f.server.bus.directive(f.group.id, '准备上线');
  await until(() => f.server.bus.store.get('SELECT * FROM interactions WHERE group_id=?', f.group.id));
  const row = f.server.bus.store.get('SELECT * FROM interactions WHERE group_id=?', f.group.id);
  assert.equal(row.kind, 'flow');
  const payload = JSON.parse(row.payload);
  assert.equal(payload.cardOnly, true, '卡片是唯一展示面');
  assert.equal(payload.steps.length, 2);
  assert.equal(payload.steps[0].answer, null);
  // 锚点消息仍然存在:答复要用它做 reply_to,群记录也要能看到问过什么
  const anchor = f.server.bus.store.get('SELECT * FROM messages WHERE id=?', row.message_id);
  assert.equal(anchor.text, '上线前确认');
  assert.equal(anchor.recipient, 'user');

  // 缺答复、数量不符、选项越界、文本为空:整体拒绝,卡片保持 pending 且不投递
  const userMessages = () => f.server.bus.store.get(
    "SELECT COUNT(*) n FROM messages WHERE group_id=? AND sender='user' AND seq>?",
    f.group.id,
    anchor.seq,
  ).n;
  assert.throws(() => f.server.bus.decideInteraction(row.id, { selected: '切换' }), /一次提交 2 个答复/);
  assert.throws(() => f.server.bus.decideInteraction(row.id, { answers: [{ selected: '切换' }] }), /同时回答 2 个问题/);
  assert.throws(
    () => f.server.bus.decideInteraction(row.id, { answers: [{ selected: '不支持' }, { value: '10%' }] }),
    /选项/,
  );
  assert.throws(
    () => f.server.bus.decideInteraction(row.id, { answers: [{ selected: '切换' }, { value: '   ' }] }),
    /1-48000/,
  );
  assert.equal(f.server.bus.store.interaction(row.id).state, 'pending');
  assert.equal(userMessages(), 0);
  assert.equal(f.server.bus.running.size, 0);
  assert.equal(JSON.parse(f.server.bus.store.interaction(row.id).payload).steps[0].answer, null, '拒绝时不留半套答复');

  // 一次性提交全部答复:合成一条用户消息,只投递一次、只唤醒一次
  const done = f.server.bus.decideInteraction(row.id, { answers: [{ selected: '切换' }, { value: '10%' }] });
  assert.equal(done.state, 'answered');
  assert.equal(done.answer.answers.length, 2);
  assert.deepEqual(JSON.parse(f.server.bus.store.interaction(row.id).payload).steps.map(step => step.answer), [
    { selected: '切换' },
    { value: '10%' },
  ]);
  const answerMessage = f.server.bus.store.get('SELECT * FROM messages WHERE id=?', done.answer_message_id);
  assert.equal(answerMessage.sender, 'user');
  assert.equal(answerMessage.reply_to, row.message_id);
  assert.match(answerMessage.text, /用户多步答复/);
  assert.match(answerMessage.text, /1\. 是否切换流量？ 用户选择:切换/);
  assert.match(answerMessage.text, /2\. 灰度比例？ 用户填写:\n10%/);
  assert.equal(userMessages(), 1);
  assert.throws(() => f.server.bus.decideInteraction(row.id, { answers: [{ selected: '切换' }, { value: '10%' }] }), /已经结束/);

  await until(() => f.calls.some(c => String(c.prompt).includes('用户多步答复')));
  const wake = f.calls.findLast(c => String(c.prompt).includes('用户多步答复'));
  assert.ok(wake.prompt.includes('灰度比例'), '发起者一次拿到全部问答');
  assert.ok(wake.prompt.includes('是否切换流量'), '已完成步骤也在同一条答复里');
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
  assert.equal(payload.cardOnly, true, '卡片即展示面,锚点消息不渲染正文');
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
  t.after(async () => { await server.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
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
  await until(() => calls.some(c => c.endpoint.owner_kind === 'panel_agent' && c.endpoint.context === 'private' && String(c.prompt).includes('用户选择:创建')));
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
      if (c.endpoint.owner_kind !== 'panel_agent') { c.onAccepted(); return 'done'; }
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
  // rm 由各测试在末尾注册(after 按 FIFO 执行,目录删除必须晚于一切 close)
  t.after(async () => {
    if (!bus.closing) await bus.close();
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

const panelPrivateCalls = calls => calls.filter(c => c.endpoint.owner_kind === 'panel_agent' && c.endpoint.context === 'private');

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
  t.after(() => { try { rmSync(f.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ } });
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
  t.after(() => { try { rmSync(f.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ } });
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
  t.after(() => { try { rmSync(f.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ } });
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
  t.after(() => { try { rmSync(f.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ } });
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
  assert.equal(f.server.bus.members(f.group.id).some(member => member.name === '新成员'), false);

  // 拒绝 → 不加入,结果回送
  const rejected = f.server.bus.decideInteraction(row.id, { approved: false });
  assert.equal(rejected.state, 'answered');
  assert.equal(f.server.bus.members(f.group.id).some(member => member.name === '新成员'), false);
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
  assert.equal(f.server.bus.members(f.group.id).filter(member => member.name === '新成员').length, 1);
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
  const memberModelCards = async () => (await (await fetch(new URL(`/api/interactions?group=${f.group.id}`, f.server.url))).json())
    .filter(card => card.kind === 'member_model');
  let pendingCards = await memberModelCards();
  for (let index = 0; index < 300 && !pendingCards.length; index += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
    pendingCards = await memberModelCards();
  }
  assert.ok(pendingCards.length > 0, '互动卡应已写入');
  // 同参数重复申请复用同一张卡（公共 HTTP 投影上只有一张 pending）
  assert.equal(pendingCards.filter(card => card.state === 'pending').length, 1);
  const row = pendingCards.find(card => card.state === 'pending');
  const payload = row.payload;
  assert.equal(payload.args.member, '助手');
  assert.equal(payload.cardOnly, true, '动作卡的锚点消息同样只作记录');
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
  t.after(() => { try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ } });
  {
    // 直接构造一个只含旧 interactions 的 v1 数据目录；Store 启动时补齐其余 v1 表再迁移到 v2。
    const raw = new DatabaseSync(join(directory, 'groups.sqlite'));
    raw.exec(`CREATE TABLE interactions(id TEXT PRIMARY KEY,group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,member_id TEXT REFERENCES members(id) ON DELETE CASCADE,panel_agent_id TEXT REFERENCES panel_agents(id) ON DELETE CASCADE,endpoint_id TEXT,context TEXT NOT NULL,turn_id TEXT NOT NULL,call_id TEXT NOT NULL,message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,panel_message_id TEXT,kind TEXT NOT NULL CHECK(kind IN ('choice','input','takeover','handback','group_create','group_add','group_delete')),payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','answered','cancelled','failed')),answer TEXT,detail TEXT,answer_message_id TEXT,created TEXT NOT NULL,answered TEXT)`);
    raw.close();
  }
  const store = new Store(directory);
  const sql = store.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='interactions'").sql;
  assert.ok(sql.includes("'member_model'"));
  assert.ok(sql.includes("'member_policy'"));
  const columns = store.all("PRAGMA table_info(interactions)").map(column => column.name);
  assert.ok(columns.includes('conversation_id'));
  assert.ok(!columns.includes('endpoint_id'));
  store.run("INSERT INTO interactions(id,group_id,member_id,panel_agent_id,conversation_id,context,turn_id,call_id,message_id,panel_message_id,kind,payload,state,detail,created) VALUES('m1',NULL,NULL,NULL,NULL,'coordination','t','c',NULL,NULL,'member_model','{}','pending',NULL,'2026-01-01T00:00:00.000Z')");
  assert.equal(store.interaction('m1').kind, 'member_model');
  store.close();
});
});

describe('team-directives', () => {
const tick = () => new Promise(r => setImmediate(r));
async function until(fn) { for (let i=0;i<300;i++) { if(fn())return; await new Promise(r=>setTimeout(r,5)); } throw Error('timeout'); }
async function setup(t, run, { members = [] } = {}) {
 const directory=mkdtempSync(join(tmpdir(),'team-directives-'));
 const calls=[];
 const host={async listModels(){return{version:1,host:'fake',source:'test',defaultModel:'test',models:[{id:'test',key:'test',reasoningEfforts:[{id:'low'}]}]};},async run(c){c.onSession(c.endpoint.session??c.endpoint.id);if(c.endpoint.context==='profile'){await c.onTool('profile_set',{text:'ready'});c.onAccepted();return''}calls.push(c);if(run)return run(c);c.onAccepted();return'done'}};
 let server=await startServer({directory,hosts:new Map([['fake',host]])});
 t.after(async()=>{await server.close();rmSync(directory,{recursive:true,force:true,maxRetries:20,retryDelay:100})});
 const group=createTestGroup(server.bus,{name:'directives',workspace:directory,lead:{name:'Lead',host:'fake'},members});await until(()=>!server.bus.running.size);
 const send=(body,headers={})=>fetch(new URL(`/api/teams/${group.id}/directives`,server.url),{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
 const read=async()=>{const r=await fetch(new URL(`/api/teams/${group.id}/directives`,server.url));return r.json()};
 return{get server(){return server},group,calls,send,read,restart:async()=>{await until(()=>!server.bus.running.size);await server.close();server=await startServer({directory,hosts:new Map([['fake',host]])});}};
}
test('HTTP directives work without cookies, reject cross-origin/forged identity and validate text',async t=>{
 const f=await setup(t),body={text:'hello',operationId:'one',controllerId:f.group.lead};
 assert.equal((await f.send(body,{cookie:''})).status,200);
 assert.equal((await f.send(body,{origin:'https://attacker.example'})).status,403);
 assert.equal((await f.send(body,{'sec-fetch-site':'cross-site'})).status,403);
 assert.equal((await f.send({...body,text:' '})).status,400);
 assert.equal((await f.send({...body,text:'x'.repeat(48001)})).status,400);
 assert.equal((await f.send({...body,sender:'member'})).status,400);
 assert.equal((await f.send({...body,controllerId:'stale-controller'})).status,400);
 // 公共预览：只有一次有效指令落库（被拒请求不产生指令）。
 assert.equal((await f.read()).length,1);
});
test('retry after lost acknowledgement is durable, idempotent and reports actual delivery',async t=>{
 const f=await setup(t),body={text:' hello ',operationId:'durable',controllerId:f.group.lead};
 const first=await f.send(body);assert.equal(first.status,200);const receipt=await first.json();assert.equal(receipt.status,'queued');
 const duplicate=await(await f.send(body)).json();assert.equal(duplicate.messageId,receipt.messageId);
 assert.equal((await f.send({...body,text:'changed'})).status,400);
 await until(()=>!f.server.bus.running.size);assert.equal((await f.read())[0].status,'delivered');
 // 公共消息列表校验指令落库的发送者与接收者。
 const sentMessages=await(await fetch(new URL(`/api/messages?group=${f.group.id}&latest=1`,f.server.url))).json();
 const msg=sentMessages.find(message=>message.id===receipt.messageId);
 assert.equal(msg.sender,'user');assert.equal(msg.recipient,f.group.lead);
 await f.restart();const again=await(await f.send(body)).json();assert.equal(again.messageId,receipt.messageId);
 // 公共预览：重启 + 幂等重放后仍只有一条指令。
 assert.equal((await f.read()).length,1);
});
test('busy lead queues the next directive and keeps both messages in coordination',async t=>{
 let release;let first=true;
 const f=await setup(t,async c=>{c.onAccepted();if(first){first=false;await new Promise(r=>{release=r;c.signal.addEventListener('abort',r,{once:true})})}return'done'});
 const body={text:'first',operationId:'a',controllerId:f.group.lead};await f.send(body);await until(()=>Boolean(release));
 const next=await(await f.send({...body,text:'second',operationId:'b'})).json();assert.equal(next.status,'queued');assert.equal(f.calls.length,1);
 release();await until(()=>f.calls.length===2&&!f.server.bus.running.size);assert.equal((await f.read()).find(r=>r.messageId===next.messageId).status,'delivered');
 assert.ok(f.calls.every(c=>c.endpoint.context==='coordination'));
});
test('delivery failure is visible and does not turn retrying HTTP into duplicate dispatch',async t=>{
 const f=await setup(t,async()=>{throw Error('host unavailable')});const body={text:'hello',operationId:'failed',controllerId:f.group.lead};
 const systemNotices=async()=>{const rows=await(await fetch(new URL(`/api/messages?group=${f.group.id}`,f.server.url))).json();return rows.filter(m=>m.kind==='system').length};
 const before=await systemNotices();
 const receipt=await(await f.send(body)).json();await until(()=>!f.server.bus.running.size);await tick();
 assert.equal((await f.read())[0].status,'failed');assert.match((await f.read())[0].error,/host unavailable/);
 // 失败状态由气泡下方的回执标签承载,消息流里不再追加一条系统通知(同一条消息说两遍)。
 assert.equal(await systemNotices(),before);
 assert.equal((await(await f.send(body)).json()).messageId,receipt.messageId);assert.equal(f.calls.length,1);
});
test('controller change rejects stale submissions; panel takeover routes to its coordination and private stays untouched',async t=>{
 const f=await setup(t);await f.server.bus.createPanelAgent({name:'Panel',host:'fake',model:'test',reasoning_effort:'low'});
 const before=f.server.bus.panelConversation().messages.length;const _taken=f.server.bus.takeoverTeam(f.group.id,0);const controller=f.server.bus.teamController(f.group.id);
 assert.equal(controller.kind,'panel_agent');
 assert.equal((await f.send({text:'hello',operationId:'stale',controllerId:f.group.lead})).status,400);
 const sent=await f.send({text:'hello panel lead',operationId:'panel',controllerId:controller.id});assert.equal(sent.status,200);
 await until(()=>!f.server.bus.running.size);await tick();
 assert.equal((await f.read())[0].status,'delivered');assert.ok(f.calls.some(c=>c.endpoint.owner_kind==='panel_agent'&&c.endpoint.context==='coordination'));
 assert.equal(f.server.bus.panelConversation().messages.length,before);
});
test('open targets accept directives; archived targets reject new input until restored',async t=>{
 const f=await setup(t);const s=f.server.bus.store;const body={text:'同步当前进展',operationId:'open',controllerId:f.group.lead};
 const response=await f.send(body);assert.equal(response.status,200);await until(()=>!f.server.bus.running.size);
 assert.equal(f.calls.at(-1).policy.mode,'communication');
 s.run("UPDATE groups SET state='archived' WHERE id=?",f.group.id);
 assert.equal((await f.send({...body,operationId:'archive'})).status,410);
 s.run("UPDATE groups SET state=NULL WHERE id=?",f.group.id);
 assert.equal((await f.send({...body,operationId:'restored'})).status,200);
});

test('a failed directive does not indefinitely block a later directive or replay the failed input', async t => {
 let fail=true;
 const f=await setup(t,async c=>{if(fail){fail=false;throw Error('host unavailable')}c.onAccepted();return'done'});
 const body={text:'first',operationId:'first-failed',controllerId:f.group.lead};
 const first=await(await f.send(body)).json();
 await until(()=>!f.server.bus.running.size);await tick();
 assert.equal((await f.read()).find(r=>r.messageId===first.messageId).status,'failed');
 const next=await(await f.send({...body,text:'second',operationId:'next'})).json();
 await until(()=>f.calls.length===2&&!f.server.bus.running.size);
 const receipts=await f.read();
 assert.equal(receipts.find(r=>r.messageId===next.messageId).status,'delivered');
 assert.equal(receipts.find(r=>r.messageId===first.messageId).status,'failed');
 assert.equal(f.calls.length,2);
});

test('directive final output appears as a durable reply without dispatching another agent turn', async t => {
 const f=await setup(t,async c=>{c.onAccepted();return '当前工作已经完成。'});
 const first=await(await f.send({text:'报告进度',operationId:'reply',controllerId:f.group.lead})).json();
 await until(()=>!f.server.bus.running.size);await tick();
 const replies=()=>f.server.bus.store.all('SELECT * FROM messages WHERE reply_to=?',first.messageId);
 assert.equal(replies().length,1);
 assert.equal(replies()[0].text,'当前工作已经完成。');
 assert.equal(replies()[0].sender,f.group.lead);
 assert.equal(replies()[0].recipient,'user');
 assert.equal(f.calls.length,1);
 assert.equal(f.server.bus.store.pending().filter(m=>m.group_id===f.group.id).length,0);
 await f.restart();assert.equal(replies().length,1);
});

test('lead can deliver to the user explicitly with send(to=user) without queueing delivery', async t => {
  const f = await setup(t, async c => {
    c.onAccepted();
    const sent = await c.onTool('send', { to: 'user', text: '显式交付给用户' });
    assert.ok(sent.messageId);
    await assert.rejects(
      c.onTool('send', { to: 'user', text: '需要用户额外答复时改用 ask', expects_reply: true }),
      /只支持正文/,
    );
    return '内部收尾文本';
  });
  await f.send({ text: '开始', operationId: 'user-send', controllerId: f.group.lead });
  await until(() => !f.server.bus.running.size); await tick();
  const rows = f.server.bus.store.all("SELECT * FROM messages WHERE group_id=? AND recipient='user' ORDER BY seq", f.group.id);
  const explicit = rows.find(row => row.text === '显式交付给用户');
  assert.equal(explicit.sender, f.group.lead);
  assert.equal(explicit.kind, 'send');
  assert.equal(explicit.reply_to, null);
  assert.equal(explicit.awaiting, 0);
  assert.equal(f.server.bus.store.pending().filter(message => message.group_id === f.group.id).length, 0);
});

test('restart recovers a historical final output once without invoking the model again', async t => {
 const f=await setup(t,async c=>{c.onAccepted();return '历史回复'});
 const input=await(await f.send({text:'状态',operationId:'recover',controllerId:f.group.lead})).json();
 await until(()=>!f.server.bus.running.size);await tick();
 // Simulate a pre-fix database: final output exists but no chat reply was published.
 f.server.bus.store.run('DELETE FROM messages WHERE reply_to=?',input.messageId);
 const count=f.calls.length;
 await f.restart();
 const replies=()=>f.server.bus.store.all('SELECT * FROM messages WHERE reply_to=?',input.messageId);
 assert.equal(replies().length,1);assert.equal(replies()[0].text,'历史回复');
 f.server.bus.teamDirectives.recoverOutputs();assert.equal(replies().length,1);
 assert.equal(f.calls.length,count);
});

test('Panel Agent coordination also publishes a directive reply without leaking private conversation', async t => {
 const f=await setup(t);
 await f.server.bus.createPanelAgent({name:'Panel',host:'fake',model:'test',reasoning_effort:'low'});
 f.server.bus.takeoverTeam(f.group.id,0);
 const controller=f.server.bus.teamController(f.group.id);
 const before=f.server.bus.panelConversation().messages.length;
 const input=await(await f.send({text:'汇报',operationId:'panel-reply',controllerId:controller.id})).json();
 await until(()=>!f.server.bus.running.size);await tick();
 const replies=f.server.bus.store.all('SELECT * FROM messages WHERE reply_to=?',input.messageId);
 assert.equal(replies.length,1);assert.equal(replies[0].sender,controller.id);
 assert.equal(f.server.bus.panelConversation().messages.length,before);
});

test('empty and failed outputs never fabricate a user reply', async t => {
 let fail=false;
 const f=await setup(t,async c=>{if(fail)throw Error('failure');c.onAccepted();return '  '});
 for(const operationId of ['empty','error']){
  const input=await(await f.send({text:'状态',operationId,controllerId:f.group.lead})).json();
  await until(()=>!f.server.bus.running.size);await tick();
  // 公共消息列表（/api/messages）里没有 reply_to 指向这条指令的伪造回复。
  const groupMessages=await(await fetch(new URL(`/api/messages?group=${f.group.id}&latest=1`,f.server.url))).json();
  assert.equal(groupMessages.filter(message=>message.reply_to===input.messageId).length,0);
  fail=true;
 }
});

test('team directive publishes a live draft and completes it after the durable reply', async t => {
  const f = await setup(t, async context => {
    context.onAccepted();
    context.onTextDelta('你');
    context.onTextDelta('好');
    return '你好';
  });
  const events = [];
  f.server.bus.on('team-stream', event => events.push(event));
  const input = await (await f.send({
    text: '流式回复',
    operationId: 'team-live',
    controllerId: f.group.lead,
  })).json();
  await until(() => !f.server.bus.running.size);
  await tick();
  assert.deepEqual(events.map(event => event.type), [
    'start',
    'delta',
    'delta',
    'complete',
  ]);
  assert.deepEqual(
    events.filter(event => event.type === 'delta').map(event => event.delta),
    ['你', '好'],
  );
  assert.ok(
    events
      .filter(event => event.type === 'delta')
      .every(event => event.stream.text === ''),
  );
  const reply = f.server.bus.store.get('SELECT * FROM messages WHERE reply_to=?', input.messageId);
  assert.equal(reply.text, '你好');
  const complete = events.find(event => event.type === 'complete');
  assert.equal(complete.stream.messageId, reply.id);
  assert.equal(complete.stream.messageSeq, reply.seq);
});

test('agent-to-agent send tool arguments stream before the durable team message', async t => {
  const f = await setup(t, async context => {
    context.onAccepted();
    if (context.endpoint.context !== 'coordination') return '';
    context.onToolCallDelta({
      callId: 'send-1',
      name: 'send',
      argumentsDelta: '{"to":"Worker","text":"流',
    });
    context.onToolCallDelta({
      callId: 'send-1',
      name: 'send',
      argumentsDelta: '式消息"}',
    });
    await context.onTool('send', {
      to: 'Worker',
      text: '流式消息',
    }, { nativeCallId: 'send-1' });
    return '';
  }, {
    members: [{ name: 'Worker', host: 'fake' }],
  });
  const events = [];
  f.server.bus.on('team-stream', event => events.push(event));
  await f.send({
    text: 'send a message',
    operationId: 'team-send-stream',
    controllerId: f.group.lead,
  });
  await until(() => !f.server.bus.running.size);
  await tick();
  const messageEvents = events.filter(event => event.stream?.kind === 'message');
  assert.deepEqual(messageEvents.map(event => event.type), [
    'start',
    'delta',
    'delta',
    'complete',
  ]);
  assert.deepEqual(
    messageEvents.filter(event => event.type === 'delta').map(event => event.delta),
    ['流', '式消息'],
  );
  assert.equal(messageEvents.at(-1).stream.text, '流式消息');
  assert.equal(messageEvents.at(-1).stream.recipientName, 'Worker');
  assert.equal(messageEvents.at(-1).stream.messageKind, 'send');
  const durable = f.server.bus.store.get(
    "SELECT * FROM messages WHERE text='流式消息' AND kind='send'",
  );
  assert.equal(messageEvents.at(-1).stream.messageId, durable.id);
  assert.equal(messageEvents.at(-1).stream.messageSeq, durable.seq);
});

test('parallel same-name message tools complete against the matching stream', async t => {
  const f = await setup(t, async context => {
    context.onAccepted();
    if (context.endpoint.context !== 'coordination') return '';
    context.onToolCallDelta({
      callId: 'send-a',
      name: 'send',
      argumentsDelta: '{"text":"消息 A","to":"Worker"}',
      complete: true,
    });
    context.onToolCallDelta({
      callId: 'send-b',
      name: 'send',
      argumentsDelta: '{"to":"Worker","text":"消息 B"}',
      complete: true,
    });
    await context.onTool('send', { text: '消息 A', to: 'Worker' });
    await context.onTool('send', { to: 'Worker', text: '消息 B' });
    return '';
  }, {
    members: [{ name: 'Worker', host: 'fake' }],
  });
  const events = [];
  f.server.bus.on('team-stream', event => events.push(event));
  await f.send({
    text: 'send both',
    operationId: 'parallel-sends',
    controllerId: f.group.lead,
  });
  await until(() => !f.server.bus.running.size);
  await tick();
  const completed = events.filter(event => (
    event.type === 'complete' && event.stream.kind === 'message'
  ));
  assert.deepEqual(completed.map(event => event.stream.text), ['消息 A', '消息 B']);
  assert.equal(new Set(completed.map(event => event.stream.id)).size, 2);
});

test('note tools stream escaped text and keep note semantics', async t => {
  const f = await setup(t, async context => {
    context.onAccepted();
    if (context.endpoint.context !== 'coordination') return '';
    context.onToolCallDelta({
      callId: 'note-1',
      name: 'note',
      argumentsDelta: '{"text":"第一行\\\\n\\\\"',
    });
    context.onToolCallDelta({
      callId: 'note-1',
      name: 'note',
      argumentsDelta: JSON.stringify({
        text: '第一行\n"引用"',
        to: 'Worker',
      }),
      complete: true,
    });
    await context.onTool('note', {
      text: '第一行\n"引用"',
      to: 'Worker',
    });
    return '';
  }, {
    members: [{ name: 'Worker', host: 'fake' }],
  });
  const events = [];
  f.server.bus.on('team-stream', event => events.push(event));
  await f.send({
    text: 'leave a note',
    operationId: 'note-stream',
    controllerId: f.group.lead,
  });
  await until(() => !f.server.bus.running.size);
  await tick();
  const noteEvents = events.filter(event => event.stream?.kind === 'message');
  assert.ok(noteEvents.length >= 3);
  assert.ok(noteEvents.every(event => event.stream.messageKind === 'note'));
  assert.equal(noteEvents.at(-1).type, 'complete');
  assert.equal(noteEvents.at(-1).stream.text, '第一行\n"引用"');
});

test('failed message tool removes its live draft immediately', async t => {
  const events = [];
  const f = await setup(t, async context => {
    context.onAccepted();
    if (context.endpoint.context !== 'coordination') return '';
    context.onToolCallDelta({
      callId: 'failed-send',
      name: 'send',
      argumentsDelta: '{"to":"Worker","text":"不会发送"}',
      complete: true,
    });
    let failedImmediately = false;
    try {
      await context.onTool('send', { to: 'MissingMember', text: '不会发送' });
    } catch {
      failedImmediately = events.some(event => (
        event.type === 'error' && event.stream?.toolCallId === 'failed-send'
      ));
    }
    assert.equal(failedImmediately, true);
    return '失败已处理';
  }, {
    members: [{ name: 'Worker', host: 'fake' }],
  });
  f.server.bus.on('team-stream', event => events.push(event));
  await f.send({
    text: 'fail safely',
    operationId: 'failed-message-stream',
    controllerId: f.group.lead,
  });
  await until(() => !f.server.bus.running.size);
  await tick();
  assert.equal(events.filter(event => event.type === 'error').length, 1);
  assert.equal(
    f.server.bus.store.all(
      "SELECT * FROM messages WHERE text='不会发送' AND kind='send'",
    ).length,
    0,
  );
  assert.deepEqual(f.server.bus.teamStreaming(f.group.id), []);
});

test('Panel Agent team_note streams with note semantics', async t => {
  const f = await setup(t, async context => {
    context.onAccepted();
    if (!(context.endpoint.owner_kind === 'panel_agent' && context.endpoint.context === 'coordination')) return '';
    context.onToolCallDelta({
      callId: 'panel-note',
      name: 'mcp__agent_team__team_note',
      argumentsDelta: '{"groupId":"',
    });
    context.onToolCallDelta({
      callId: 'panel-note',
      name: 'mcp__agent_team__team_note',
      argumentsDelta: JSON.stringify({
        groupId: f.group.id,
        text: 'Panel 留言',
        to: 'Worker',
      }),
      complete: true,
    });
    await context.onTool('team_note', {
      groupId: f.group.id,
      text: 'Panel 留言',
      to: 'Worker',
    });
    return '留言已发送';
  }, {
    members: [{ name: 'Worker', host: 'fake' }],
  });
  await f.server.bus.createPanelAgent({
    name: 'Panel',
    host: 'fake',
    model: 'test',
    reasoning_effort: 'low',
  });
  f.server.bus.takeoverTeam(f.group.id, 0);
  const controller = f.server.bus.teamController(f.group.id);
  const events = [];
  f.server.bus.on('team-stream', event => events.push(event));
  const response = await f.send({
    text: 'leave a panel note',
    operationId: 'panel-note-stream',
    controllerId: controller.id,
  });
  assert.equal(response.status, 200, await response.text());
  await until(() => !f.server.bus.running.size);
  await tick();
  const notes = events.filter(event => (
    event.stream?.kind === 'message' && event.stream.messageKind === 'note'
  ));
  assert.ok(notes.length, JSON.stringify(events));
  assert.equal(notes.at(-1).type, 'complete');
  assert.equal(notes.at(-1).stream.text, 'Panel 留言');
});
});

describe('agent-tasks', () => {
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
  t.after(async () => { await server.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
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
});
