import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../server.mjs';
import { Bus } from '../../bus.mjs';
import { createTestGroup, seedPanelAgent } from '../support/fixture.mjs';
import { dismissWorkbench, homeWorkbench, searchWorkspace } from '../../productivity.mjs';
import { insertPrincipal } from '../../aggregates/external-control.mjs';
import * as panelAgg from '../../aggregates/panel.mjs';

test('search treats wildcard characters literally, filters groups and dates and links exact records', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'productivity-'));
  const bus = new Bus({
    directory,
    hosts: new Map([
      [
        'fake',
        {
          async run() {
            return 'ok';
          },
        },
      ],
    ]),
  });
  t.after(async () => {
    await bus.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  });
  const a = createTestGroup(bus, {
    name: 'a',
    workspace: directory,
    lead: { name: 'lead', host: 'fake' },
    members: [],
  });
  const b = createTestGroup(bus, {
    name: 'b',
    workspace: directory,
    lead: { name: 'lead', host: 'fake' },
    members: [],
  });
  const message = bus.store.append(
    a.id,
    'user',
    a.lead,
    'send',
    'search 100% literal_value',
  );
  bus.store.append(b.id, 'user', b.lead, 'send', 'search other');
  let rows = searchWorkspace(bus, new URLSearchParams({ q: '100%' }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, message.id);
  assert.ok(rows[0].path.includes(message.id));
  assert.equal(
    searchWorkspace(bus, new URLSearchParams({ q: 'search', group: b.id }))
      .length,
    1,
  );
  assert.equal(
    searchWorkspace(bus, new URLSearchParams({ q: 'literal_' })).length,
    1,
  );
  assert.equal(
    searchWorkspace(
      bus,
      new URLSearchParams({ q: 'search', from: '2099-01-01' }),
    ).length,
    0,
  );
  assert.throws(
    () =>
      searchWorkspace(bus, new URLSearchParams({ q: 'search', from: 'oops' })),
    /日期/,
  );
  assert.deepEqual(searchWorkspace(bus, new URLSearchParams()), []);
  const workbench = homeWorkbench(bus);
  assert.ok(Array.isArray(workbench.running));
  assert.ok(Array.isArray(workbench.pending));
  assert.equal(workbench.summary, null);
});

test('workbench counts only unanswered interactions and retains the last completed summary', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'workbench-'));
  const bus = new Bus({
    directory,
    hosts: new Map([
      [
        'fake',
        {
          async run() {
            return 'ok';
          },
        },
      ],
    ]),
  });
  t.after(async () => {
    await bus.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  });
  const group = createTestGroup(bus, {
    name: 'team',
    workspace: directory,
    lead: { name: 'lead', host: 'fake' },
    members: [],
  });
  const created = new Date().toISOString();
  const lead = bus.members(group.id)[0];
  const conversation = bus.store.conversation('member', lead.id, 'coordination');
  bus.store.run(
    'INSERT INTO turns(id,conversation_id,executor_kind,executor_id,group_id,state,detail,created) VALUES(?,?,?,?,?,?,?,?)',
    'uncertain',
    conversation.id,
    'member',
    lead.id,
    group.id,
    'unknown',
    '核实宿主',
    created,
  );
  bus.store.run(
    'INSERT INTO panel_agents(id,name,host,created,updated) VALUES(?,?,?,?,?)',
    'panel-fixture',
    'Panel',
    'fake',
    created,
    created,
  );
  const agent = bus.panelAgent();
  const append = (id, role, text) =>
    bus.store.run(
      "INSERT INTO panel_messages(id,panel_agent_id,context,role,text,created) VALUES(?,?,'private',?,?,?)",
      id,
      agent.id,
      role,
      text,
      created,
    );
  append('summary-request', 'user', '[主页进展摘要]\n汇总团队');
  append('summary-reply', 'assistant', '已经完成 A');
  append('ordinary-request', 'user', '别的问题');
  append('ordinary-reply', 'assistant', '无关回答');
  append('summary-pending', 'user', '[主页进展摘要]\n再次汇总');
  const endpoint = bus.store.endpoint(group.lead, 'coordination');
  bus.store.run(
    'INSERT INTO outbox(id,conversation_id,payload,error) VALUES(?,?,?,?)',
    'failed-delivery',
    endpoint.id,
    '[]',
    'send error',
  );
  for (const text of ['merged input 1', 'merged input 2']) {
    const message = bus.store.append(
      group.id,
      'user',
      group.lead,
      'send',
      text,
    );
    bus.store.run(
      'INSERT INTO attached VALUES(?,?)',
      message.id,
      'failed-delivery',
    );
  }
  bus.store.run(
    `INSERT INTO interactions(id,group_id,member_id,conversation_id,context,turn_id,call_id,kind,payload,state,created) VALUES(?,?,?,?,'coordination','fixture-turn','fixture-call','choice',?,'pending',?)`,
    'confirmation',
    group.id,
    group.lead,
    endpoint.id,
    JSON.stringify({
      kind: 'choice',
      text: '请确认方案',
      options: ['同意', '拒绝'],
    }),
    created,
  );
  const withInteraction = homeWorkbench(bus);
  assert.equal(withInteraction.pending.length, 1);
  assert.equal(withInteraction.pending[0].id, 'confirmation');
  assert.equal(withInteraction.pending[0].interactionKind, 'choice');
  assert.equal(withInteraction.pending[0].senderName, 'lead');
  assert.equal(new URL(withInteraction.pending[0].path,'http://localhost').searchParams.has('session'),false);
  assert.equal(withInteraction.recent.find((row) => row.id === 'uncertain')?.detail, '核实宿主');
  bus.store.run(
    "UPDATE interactions SET state='answered' WHERE id='confirmation'",
  );
  const view = homeWorkbench(bus);
  assert.deepEqual(view.pending, []);
  assert.equal(view.summary.id, 'summary-reply');
  assert.equal(view.summary.text, '已经完成 A');
  assert.equal(view.summaryRequest.id, 'summary-pending');
  bus.store.run(
    "UPDATE turns SET state='stopped' WHERE id='uncertain'",
  );
  assert.ok(
    !homeWorkbench(bus).pending.some((item) => item.id === 'uncertain'),
  );
});

