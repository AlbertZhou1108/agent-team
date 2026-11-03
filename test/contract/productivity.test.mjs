import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../src/server.mjs';
import { Bus } from '../../src/bus.mjs';
import { createTestGroup } from '../support/fixture.mjs';
import { homeWorkbench, searchWorkspace } from '../../src/productivity.mjs';

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
    rmSync(directory, { recursive: true, force: true });
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
    rmSync(directory, { recursive: true, force: true });
  });
  const group = createTestGroup(bus, {
    name: 'team',
    workspace: directory,
    lead: { name: 'lead', host: 'fake' },
    members: [],
  });
  const created = new Date().toISOString();
  bus.store.run(
    'INSERT INTO runtime_attempts(turn_id,group_id,endpoint_id,state,policy,created,detail) VALUES(?,?,?,?,?,?,?)',
    'uncertain',
    group.id,
    'endpoint',
    'unknown',
    '{}',
    created,
    '核实宿主',
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
    'INSERT INTO outbox(id,endpoint_id,payload,error) VALUES(?,?,?,?)',
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
    `INSERT INTO interactions(id,group_id,member_id,endpoint_id,context,turn_id,call_id,kind,payload,state,created) VALUES(?,?,?,?,'coordination','fixture-turn','fixture-call','choice',?,'pending',?)`,
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
  assert.equal(new URL(withInteraction.pending[0].path,'http://localhost').searchParams.has('session'),false);
  bus.store.run(
    "UPDATE interactions SET state='answered' WHERE id='confirmation'",
  );
  const view = homeWorkbench(bus);
  assert.deepEqual(view.pending, []);
  assert.equal(view.summary.id, 'summary-reply');
  assert.equal(view.summary.text, '已经完成 A');
  assert.equal(view.summaryRequest.id, 'summary-pending');
  bus.store.run(
    "UPDATE runtime_attempts SET state='stopped' WHERE turn_id='uncertain'",
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
    rmSync(directory, { recursive: true, force: true });
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
    rmSync(directory, { recursive: true, force: true });
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
