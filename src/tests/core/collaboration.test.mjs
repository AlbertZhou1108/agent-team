import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { runJsonProcess } from '../../host-runtime/process.mjs';
import { createClaudeHost, readClaudeSessionMetadata } from '../../hosts/cli-hosts.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../../bus.mjs';
import { resolvePanelFile, startServer } from '../../server.mjs';
import { rpc } from '../../rpc.mjs';
import { busScenario, createTestGroup, seedPanelAgent } from '../support/fixture.mjs';
import * as messagesAgg from '../../aggregates/messages.mjs';
import * as turnsAgg from '../../aggregates/turns.mjs';
import * as teamsAgg from '../../aggregates/teams.mjs';
import { modelCatalog } from '../../hosts/catalog.mjs';
import { until } from '../support/wait.mjs';

describe('core', () => {
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(fn) { const end = Date.now() + 2500; while (!fn()) { if (Date.now() > end) throw new Error('condition timed out'); await new Promise(resolve => setTimeout(resolve, 10)); } }
function fixture(t, run) {
  return busScenario(t, { run });
}
function tools(bus, member) { const e = bus.store.endpoint(member.id, member.role === 'lead' ? 'coordination' : 'pair:test'); return (name, args = {}) => bus.tool(e.id, e.key, name, args); }

test('notes wait; next formal message carries notes from another sender exactly once', async t => {
  const { bus, members, calls } = fixture(t); const [lead, one, two] = members;
  await until(() => bus.running.size === 0);
  await tools(bus, two)('note', { to: lead.id, text: 'third-party note' }); await tick();
  assert.equal(calls.filter(c => c.endpoint.context.startsWith('pair:')).length, 0);
  const sent = await tools(bus, one)('send', { to: lead.id, text: 'formal' });
  await until(() => calls.some(c => c.endpoint.context === 'coordination')); await until(() => bus.running.size === 0);
  const payload = JSON.parse(messagesAgg.deliveries(bus.store)[0].payload);
  assert.equal(payload.message.id, sent.messageId); assert.equal(payload.notes.length, 1); assert.equal(payload.notes[0].sender, two.id);
  await tools(bus, one)('send', { to: lead.id, text: 'second formal' }); await until(() => messagesAgg.deliveries(bus.store).length === 2); await until(() => bus.running.size === 0);
  assert.equal(JSON.parse(messagesAgg.deliveries(bus.store)[1].payload).notes.length, 0);
  assert.equal(messagesAgg.byGroup(bus.store, lead.group_id).filter(message => /host final/i.test(message.text)).length, 0);
});

test('different peers get separate recipient contexts and may run concurrently', async t => {
  const { bus, members, calls } = fixture(t, ctx => new Promise((resolve, reject) => { ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); }));
  const [lead, one, two] = members;
  await until(() => bus.running.size === 0);
  await tools(bus, lead)('send', { to: one.id, text: 'a' });
  await tools(bus, two)('send', { to: one.id, text: 'b' });
  await until(() => bus.running.size === 2);
  const endpoints = calls.filter(c => c.endpoint.member_id === one.id && c.endpoint.context.startsWith('pair:')).map(c => c.endpoint);
  assert.equal(endpoints.length, 2); assert.notEqual(endpoints[0].id, endpoints[1].id);
});

test('reused member sessions receive the previous policy in the host contract shape', async t => {
  const previousPolicies = [];
  const { bus, members } = fixture(t, async ctx => {
    previousPolicies.push(ctx.previousPolicy);
    if (previousPolicies.length === 1) {
      assert.equal(ctx.previousPolicy, null);
      ctx.onPolicy?.({ signature: 'policy-signature' });
    } else {
      assert.deepEqual(ctx.previousPolicy, { signature: 'policy-signature' });
    }
    ctx.onAccepted();
    return `turn-${previousPolicies.length}`;
  });
  const [lead, one] = members;
  await until(() => bus.running.size === 0);
  const endpoint = bus.store.endpoint(one.id, `pair:${lead.id}`, lead.id);
  await bus.runEndpoint(endpoint, 'first');
  await bus.runEndpoint(endpoint, 'second');
  assert.equal(previousPolicies.length, 2);
});

test('messages accumulated within one busy pair become one ordered next input', async t => {
  let release;
  const { bus, members } = fixture(t, ctx => new Promise(resolve => { release = () => { ctx.onAccepted(); resolve('done'); }; }));
  const [lead, one] = members;
  await until(() => bus.running.size === 0);
  await tools(bus, lead)('send', { to: one.id, text: 'first' });
  await until(() => release);
  await tools(bus, lead)('send', { to: one.id, text: 'second' });
  await tools(bus, lead)('send', { to: one.id, text: 'third' });
  assert.equal(messagesAgg.deliveries(bus.store).length, 1);
  release(); await until(() => messagesAgg.deliveries(bus.store).length === 2);
  const input = JSON.parse(messagesAgg.deliveries(bus.store)[1].payload);
  assert.equal(input.message.text, 'second'); assert.deepEqual(input.additionalMessages.map(m => m.text), ['third']);
  release(); await until(() => bus.running.size === 0);
  assert.equal(messagesAgg.deliveries(bus.store).length, 2);
});

test('identity cannot be supplied, member profiles are self-only, cross-group addressing is rejected', async t => {
  const { bus, members, group, directory } = fixture(t); const [lead, one] = members;
  await until(() => bus.running.size === 0);
  await assert.rejects(tools(bus, one)('profile_set', { text: 'spoof', member: lead.id }), /不允许/);
  await assert.rejects(tools(bus, one)('profile_set', JSON.parse('{"text":"spoof","constructor":"pretend"}')), /不允许/);
  await assert.rejects(tools(bus, one)('group_remove', { member: lead.id }), /不可使用/);
  await tools(bus, one)('profile_set', { text: 'own profile' });
  assert.equal(bus.store.member(one.id).profile, 'own profile'); assert.equal(bus.store.member(lead.id).profile, 'I can help.');
  const other = createTestGroup(bus, { name: 'other', workspace: directory, lead: { name: 'other', host: 'fake' } });
  await assert.rejects(tools(bus, one)('send', { to: other.lead, text: 'cross-group' }), /找不到/);
  const e = bus.store.endpoint(lead.id, 'private');
  await assert.rejects(bus.tool(e.id, 'wrong', 'members', {}), /来源无效/);
  assert.equal(bus.members(group.id).length, 3);
});

test('removal immediately revokes all endpoint access and retains message identity', async t => {
  const { bus, members, group } = fixture(t); const [lead, one] = members;
  await until(() => bus.running.size === 0);
  const call = tools(bus, one);
  await call('note', { to: lead.id, text: 'retained' });
  await bus.removeMember(group.id, one.id);
  for (const [name, args] of [['members', {}], ['read', {}], ['profile_set', { text: 'no' }], ['send', { to: lead.id, text: 'no' }]]) await assert.rejects(call(name, args), /已移除/);
  assert.equal(messagesAgg.byGroup(bus.store, group.id)[0].sender, one.id);
});

test('private user input and final text are absent from shared records and panel snapshot', async t => {
  const { bus, group } = fixture(t); await until(() => bus.running.size === 0);
  await bus.privateTurn(group.id, 'PRIVATE_SENTINEL_182');
  assert.equal(messagesAgg.byGroup(bus.store, group.id).filter(message => message.text.includes('PRIVATE_SENTINEL')).length, 0);
  assert.equal(turnsAgg.historyEvents(bus.store).filter(row => row.event.includes('PRIVATE_SENTINEL')).length, 0);
  const snapshot = JSON.stringify(bus.snapshot()); assert.ok(!snapshot.includes('private')); assert.ok(!snapshot.includes('"key"'));
});

test('ordinary failure is recorded without a notice and does not automatically retry', async t => {
  let attempts = 0;
  const { bus, members } = fixture(t, async () => { attempts++; throw new Error('host unavailable'); });
  const [lead, one] = members; await until(() => bus.running.size === 0);
  await tools(bus, lead)('send', { to: one.id, text: 'delivery' });
  await until(() => bus.store.get('SELECT error FROM outbox')?.error);
  bus.pump(); await tick(); assert.equal(attempts, 1);
  // 失败已在 outbox 留痕、且不会自己重投；消息流里不再补一条系统通知（状态看回执）。
  assert.equal(messagesAgg.byGroup(bus.store, lead.group_id).filter(message => message.sender === 'system').length, 0);
});

test('restart recovers identical persisted input with stable message and note ids', async t => {
  const { bus, members, directory } = fixture(t, ctx => new Promise((resolve, reject) => { ctx.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }); }));
  const [lead, one, two] = members; await until(() => bus.running.size === 0);
  await tools(bus, two)('note', { to: one.id, text: 'keep me' });
  await tools(bus, lead)('send', { to: one.id, text: 'recover' });
  await until(() => messagesAgg.deliveries(bus.store)[0]?.payload);
  const before = messagesAgg.deliveries(bus.store)[0].payload;
  await bus.close();
  let received;
  const restarted = new Bus({ directory, hosts: new Map([['fake', { async run(ctx) { received = ctx.prompt; ctx.onAccepted(); return 'done'; } }]]) });
  t.after(async () => { if (!restarted.closing) await restarted.close(); });
  restarted.start(); await tick();
  assert.equal(received, undefined, '重启不应自动恢复已中断输入');
  restarted.retry(JSON.parse(before).groupId);
  await until(() => messagesAgg.deliveries(restarted.store)[0]?.accepted);
  assert.equal(messagesAgg.deliveries(restarted.store)[0].payload, before);
  assert.ok(received.includes(JSON.parse(before).message.id));
  // Close before the fixture removes its directory.
  await restarted.close();
});