test('home summary uses the existing Panel Agent execution and survives a later query', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'home-summary-'));
  const host = {
    async run(context) {
      context.onSession('summary-session');
      context.onAccepted();
      return '本轮摘要：已完成验证。';
    },
  };
  const bus = new Bus({ directory, hosts: new Map([['fake', host]]) });
  t.after(async () => {
    await bus.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  });
  const created = new Date().toISOString();
  bus.store.run(
    'INSERT INTO panel_agents(id,name,host,created,updated) VALUES(?,?,?,?,?)',
    'panel-summary',
    'Panel',
    'fake',
    created,
    created,
  );
  const response = await bus.panelPrivateTurn({
    text: '[主页进展摘要]\n请只读总结。',
    clientMessageId: 'summary-test',
  });
  assert.equal(response.reply.role, 'assistant');
  assert.equal(homeWorkbench(bus).summary.text, '本轮摘要：已完成验证。');
  const replay = await bus.panelPrivateTurn({
    text: '[主页进展摘要]\n请只读总结。',
    clientMessageId: 'summary-test',
  });
  assert.equal(replay.result.replayed, true);
  assert.equal(homeWorkbench(bus).summary.id, response.reply.id);
});

test('workbench HTTP stays readable throughout Panel Agent summary generation', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'workbench-running-'));
  let release;
  let started;
  const accepted = new Promise((resolve) => {
    started = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const server = await startServer({
    directory,
    hosts: new Map([
      [
        'fake',
        {
          async run(context) {
            context.onSession('running-summary');
            context.onAccepted();
            context.onTextDelta('摘要第一段');
            started();
            await gate;
            return '摘要完成';
          },
        },
      ],
    ]),
  });
  const bus = server.bus;
  const abort = new AbortController();
  const responseStream = await fetch(`${server.url}api/panel-agent/events`, {
    signal: abort.signal,
  });
  const reader = responseStream.body.getReader();
  const decoder = new TextDecoder();
  let received = '';
  async function readUntil(pattern) {
    while (!pattern.test(received)) {
      const { value, done } = await reader.read();
      if (done) break;
      received += decoder.decode(value, { stream: true });
    }
    assert.match(received, pattern);
  }
  let pending;
  t.after(async () => {
    release();
    await pending?.catch(() => {});
    abort.abort();
    await server.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  });
  const created = new Date().toISOString();
  bus.store.run(
    'INSERT INTO panel_agents(id,name,host,created,updated) VALUES(?,?,?,?,?)',
    'panel-running',
    'Panel',
    'fake',
    created,
    created,
  );
  pending = fetch(`${server.url}api/panel-agent/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: '[主页进展摘要]\n请总结。',
      clientMessageId: 'running-summary',
    }),
  });
  await accepted;
  await readUntil(/"type":"delta".*"delta":"摘要第一段"/);
  assert.match(received, /"homeSummary":true/);
  assert.equal(bus.panelStreaming()[0].text, '摘要第一段');
  const reconnectAbort = new AbortController();
  const reconnect = await fetch(`${server.url}api/panel-agent/events`, {
    signal: reconnectAbort.signal,
  });
  const snapshot = await reconnect.body.getReader().read();
  assert.match(
    decoder.decode(snapshot.value),
    /"type":"snapshot".*"text":"摘要第一段"/,
  );
  reconnectAbort.abort();
  for (let index = 0; index < 3; index++) {
    const response = await fetch(`${server.url}api/workbench`);
    assert.equal(
      response.status,
      200,
      'summary generation must not break workbench polling',
    );
    const view = await response.json();
    assert.equal(view.running.length, 1);
    assert.equal(view.running[0].name, 'Panel');
    assert.equal(view.running[0].path, '/agent');
  }
  release();
  assert.equal((await pending).status, 200);
  await readUntil(/"type":"complete".*"text":"摘要完成"/);
  const settled = await fetch(`${server.url}api/workbench`);
  assert.equal(settled.status, 200);
  assert.equal((await settled.json()).summary.text, '摘要完成');
});

test('dismissing a team notification hides it from the panel list without touching the update log', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'productivity-notify-'));
  const bus = new Bus({ directory, hosts: new Map([['fake', { async run() { return 'ok'; } }]]) });
  t.after(async () => { await bus.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
  const group = createTestGroup(bus, { name: 'notify', workspace: directory, lead: { name: 'lead', host: 'fake' }, members: [] });
  const agentId = seedPanelAgent(bus);
  bus.store.run(
    `INSERT INTO panel_updates(id,panel_agent_id,group_id,text,created) VALUES(?,?,?,?,?)`,
    'update-1', agentId, group.id, '成员已完成本轮任务', new Date().toISOString(),
  );
  assert.ok(bus.panelAgentState().notifications.some(row => row.id === 'update-1'));

  assert.equal(dismissWorkbench(bus, [{ category: 'panel:update', id: 'update-1' }]).dismissed, 1);
  assert.equal(bus.panelAgentState().notifications.some(row => row.id === 'update-1'), false);
  assert.ok(panelAgg.updateById(bus.store, 'update-1'), '投递台账本身保留');
  assert.throws(() => dismissWorkbench(bus, [{ category: 'panel:update', id: 'gone' }]), /已失效/);
});

test('home summary runs in a fresh read-only session using the Panel Agent model without touching private session', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'home-summary-isolated-'));
  const observed = [];
  const host = {
    async run(context) {
      observed.push({
        context: context.endpoint.context,
        session: context.endpoint.session,
        modelSelection: context.modelSelection,
        tools: context.tools.map(tool => tool.name),
        policy: context.policy,
      });
      context.onSession(`ephemeral-${observed.length}`);
      context.onAccepted();
      context.onTextDelta('独立汇总');
      return `独立汇总 #${observed.length}`;
    },
  };
  const server = await startServer({ directory, hosts: new Map([['fake', host]]) });
  const bus = server.bus;
  t.after(async () => {
    await server.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* ignore */ }
  });
  const created = new Date().toISOString();
  bus.store.run(
    'INSERT INTO panel_agents(id,name,host,model_provider,model,reasoning_effort,created,updated) VALUES(?,?,?,?,?,?,?,?)',
    'panel-isolated', 'Panel', 'fake', 'prov-1', 'model-x', 'high', created, created,
  );
  // 模拟私聊会话上挂着一个已失效的旧宿主 session
  const privateSession = bus.store.conversation('panel_agent', 'panel-isolated', 'private');
  bus.store.setConversationSession(privateSession.id, 'stale-private-session');

  const first = await fetch(`${server.url}api/workbench/summary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).summary.text, '独立汇总 #1');

  const second = await fetch(`${server.url}api/workbench/summary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(second.status, 200);
  assert.equal((await second.json()).summary.text, '独立汇总 #2');

  // 两次汇总都复用 Panel Agent 的同模型配置，但每次均新建空宿主会话、仅开放只读工具。
  assert.equal(observed.length, 2);
  for (const call of observed) {
    assert.equal(call.context, 'home-summary');
    assert.equal(call.session, null);
    assert.deepEqual(call.modelSelection, { model_provider: 'prov-1', model: 'model-x', reasoning_effort: 'high' });
    assert.equal(call.policy.allowShell, false);
    assert.ok(call.tools.includes('teams_list'));
    assert.ok(call.tools.includes('team_read'));
    assert.equal(call.tools.includes('team_create'), false);
    assert.equal(call.tools.includes('ask'), false);
  }
  // 私聊消息流未被摘要污染，工作台直接读取最新独立摘要。
  assert.equal(bus.panelAgentState().conversation.length, 0);
  const workbench = await (await fetch(`${server.url}api/workbench`)).json();
  assert.equal(workbench.summary.text, '独立汇总 #2');
});

test('turn executor does not persist a ghost session when a host fails before acceptance and panel reset clears stale bindings', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'turn-ghost-session-'));
  let failBeforeAccept = true;
  const seenSessions = [];
  const host = {
    async run(context) {
      seenSessions.push(context.endpoint.session ?? null);
      if (failBeforeAccept) {
        context.onSession('ghost-session-id');
        throw new Error('init failed before accept');
      }
      context.onSession(`real-session-${seenSessions.length}`);
      context.onAccepted();
      return '正常回复';
    },
  };
  const server = await startServer({ directory, hosts: new Map([['fake', host]]) });
  const bus = server.bus;
  t.after(async () => {
    await server.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* ignore */ }
  });
  const created = new Date().toISOString();
  bus.store.run(
    'INSERT INTO panel_agents(id,name,host,created,updated) VALUES(?,?,?,?,?)',
    'panel-ghost', 'Panel', 'fake', created, created,
  );

  // 第一次：宿主在 onAccepted 之前调了 onSession 但报错 -> 不得落盘幽灵 session。
  await assert.rejects(
    bus.panelPrivateTurn({ text: '第一次尝试', clientMessageId: 'm-1' }),
    /init failed before accept/,
  );
  assert.equal(bus.panelAgentState().sessions.find(s => s.context === 'private')?.session ?? null, null);

  // 第二次：正常入队完成 -> 此时才持久化真实 session。
  failBeforeAccept = false;
  await bus.panelPrivateTurn({ text: '第二次成功', clientMessageId: 'm-2' });
  assert.deepEqual(seenSessions, [null, null]);
  assert.equal(bus.panelAgentState().sessions.find(s => s.context === 'private')?.session, 'real-session-2');

  // 通过 HTTP 重置私聊会话 -> 清空宿主绑定但保留聊天记录，下一条以 null 开启新会话。
  const reset = await fetch(`${server.url}api/panel-agent/reset-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(reset.status, 200);
  assert.equal((await reset.json()).reset, true);
  assert.equal(bus.panelAgentState().sessions.find(s => s.context === 'private')?.session ?? null, null);
  assert.ok(bus.panelAgentState().conversation.length >= 2);

  await bus.panelPrivateTurn({ text: '重置后的第一条', clientMessageId: 'm-3' });
  assert.deepEqual(seenSessions, [null, null, null]);
});

test('workbench and search resolve external principals as external_agent identities', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'productivity-external-'));
  const bus = new Bus({
    directory,
    hosts: new Map([['fake', { async run() { return 'ok'; } }]]),
  });
  t.after(async () => {
    await bus.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  });
  const group = createTestGroup(bus, {
    name: 'external identities',
    workspace: directory,
    lead: { name: 'lead', host: 'fake' },
    members: [],
  });
  const created = new Date().toISOString();
  insertPrincipal(bus.store, { id: 'external-1', name: '外部主控甲', created });

  // 搜索:外部主控发出的消息展示 principal 名称而非裸 id。
  const externalMessage = bus.store.append(group.id, 'external-1', group.lead, 'send', '外部主控下发的调度指令');
  const found = searchWorkspace(bus, new URLSearchParams({ q: '调度指令' }));
  assert.equal(found.length, 1);
  assert.equal(found[0].id, externalMessage.id);
  assert.equal(found[0].senderName, '外部主控甲');

  // 等待用户回复:收件人为外部主控。
  const toExternal = bus.store.append(group.id, 'user', 'external-1', 'send', '请确认外部主控状态');
  // Agent 间请求:外部主控显式声明需要回复。
  const externalRequest = bus.store.append(group.id, 'external-1', group.lead, 'send', '请外部协作方回复', null, true);

  const workbench = homeWorkbench(bus, { now: Date.now() + 10 * 60 * 1000 });
  const waiting = workbench.waiting.find(row => row.id === toExternal.id);
  assert.equal(waiting.recipientName, '外部主控甲');
  assert.equal(waiting.recipientKind, 'external_agent');
  const agentWaiting = workbench.agentWaiting.find(row => row.id === externalRequest.id);
  assert.equal(agentWaiting.senderName, '外部主控甲');
  assert.equal(agentWaiting.senderKind, 'external_agent');
  assert.equal(agentWaiting.recipientName, 'lead');
  assert.equal(agentWaiting.recipientKind, 'member');
});