test('HTTP panel needs no key or cookie, rejects DNS rebinding and paginates records', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-panel-test-'));
  const server = await startServer({ directory, hosts: new Map([['fake', { async run(ctx) { ctx.onAccepted(); return 'done'; } }]]) });
  t.after(async () => { await server.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
  const base = new URL(server.url).origin;
  const entry = await fetch(server.url, { redirect: 'manual' });
  assert.equal(entry.status, 200);
  assert.equal(entry.headers.get('set-cookie'), null);
  assert.equal(new URL(server.url).search, '');
  const headers = {};
  assert.equal((await fetch(base + '/api/snapshot', { headers })).status, 200);
  assert.equal((await fetch(base + '/api/snapshot', { headers, method: 'POST' })).status, 403);
  const rebinding = await new Promise((resolve, reject) => { const request = http.get(base + '/api/snapshot', { headers: { ...headers, host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); }); request.on('error', reject); });
  assert.equal(rebinding, 403);
  const group = await rpc(server.socketPath, { op: 'new', args: { name: 'panel', workspace: directory, lead: { name: 'lead', host: 'fake' } } });
  for (let i = 0; i < 205; i++) server.bus.store.append(group.id, 'system', group.lead, 'system', `notice-${i}`);
  const first = await (await fetch(base + `/api/messages?group=${group.id}`, { headers })).json(); assert.equal(first.length, 200);
  const second = await (await fetch(base + `/api/messages?group=${group.id}&after=${first.at(-1).seq}`, { headers })).json(); assert.equal(second.length, 5);
  // 消息带上产出它的回合:前端按回合去重行内轨迹,一个回合只渲染一份。
  assert.equal(first[0].turn_id, null, '系统通知没有产出回合');
  const produced = server.bus.store.get('SELECT id,seq FROM messages WHERE group_id=? ORDER BY seq LIMIT 1', group.id);
  server.bus.store.run(
    "INSERT INTO turns(id,conversation_id,executor_kind,executor_id,group_id,state,created) VALUES('trace-turn',(SELECT id FROM conversations WHERE group_id=? LIMIT 1),'member',?,?, 'completed',?)",
    group.id, group.lead, group.id, new Date().toISOString(),
  );
  server.bus.store.run('INSERT INTO message_origins(message_id,turn_id,call_id) VALUES(?,?,?)', produced.id, 'trace-turn', 'call-1');
  const withTurn = await (await fetch(base + `/api/messages?group=${group.id}&after=${produced.seq - 1}`, { headers })).json();
  assert.equal(withTurn.find(row => row.id === produced.id)?.turn_id, 'trace-turn');
  assert.equal(resolvePanelFile('/groups/example', 'text/html').type, 'text/html');
  assert.equal(resolvePanelFile('/groups/example', 'application/json'), null);
  assert.equal(resolvePanelFile('/assets/missing.js', 'text/javascript').type, 'text/javascript');
  assert.equal(resolvePanelFile('/assets/../../package.json', 'text/html'), null);
});

test('local panel rejects cross-site and cross-origin requests without cookie authentication', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-panel-no-auth-'));
  const server = await startServer({
    directory,

    hosts: new Map([['fake', { async run(ctx) { ctx.onAccepted(); return 'done'; } }]]),
  });
  t.after(async () => { await server.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
  const base = new URL(server.url).origin;
  assert.equal((await fetch(base + "/api/snapshot", { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
  assert.equal((await fetch(base + "/api/model-policy", { method: "POST", headers: { Origin: "http://localhost:9999", "Content-Type": "application/json" }, body: "{}" })).status, 403);
  assert.equal(server.url, `${base}/`);
  assert.equal((await fetch(base + '/api/snapshot')).status, 200);
  assert.equal((await fetch(base + '/api/snapshot', { method: 'POST' })).status, 403);
  const rebinding = await new Promise((resolve, reject) => {
    const request = http.get(base + '/api/snapshot', { headers: { host: 'attacker.example' } }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on('error', reject);
  });
  assert.equal(rebinding, 403);
});

test('second bus cannot open the same data directory', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-lock-test-'));
  const server = await startServer({ directory, hosts: new Map() });
  t.after(async () => { await server.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
  await assert.rejects(startServer({ directory, hosts: new Map() }), /已有群总线/);
});

test('group deletion removes framework records and leaves shared files untouched', async t => {
  const { bus, members, group, directory } = fixture(t); await until(() => bus.running.size === 0);
  const file = join(directory, 'shared-code.txt'); writeFileSync(file, 'keep');
  await tools(bus, members[0])('note', { to: members[1].id, text: 'delete records' });
  await bus.deleteGroup(group.id);
  assert.equal(messagesAgg.byGroup(bus.store, group.id).length, 0);
  assert.equal(teamsAgg.activeMembers(bus.store, group.id).length, 0);
  assert.equal(readFileSync(file, 'utf8'), 'keep');
});

test('RPC rejects a connection closed before a reply rather than hanging', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-rpc-test-')), socketPath = (await import('../../server.mjs')).socketFor(directory);
  const server = net.createServer(socket => { socket.on('data', () => socket.destroy()); });
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
  await assert.rejects(rpc(socketPath, { op: 'ping' }), /断开连接/);
});

test('CLI process driver observes real output and responds to cancellation', async () => {
  const abort = new AbortController();
  let observed = false;
  const running = runJsonProcess(process.execPath, ['-e', 'console.log(JSON.stringify({type:"started"}));setInterval(()=>{},1000)'], {
    workspace: tmpdir(), signal: abort.signal,
    onEvent(event) { observed = event.type === 'started'; },
    onRow() { abort.abort(); },
  });
  await assert.rejects(running, /中断/);
  assert.ok(observed);
});

test('message provenance anchors distinct sends to one turn and rejects stale or model supplied identity', async t => {
  const { bus, members } = fixture(t, async ctx => {
    ctx.onNativeTurn('native-turn-7');
    await ctx.onTool('note', { to: members[1].id, text: 'first' }, { nativeCallId: 'native-call-1' });
    await ctx.onTool('note', { to: members[1].id, text: 'second' });
    ctx.onAccepted(); return 'final-result';
  });
  await until(() => bus.running.size === 0);
  const endpoint = bus.store.endpoint(members[0].id, `pair:${members[1].id}`, members[1].id);
  await bus.runEndpoint(endpoint, 'public input');
  const messages = bus.store.all("SELECT * FROM messages WHERE kind='note'");
  const first = bus.store.messageTrace(messages[0].id), second = bus.store.messageTrace(messages[1].id);
  assert.equal(first.source.turnId, second.source.turnId);
  assert.notEqual(first.source.eventSeq, second.source.eventSeq);
  assert.notEqual(first.source.callId, second.source.callId);
  assert.equal(first.source.nativeCallId, 'native-call-1');
  const trace = bus.store.turnTrace(first.source.turnId);
  assert.deepEqual(trace.nativeTurnRefs, ['native-turn-7']);
  assert.equal(trace.outgoingMessages.length, 2);
  assert.ok(trace.events.every(row => row.turn_id === first.source.turnId));
  assert.equal(JSON.parse(trace.events.find(row => row.seq === first.source.eventSeq).event).name, 'note');
  assert.ok(trace.events.some(row => JSON.parse(row.event).text === 'final-result'));
  await assert.rejects(bus.tool(endpoint.id, endpoint.key, 'members', {}, { turnId: first.source.turnId }), /当前执行回合/);
  await assert.rejects(bus.tool(endpoint.id, endpoint.key, 'members', { turnId: first.source.turnId }), /不允许/);
});

test('failed input retry has distinct attempts with the same formal and note ids', async t => {
  let fail = true;
  const { bus, members, group } = fixture(t, async ctx => { if (fail) throw new Error('retry-test'); ctx.onAccepted(); return 'ok'; });
  await until(() => bus.running.size === 0);
  const note = await tools(bus, members[2])('note', { to: members[1].id, text: 'attached' });
  const sent = await tools(bus, members[0])('send', { to: members[1].id, text: 'formal' });
  await until(() => bus.store.get('SELECT error FROM outbox')?.error);
  fail = false; bus.retry(group.id);
  await until(() => bus.running.size === 0 && bus.store.get('SELECT accepted FROM outbox')?.accepted);
  const attempts = bus.store.messageTrace(sent.messageId).inputAttempts;
  assert.equal(attempts.length, 2); assert.notEqual(attempts[0].id, attempts[1].id);
  assert.equal(bus.store.messageTrace(note.messageId).inputAttempts.length, 2);
  for (const attempt of attempts) assert.deepEqual(bus.store.turnTrace(attempt.id).inputMessages.map(row => row.id), [sent.messageId, note.messageId]);
  assert.ok(bus.store.turnTrace(attempts[0].id).events.some(row => JSON.parse(row.event).type === 'framework.error'));
  assert.ok(bus.store.turnTrace(attempts[1].id).events.some(row => JSON.parse(row.event).type === 'framework.input_accepted'));
});

test('private conversation cannot dispatch; explicitly shared user directive has observable receiving turn', async t => {
  let privateTurn;
  const { bus, members, group } = fixture(t, async ctx => {
    if (ctx.endpoint.context === 'private') {
      privateTurn = ctx.turnId;
      await assert.rejects(ctx.onTool('send', { to: members[1].id, text: 'public-message' }), /不可使用/);
    }
    ctx.onAccepted(); return 'PRIVATE_FINAL';
  });
  await until(() => bus.running.size === 0);
  await bus.privateTurn(group.id, 'PRIVATE_INPUT');
  bus.directive(group.id, 'public-message');
  await until(() => {
    const row = bus.store.get("SELECT * FROM messages WHERE kind='send'");
    return row ? bus.store.messageTrace(row.id).inputAttempts.length >= 1 : false;
  });
  await until(() => bus.running.size === 0);
  const message = bus.store.get("SELECT * FROM messages WHERE kind='send'");
  const trace = bus.store.messageTrace(message.id);
  assert.deepEqual(trace.source, { kind: 'unknown' });
  assert.equal(trace.inputAttempts.length, 1);
  assert.equal(bus.store.turnTrace(privateTurn), null);
  assert.ok(!JSON.stringify(trace).includes(privateTurn));
  assert.equal(turnsAgg.historyEvents(bus.store, { turnId: privateTurn }).length, 0);
  assert.ok(!JSON.stringify(message).includes(privateTurn));
});

test('legacy database migrates additively and remains unknown across reopen', async t => {
  const { Store } = await import('../../store.mjs');
  const directory = mkdtempSync(join(tmpdir(), 'agent-migration-'));
  t.after(() => { try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ } });
  let store = new Store(directory);
  store.run('INSERT INTO groups(id,name,workspace,lead,created) VALUES(?,?,?,?,?)', 'g', 'legacy', directory, null, 'old');
  store.run('INSERT INTO members(id,group_id,name,host,role) VALUES(?,?,?,?,?)', 'm', 'g', 'old', 'fake', 'lead');
  const endpoint = store.endpoint('m', 'profile');
  const message = store.append('g', 'm', 'm', 'note', 'legacy-text');
  store.history(endpoint.id, { type: 'legacy-event' });
  store.close();
  for (let i = 0; i < 2; i++) {
    store = new Store(directory);
    assert.equal(messagesAgg.textOf(store, message.id), 'legacy-text');
    assert.equal(turnsAgg.historyEvents(store)[0].turn_id, null);
    assert.deepEqual(store.messageTrace(message.id).source, { kind: 'unknown' });
    store.close();
  }
});

test('trace HTTP API paginates one turn and denies private and missing turns equally', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-trace-api-'));
  const server = await startServer({ directory, hosts: new Map([['fake', { async run(ctx) {
    if (ctx.endpoint.context === 'profile') await ctx.onTool('profile_set', { text: 'ready' });
    ctx.onModel({ phase: 'session', model: 'test-model', reasoningEffort: 'low', source: 'test' });
    for (let i = 0; i < 205; i++) ctx.onEvent({ type: 'step', i });
    ctx.onAccepted(); return 'done';
  } }]]) });
  t.after(async () => { await server.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
  const group = createTestGroup(server.bus, { name: 'trace', workspace: directory, lead: { name: 'lead', host: 'fake' } });
  await until(() => server.bus.running.size === 0);
  await server.bus.privateTurn(group.id, 'secret');
  const privateId = server.bus.store.get("SELECT t.id FROM turns t JOIN conversations e ON e.id=t.conversation_id WHERE e.context='private'").id;
  const publicId = server.bus.store.get("SELECT t.id FROM turns t JOIN conversations e ON e.id=t.conversation_id WHERE e.context='profile'").id;
  const publicEndpoint = server.bus.store.get('SELECT conversation_id AS endpoint_id FROM turns WHERE id=?', publicId).endpoint_id;
  const privateEndpoint = server.bus.store.get('SELECT conversation_id AS endpoint_id FROM turns WHERE id=?', privateId).endpoint_id;
  const headers = {}, base = new URL(server.url).origin;
  for (const id of [privateId, 'missing']) assert.equal((await fetch(`${base}/api/turn?turn=${id}`, { headers })).status, 404);
  const first = await (await fetch(`${base}/api/turn?turn=${publicId}`, { headers })).json();
  assert.equal(first.events.length, 200);
  // 宿主随回合返回:前端据此选择事件 schema,不需要另查会话列表。
  assert.equal(first.turn.host, 'fake');
  // 事件按页返回,回合级事实必须单独给出,否则长回合的用时/状态无从判断。
  assert.ok(first.eventCount > first.events.length, 'eventCount 应大于单页事件数');
  assert.equal(first.turn.state, 'completed');
  assert.ok(first.turn.ended);
  assert.deepEqual(first.modelObservations.map(event => event.model), ['test-model']);
  assert.equal(first.currentModel.model, 'test-model');
  assert.equal(first.currentReasoningEffort.reasoningEffort, 'low');
  const models = await (await fetch(`${base}/api/models?endpoint=${publicEndpoint}`, { headers })).json();
  assert.equal(models.currentModel.model, 'test-model');
  assert.equal(models.currentReasoningEffort.reasoningEffort, 'low');
  assert.equal(models.observations.length, 1);
  assert.equal((await fetch(`${base}/api/models?endpoint=${privateEndpoint}`, { headers })).status, 404);
  const next = await (await fetch(`${base}/api/turn?turn=${publicId}&after=${first.nextAfter}`, { headers })).json();
  assert.ok(next.events.length > 0); assert.ok(next.events.every(row => row.seq > first.nextAfter));
  const message = server.bus.store.append(group.id, 'system', group.lead, 'system', 'notice');
  const trace = await (await fetch(`${base}/api/message-trace?message=${message.id}`, { headers })).json();
  assert.deepEqual(trace.source, { kind: 'system' });
  // Panel 私聊消息不在 messages 表:按 private 语义返回 200(无可用轨迹),未知 ID 仍 404
  const now = new Date().toISOString();
  server.bus.store.run("INSERT INTO panel_agents(id,name,host,created,updated) VALUES('panel-trace-probe','Panel','fake',?,?)", now, now);
  const panelMessage = server.bus.store.panelAppend('panel-trace-probe', 'private', 'assistant', 'private reply', null);
  const panelTrace = await (await fetch(`${base}/api/message-trace?message=${panelMessage.id}`, { headers })).json();
  assert.deepEqual(panelTrace.source, { kind: 'private' });
  assert.equal(panelTrace.inputAttempts.length, 0);
  assert.equal((await fetch(`${base}/api/message-trace?message=missing-id`, { headers })).status, 404);
  await server.bus.deleteGroup(group.id);
  assert.equal(turnsAgg.list(server.bus.store).length, 0);
  assert.equal(turnsAgg.historyEvents(server.bus.store).length, 0);
});

test('turn summaries API paginates whole turns oldest-first with stable ordinals', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-turns-api-'));
  const server = await startServer({ directory, hosts: new Map([['fake', { async run(ctx) { ctx.onAccepted(); return 'done'; } }]]) });
  t.after(async () => { await server.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
  const group = createTestGroup(server.bus, { name: 'turns', workspace: directory, lead: { name: 'lead', host: 'fake' } });
  await until(() => server.bus.running.size === 0);
  await server.bus.privateTurn(group.id, 'secret');
  const privateEndpoint = server.bus.store.get("SELECT conversation_id AS id FROM turns t JOIN conversations e ON e.id=t.conversation_id WHERE e.context='private'").id;
  const endpoint = server.bus.store.get("SELECT id FROM conversations WHERE group_id=? AND context='profile'", group.id).id;
  const store = server.bus.store;
  // 7 个回合,每回合两条事件,外加一条无回合归属的游离事件。
  for (let i = 0; i < 7; i++) {
    const created = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();
    const state = i === 1 ? 'failed' : 'completed';
    store.run("INSERT INTO turns(id,conversation_id,executor_kind,executor_id,group_id,state,created) VALUES(?,?, 'member',?,?,?,?)", `turn-${i}`, endpoint, group.lead, group.id, state, created);
    store.run('INSERT INTO history(conversation_id,event,created,turn_id) VALUES(?,?,?,?)', endpoint, JSON.stringify({ type: 'framework.output', i }), created, `turn-${i}`);
    const secondEvent = i === 1
      ? { type: 'framework.error', error: '/tmp/app.mjs:1\nError: ERR_MODULE_NOT_FOUND: agent-team-policy' }
      : { type: 'framework.output', i: i + 100 };
    store.run('INSERT INTO history(conversation_id,event,created,turn_id) VALUES(?,?,?,?)', endpoint, JSON.stringify(secondEvent), created, `turn-${i}`);
  }
  store.run('INSERT INTO history(conversation_id,event,created,turn_id) VALUES(?,?,?,NULL)', endpoint, JSON.stringify({ type: 'framework.session_rotated' }), new Date(Date.UTC(2026, 0, 1, 2)).toISOString());
  const headers = {}, base = new URL(server.url).origin;
  for (const id of [privateEndpoint, 'missing']) assert.equal((await fetch(`${base}/api/turns?endpoint=${id}`, { headers })).status, 404);
  const first = await (await fetch(`${base}/api/turns?endpoint=${endpoint}`, { headers })).json();
  assert.equal(first.turns.length, 5);
  // 从第一回合起正序展示:首页是最旧的 5 个;序号从全会话最旧数起,不随分页漂移。
  assert.equal(first.turns[0].id, 'turn-0');
  assert.equal(first.turns[0].ordinal, 1);
  assert.equal(first.turns[0].eventCount, 2);
  assert.ok(first.turns[0].firstSeq > 0);
  assert.ok(first.turns[0].firstSeq < first.turns[0].lastSeq);
  // 摘要不携带事件体:事件懒加载走 /api/turn。
  assert.equal(first.turns[0].events, undefined);
  assert.equal(first.turns[0].errorSummary, undefined);
  assert.equal(first.turns[1].errorSummary, 'Error: ERR_MODULE_NOT_FOUND: agent-team-policy');
  assert.ok(first.unaffiliated.some(row => JSON.parse(row.event).type === 'framework.session_rotated'), '游离事件应随摘要返回');
  // 还有更多才给游标,游标指向本页最后一回合(加载靠后的回合,不是倒着查)。
  assert.equal(first.nextAfter, 'turn-4');
  const second = await (await fetch(`${base}/api/turns?endpoint=${endpoint}&after=${encodeURIComponent(first.nextAfter)}`, { headers })).json();
  // 8 个回合(7 手插 + 1 建群自述):第二页是剩下的 3 个最新回合。
  assert.equal(second.turns.length, 3);
  assert.equal(second.nextAfter, null);
  assert.equal(second.turns[0].id, 'turn-5');
  assert.equal(second.turns[0].ordinal, 6);
  assert.notEqual(second.turns.at(-1).id, 'turn-6');
  // limit 钳制 1–50,越界回落默认 5。
  assert.equal((await (await fetch(`${base}/api/turns?endpoint=${endpoint}&limit=2`, { headers })).json()).turns.length, 2);
  assert.equal((await (await fetch(`${base}/api/turns?endpoint=${endpoint}&limit=999`, { headers })).json()).turns.length, 5);
  // 恰好取完整页时不给幻影游标:8 个回合按 limit=8 取,不应再提示"加载更多"。
  const exact = await (await fetch(`${base}/api/turns?endpoint=${endpoint}&limit=8`, { headers })).json();
  assert.equal(exact.turns.length, 8);
  assert.equal(exact.nextAfter, null);
  await server.bus.deleteGroup(group.id);
  assert.equal((await fetch(`${base}/api/turns?endpoint=${endpoint}`, { headers })).status, 404);
});

test('Claude adapter records requested, session, live model changes and verified effort', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-claude-model-'));
  const configDirectory = join(directory, 'claude-config');
  const fake = join(directory, 'fake-claude.mjs');
  const sessionId = '11111111-2222-4333-8444-555555555555';
  writeFileSync(fake, `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (!args.includes('--include-partial-messages')) throw new Error('partial messages are required');
const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
const effort = settings.env?.CLAUDE_CODE_EFFORT_LEVEL ?? null;
const sessionId = ${JSON.stringify(sessionId)};
const project = join(process.env.AGENT_TEST_CLAUDE_CONFIG, 'projects', 'fixture');
mkdirSync(project, { recursive: true });
const transcript = [
  { type: 'assistant', message: { model: 'provider-a' }, effort },
  { type: 'assistant', message: { model: 'provider-b' }, effort },
];
writeFileSync(join(project, sessionId + '.jsonl'), transcript.map(JSON.stringify).join('\\n') + '\\n');
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-alias' }));
console.log(JSON.stringify({ type: 'stream_event', session_id: sessionId, event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '想' } } }));
console.log(JSON.stringify({ type: 'stream_event', session_id: sessionId, event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '法' } } }));
console.log(JSON.stringify({ type: 'stream_event', session_id: sessionId, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'do' } } }));
console.log(JSON.stringify({ type: 'stream_event', session_id: sessionId, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ne' } } }));
console.log(JSON.stringify({ type: 'stream_event', session_id: sessionId, event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool-1', name: 'send', input: {} } } }));
console.log(JSON.stringify({ type: 'stream_event', session_id: sessionId, event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"to":"peer","text":"hel' } } }));
console.log(JSON.stringify({ type: 'stream_event', session_id: sessionId, event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'lo"}' } } }));
for (const row of transcript) console.log(JSON.stringify({ type: 'assistant', session_id: sessionId, message: row.message }));
console.log(JSON.stringify({ type: 'result', session_id: sessionId, is_error: false, result: 'done', modelUsage: { 'claude-alias': { outputTokens: 1 } } }));
`);
  chmodSync(fake, 0o700);
  process.env.AGENT_TEST_CLAUDE_CONFIG = configDirectory;
  t.after(() => { delete process.env.AGENT_TEST_CLAUDE_CONFIG; rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
  const observations = [], sessions = [], deltas = [], toolDeltas = [], reasonings = [];
  const host = createClaudeHost({
    directory, socketPath: join(directory, 'bus.sock'), command: fake, model: 'opus',
    reasoningEffort: 'low', configDirectory,
  });
  const result = await host.run({
    endpoint: { id: 'endpoint', key: 'key', session: null }, turnId: 'turn',
    workspace: directory, prompt: 'probe', instructions: 'rules', tools: [],
    signal: new AbortController().signal,
    onSession: value => sessions.push(value), onAccepted: () => {},
    onModel: value => observations.push(value), onEvent: () => {},
    onTextDelta: text => deltas.push(text),
    onReasoningDelta: text => reasonings.push(text),
    onToolCallDelta: delta => toolDeltas.push(delta),
    onNativeTurn: () => {}, onTool: async () => ({}),
  });
  assert.equal(result, 'done');
  assert.deepEqual(deltas, ['do', 'ne']);
  assert.deepEqual(reasonings, ['想', '法']);
  assert.deepEqual(
    toolDeltas.map(delta => delta.argumentsDelta),
    ['', '{"to":"peer","text":"hel', 'lo"}'],
  );
  assert.deepEqual(sessions, [sessionId]);
  assert.deepEqual(observations, [
    { phase: 'requested', model: 'opus', reasoningEffort: 'low', source: 'adapter.config' },
    { phase: 'session', model: 'claude-alias', provider: 'claude', source: 'claude.system.init' },
    { phase: 'assistant', model: 'provider-a', provider: 'claude', source: 'claude.assistant.message' },
    { phase: 'assistant', model: 'provider-b', provider: 'claude', source: 'claude.assistant.message' },
    { phase: 'usage', models: ['claude-alias'], provider: 'claude', source: 'claude.result.modelUsage' },
    { phase: 'verified', model: 'provider-b', reasoningEffort: 'low', provider: 'claude', source: 'claude.project_transcript' },
  ]);
  assert.deepEqual(readClaudeSessionMetadata(sessionId, configDirectory).at(-1), { model: 'provider-b', reasoningEffort: 'low' });
  await assert.rejects(async () => createClaudeHost({ reasoningEffort: 'unsupported' }), /思考强度无效/);
});

test('model observations are turn-scoped and never exposed from private sessions', async t => {
  const { bus, members } = fixture(t, async ctx => {
    if (ctx.endpoint.context === 'private') {
      ctx.onModel({ phase: 'assistant', model: 'private-model', source: 'test' });
    } else if (ctx.prompt === 'next turn') {
      ctx.onModel({ phase: 'session', model: 'new-session-model', reasoningEffort: 'high', source: 'test' });
    } else {
      ctx.onModel({ phase: 'assistant', model: 'first-model', source: 'test' });
      ctx.onModel({ phase: 'assistant', model: 'second-model', source: 'test' });
    }
    ctx.onAccepted();
    return 'done';
  });
  await until(() => bus.running.size === 0);
  const endpoint = bus.store.endpoint(members[0].id, `pair:${members[1].id}`, members[1].id);
  await bus.runEndpoint(endpoint, 'public');
  const turn = bus.store.get("SELECT t.id FROM turns t JOIN conversations e ON e.id=t.conversation_id WHERE e.context LIKE 'pair:%' ORDER BY t.rowid DESC");
  const trace = bus.store.turnTrace(turn.id);
  assert.deepEqual(trace.modelObservations.map(event => event.model), ['first-model', 'second-model']);
  assert.equal(trace.currentModel.model, 'second-model');
  assert.equal(trace.currentReasoningEffort, null);
  const events = trace.events.map(row => JSON.parse(row.event)).filter(event => event.type === 'framework.model');
  assert.deepEqual(events.map(event => event.model), ['first-model', 'second-model']);
  await bus.runEndpoint(endpoint, 'next turn');
  const endpointModels = bus.store.endpointModels(endpoint.id);
  assert.equal(endpointModels.currentModel.model, 'new-session-model');
  assert.equal(endpointModels.currentReasoningEffort.reasoningEffort, 'high');
  await bus.privateTurn(members[0].group_id, 'private');
  assert.equal(turnsAgg.historyEvents(bus.store).filter(row => row.event.includes('private-model')).length, 0);
});
});

describe('archive-communication', () => {
const _tick = () => new Promise(resolve => setImmediate(resolve));

async function until(predicate) {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('condition timed out');
}

async function fixture(t) {
  const scenario = busScenario(t, {
    name: 'post-archive',
    members: ['executor', 'reviewer'],
    profileText: 'test profile',
    finalText: 'done',
    sessionOf: endpoint => endpoint.id,
    emitHostEvent: false,
  });
  await until(() => !scenario.bus.running.size);
  return scenario;
}

test('open group keeps every conversation path working without flow state', async t => {
  const { bus, group, members, calls } = await fixture(t);
  const directive = bus.directive(group.id, '请汇总当前进展');
  await until(() => bus.running.size === 0 && bus.store.get('SELECT accepted FROM outbox WHERE id=(SELECT outbox_id FROM attached WHERE message_id=?)', directive.messageId)?.accepted);
  const coordinationRun = calls.findLast(call => call.endpoint.context === 'coordination');
  assert.equal(coordinationRun.policy.mode, 'communication');
  assert.equal(coordinationRun.policy.allowShell, false);
  assert.match(coordinationRun.prompt, /请汇总当前进展/);

  const executor = bus.store.endpoint(members[1].id, `pair:${group.lead}`, group.lead);
  const reply = await bus.tool(executor.id, executor.key, 'send', { to: group.lead, text: '成员可以继续讨论结果' });
  assert.ok(reply.messageId);
  await until(() => bus.running.size === 0 && bus.store.get('SELECT accepted FROM outbox WHERE id=(SELECT outbox_id FROM attached WHERE message_id=?)', reply.messageId)?.accepted);

  const reviewer = bus.store.endpoint(members[2].id, `pair:${members[1].id}`, members[1].id);
  const _peerReply = await bus.tool(executor.id, executor.key, 'send', { to: members[2].id, text: '成员之间也可以继续交流' });
  await until(() => bus.running.size === 0 && calls.some(call => call.endpoint.id === reviewer.id));
  assert.ok(calls.some(call => call.endpoint.id === reviewer.id && call.policy.mode === 'workspace-write'));

  await bus.privateTurn(group.id, '请继续解释结果');
  assert.equal(calls.at(-1).endpoint.context, 'private');
  assert.equal(calls.at(-1).policy.mode, 'communication');
});

test('archiving stops delivery and unarchiving restores it without losing messages', async t => {
  const { bus, group, members } = await fixture(t);
  await bus.archiveGroup(group.id);
  assert.equal(bus.collaboration.communicationOpen(group.id), false);
  const executor = bus.store.endpoint(members[1].id, `pair:${group.lead}`, group.lead);
  await assert.rejects(
    bus.tool(executor.id, executor.key, 'send', { to: group.lead, text: '归档后不能投递' }),
    /已归档/,
  );
  assert.throws(() => bus.directive(group.id, '归档后不接受指令'), /已归档/);
  const queued = bus.store.append(group.id, members[2].id, group.lead, 'send', '归档前的待投递消息');
  bus.pump();
  assert.equal(messagesAgg.isAttached(bus.store, queued.id), false);
  await bus.restoreGroup(group.id);
  assert.equal(bus.collaboration.communicationOpen(group.id), true);
  bus.pump();
  await until(() => bus.running.size === 0 && bus.store.get('SELECT accepted FROM outbox WHERE id=(SELECT outbox_id FROM attached WHERE message_id=?)', queued.id)?.accepted);
  await bus.tool(executor.id, executor.key, 'send', { to: group.lead, text: '恢复后可以继续投递' });
  await until(() => bus.running.size === 0);
});
});

describe('role-lifecycle', () => {
async function until(predicate) {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('condition timed out');
}

test('roles are permanent identities: names stay reserved and new roles get new sessions', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-role-lifecycle-'));
  const catalog = modelCatalog({
    host: 'fake',
    source: 'test',
    defaultModel: 'role-model',
    models: [
      { id: 'role-model', reasoningEfforts: [{ id: 'low' }], defaultReasoningEffort: 'low', isDefault: true },
      { id: 'added-model', reasoningEfforts: [{ id: 'high' }], defaultReasoningEffort: 'high' },
    ],
  });
  const bus = new Bus({
    directory,
    hosts: new Map([['fake', {
      async listModels() { return catalog; },
      async run(context) {
        if (context.endpoint.context === 'member-plan') {
          return JSON.stringify({
            model_provider: null,
            model: 'added-model',
            reasoning_effort: 'high',
          });
        }
        if (context.endpoint.context === 'profile') await context.onTool('profile_set', { text: 'role' });
        context.onSession(context.endpoint.session ?? `${context.endpoint.id}-session`);
        context.onAccepted();
        return 'done';
      },
    }]]),
  });
  t.after(async () => {
    await bus.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  });

  assert.throws(() => bus.createGroup({
    name: 'duplicate names',
    workspace: directory,
    lead: { name: 'Alice', host: 'fake' },
    members: [{ name: 'ＡＬＩＣＥ', host: 'fake' }],
  }), /重复/);

  const group = createTestGroup(bus, {
    name: 'roles',
    workspace: directory,
    lead: { name: 'Lead', host: 'fake' },
    members: [{ name: 'Worker', host: 'fake' }],
  });
  await until(() => bus.running.size === 0);
  const worker = bus.members(group.id).find(member => member.name === 'Worker');
  const workerEndpoint = bus.store.endpoint(worker.id, `pair:${group.lead}`, group.lead);
  const historical = bus.store.append(group.id, worker.id, group.lead, 'send', 'historical contribution');
  await bus.runEndpoint(workerEndpoint, 'establish original role session');
  const historicalSession = bus.querySession(group.id, workerEndpoint.id).session;
  assert.ok(historicalSession);

  await bus.removeMember(group.id, worker.id);
  const removed = bus.store.get('SELECT removed FROM members WHERE id=?', worker.id);
  assert.ok(removed.removed);
  assert.equal(messagesAgg.textOf(bus.store, historical.id), 'historical contribution');
  // 会话绑定的对外投影（querySession）仍指向原 session，而不是内部表读取。
  assert.equal(bus.querySession(group.id, workerEndpoint.id)?.session, historicalSession);
  await assert.rejects(bus.tool(workerEndpoint.id, workerEndpoint.key, 'read', {}), /成员不存在或已移除/);

  await assert.rejects(bus.addMember(group.id, { name: 'worker', host: 'fake' }), /名称已被本团队历史使用/);
  await assert.rejects(bus.addMember(group.id, { name: 'ＷＯＲＫＥＲ', host: 'fake' }), /名称已被本团队历史使用/);
  const replacement = await bus.addMember(group.id, { name: 'Worker Two', host: 'fake' });
  assert.notEqual(replacement.id, worker.id);
  await until(() => bus.running.size === 0);
  const replacementEndpoint = bus.store.endpoint(replacement.id, `pair:${group.lead}`, group.lead);
  await bus.runEndpoint(replacementEndpoint, 'establish replacement role session');
  const replacementSession = bus.querySession(group.id, replacementEndpoint.id).session;
  assert.notEqual(replacementEndpoint.id, workerEndpoint.id);
  assert.ok(replacementSession);
  assert.notEqual(replacementSession, historicalSession);
  assert.equal(bus.members(group.id).some(member => member.id === worker.id), false);
  assert.equal(bus.members(group.id).some(member => member.id === replacement.id), true);
});
});

describe('collaboration', () => {
const tick = () => new Promise(r => setImmediate(r));
async function until(fn) { for (let i = 0; i < 300; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error('timeout'); }
async function fixture(t, run) {
  const scenario = busScenario(t, {
    run,
    name: 'isolated',
    members: ['executor', 'reviewer'],
    profileText: 'test profile',
    finalText: 'done',
    sessionOf: endpoint => endpoint.id,
    emitHostEvent: false,
  });
  await until(() => !scenario.bus.running.size);
  return scenario;
}

test('main coordination serializes and batches reports from distinct members in one session', async t => {
  const releases = [];
  const { bus, group, members, calls } = await fixture(t, c => new Promise(resolve => releases.push(() => { c.onAccepted(); resolve('done'); })));
  const send = member => { const e = bus.store.endpoint(member.id, `pair:${group.lead}`, group.lead); return bus.tool(e.id, e.key, 'send', { to: group.lead, text: `来自${member.name}` }); };
  await send(members[1]); await until(() => releases.length === 1);
  await send(members[2]); await send(members[1]);
  assert.equal(bus.running.size, 1);
  releases.shift()(); await until(() => releases.length === 1);
  const main = calls.filter(c => c.endpoint.context === 'coordination');
  assert.equal(main.length, 2); assert.equal(main[0].endpoint.id, main[1].endpoint.id);
  assert.equal(main[0].endpoint.session, main[1].endpoint.session);
  const input = JSON.parse(bus.store.all('SELECT payload FROM outbox')[1].payload);
  assert.deepEqual([input.message.sender, ...input.additionalMessages.map(m => m.sender)], [members[2].id, members[1].id]);
  releases.shift()(); await until(() => !bus.running.size); await tick();
});

test('pair turns stream reasoning and text under the pair key', async t => {
  const { bus, members } = await fixture(t, async c => {
    c.onAccepted();
    c.onReasoningDelta('想', { part: 1 });
    c.onReasoningDelta('法', { part: 2 });
    c.onTextDelta('做', { part: 3 });
    c.onTextDelta('完', { part: 4 });
    return '做完';
  });
  const events = [];
  bus.on('team-stream', event => events.push(event));
  const sender = members[1];
  const receiver = members[2];
  const endpoint = bus.store.endpoint(sender.id, `pair:${receiver.id}`, receiver.id);
  await bus.tool(endpoint.id, endpoint.key, 'send', { to: receiver.id, text: '你好' });
  await until(() => !bus.running.size);

  const start = events.find(event => event.type === 'start');
  assert.equal(start.stream.memberName, receiver.name);
  assert.equal(start.stream.context, `pair:${sender.id}`);
  assert.equal(start.stream.recipientName, sender.name);
  assert.equal(start.stream.pairKey, [sender.id, receiver.id].sort().join(':'));
  assert.deepEqual(
    events.filter(event => event.type === 'reasoning-delta').map(event => event.delta),
    ['想', '法'],
  );
  assert.deepEqual(
    events.filter(event => event.type === 'delta').map(event => event.delta),
    ['做', '完'],
  );
  const complete = events.find(event => event.type === 'complete');
  assert.equal(complete.stream.text, '做完');
  assert.equal(complete.stream.reasoning, '想法');
  assert.equal(complete.stream.messageId, undefined);
});
});

describe('archive-snapshot', () => {
async function fixture(t, run) {
  const scenario = busScenario(t, { members: [], profileText: null, run });
  await until(() => !scenario.bus.running.size);
  seedPanelAgent(scenario.bus, { host: 'fake' });
  return scenario;
}

test('archive freezes facts without calling a model, survives history pruning, and caches a lazy summary', async t => {
  const { bus, group, calls } = await fixture(t, async context => {
    assert.equal(context.endpoint.context, 'archive-summary');
    assert.equal(context.endpoint.session, null);
    assert.deepEqual(context.tools, []);
    assert.equal(context.policy.allowShell, false);
    const facts = JSON.parse(context.prompt).facts;
    assert.ok(facts.messages.some(message => message.text === '已有结果'));
    await assert.rejects(bus.panelTool(context.endpoint.id, context.endpoint.key, 'teams_list', {}), /不提供工具/);
    return '归档摘要';
  });
  const message = bus.store.append(group.id, group.lead, 'user', 'send', '已有结果');
  bus.store.run('UPDATE messages SET created=? WHERE id=?', '2000-01-01T00:00:00.000Z', message.id);
  bus.setAgentTasks({ ownerId: group.lead, groupId: group.id, tasks: [{ id: 'step-1', text: '检查', state: 'done' }] });
  const before = calls.length;
  await bus.archiveGroup(group.id);
  const first = bus.archiveSnapshot(group.id);
  assert.equal(calls.length, before);
  assert.equal(first.summary, null);
  assert.equal(first.facts.group.state, 'archived');
  assert.ok(first.facts.tasks.length);
  bus.store.pruneHistory();
  assert.ok(bus.archiveSnapshot(group.id).facts.messages.some(row => row.id === message.id));
  bus.store.run('UPDATE groups SET name=? WHERE id=?', 'changed', group.id);
  assert.equal(bus.archiveSnapshot(group.id).facts.group.name, group.name);
  assert.equal(bus.summarizeArchive(group.id).generating, true);
  bus.summarizeArchive(group.id);
  await until(() => !bus.archiveSnapshot(group.id).generating);
  assert.equal(bus.archiveSnapshot(group.id).summary, '归档摘要');
  bus.summarizeArchive(group.id);
  assert.equal(calls.length, before + 1);
  await bus.archiveGroup(group.id);
  assert.equal(bus.archiveSnapshot(group.id).id, first.id);
});

test('restore discards the snapshot, aborts generation, and ignores a late result after rearchive', async t => {
  let finish;
  let signal;
  const { bus, group } = await fixture(t, context => {
    signal = context.signal;
    return new Promise(resolve => { finish = resolve; });
  });
  await bus.archiveGroup(group.id);
  const old = bus.summarizeArchive(group.id);
  await until(() => finish);
  await bus.archiveGroup(group.id);
  assert.equal(signal.aborted, false);
  bus.restoreGroup(group.id);
  assert.equal(signal.aborted, true);
  assert.throws(() => bus.archiveSnapshot(group.id), /尚未归档/);
  // setGroupState is synchronous; the old host may return after the new snapshot exists.
  bus.setGroupState(group.id, 'archived');
  const next = bus.archiveSnapshot(group.id);
  assert.notEqual(next.id, old.id);
  finish('迟到的旧摘要');
  await until(() => !bus.running.size);
  assert.equal(bus.archiveSnapshot(group.id).summary, null);
  assert.equal(bus.archiveSnapshot(group.id).error, null);
});

test('failed summaries keep facts and can retry; missing Panel Agent does not destroy the snapshot', async t => {
  let attempts = 0;
  const { bus, group } = await fixture(t, async () => {
    if (++attempts === 1) throw new Error('fake failure');
    return 'retry result';
  });
  await bus.archiveGroup(group.id);
  const id = bus.archiveSnapshot(group.id).id;
  bus.summarizeArchive(group.id);
  await until(() => !bus.archiveSnapshot(group.id).generating);
  assert.match(bus.archiveSnapshot(group.id).error, /fake failure/);
  bus.summarizeArchive(group.id);
  await until(() => !bus.archiveSnapshot(group.id).generating);
  assert.equal(bus.archiveSnapshot(group.id).summary, 'retry result');
  assert.equal(bus.archiveSnapshot(group.id).id, id);
  bus.restoreGroup(group.id);
  bus.store.run('DELETE FROM panel_agents');
  await bus.archiveGroup(group.id);
  assert.throws(() => bus.summarizeArchive(group.id), /配置 Panel Agent/);
  assert.ok(bus.archiveSnapshot(group.id).facts);
});


test('uncertain summary runs remain visible for the existing Panel runtime resolution flow', async t => {
  let attempts = 0;
  const { bus, group } = await fixture(t, async () => {
    if (++attempts === 1) throw Object.assign(new Error('host disconnected'), { runtimeUnknown: true });
    return 'verified retry';
  });
  await bus.archiveGroup(group.id);
  bus.summarizeArchive(group.id);
  await until(() => !bus.archiveSnapshot(group.id).generating);
  const unknown = bus.panelBrowserState().unknown;
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].session_context, 'archive-summary');
  assert.throws(() => bus.summarizeArchive(group.id), /待核实运行/);
  bus.resolvePanelRuntime(unknown[0].id, 'fake host is stopped');
  bus.summarizeArchive(group.id);
  await until(() => !bus.archiveSnapshot(group.id).generating);
  assert.equal(bus.archiveSnapshot(group.id).summary, 'verified retry');
});


test('a saved snapshot and summary survive reopening without another model call', async t => {
  const { bus, group, directory, host, calls } = await fixture(t, async () => 'saved summary');
  await bus.archiveGroup(group.id);
  bus.summarizeArchive(group.id);
  await until(() => !bus.archiveSnapshot(group.id).generating);
  const saved = bus.archiveSnapshot(group.id);
  await bus.close();
  const reopened = new Bus({ directory, hosts: new Map([['fake', host]]) });
  try {
    const count = calls.length;
    assert.equal(reopened.archiveSnapshot(group.id).id, saved.id);
    assert.equal(reopened.summarizeArchive(group.id).summary, 'saved summary');
    assert.equal(calls.length, count);
  } finally {
    await reopened.close();
  }
});
});
