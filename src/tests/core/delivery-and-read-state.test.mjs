import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { Bus } from '../../bus.mjs';
import { busScenario, fakeHost, serverScenario, seedPanelAgent, createTestGroup } from '../support/fixture.mjs';
import { randomUUID } from 'node:crypto';
import { until } from '../support/wait.mjs';
import { homeWorkbench, dismissWorkbench } from '../../productivity.mjs';
import * as messagesAgg from '../../aggregates/messages.mjs';
import { advanceReadState } from '../../read-state.mjs';

describe('delivery-recovery', () => {
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(fn, label = 'condition') {
  const end = Date.now() + 5000;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`${label} timed out`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
const hint = (call, text) => String(call?.prompt ?? '').includes(text);

test('a message persisted without a delivery intent is picked up by the next pump', async t => {
  const { bus, group, members, calls } = busScenario(t);
  const [lead, one] = members;
  await until(() => bus.running.size === 0, 'idle');

  // 模拟 append 已提交、prepareDelivery 尚未发生的崩溃窗口。
  bus.store.append(group.id, one.id, lead.id, 'send', 'recovered awaiting message');
  assert.equal(calls.some(call => hint(call, 'recovered awaiting message')), false);

  bus.pump();
  await until(() => calls.some(call => hint(call, 'recovered awaiting message')), 'delivery');
  await until(() => bus.running.size === 0, 'idle after delivery');
  assert.equal(calls.filter(call => hint(call, 'recovered awaiting message')).length, 1);
});

test('a pending outbox delivery is retried after a restart', async t => {
  const { bus, group, members, directory } = busScenario(t);
  const [lead, one] = members;
  await until(() => bus.running.size === 0, 'idle');

  // 模拟投递意图已落库、但宿主尚未接受时进程退出。
  const message = bus.store.append(group.id, one.id, lead.id, 'send', 'persisted delivery intent');
  const conversation = bus.store.conversation('member', lead.id, `pair:${one.id}`);
  assert.ok(bus.store.prepareDelivery(conversation, message));
  await bus.close();

  const host = fakeHost();
  const reopened = new Bus({ directory, hosts: new Map([['fake', host]]) });
  reopened.start();
  await until(() => host.calls.some(call => hint(call, 'persisted delivery intent')), 'retry after restart');
  await until(() => reopened.running.size === 0, 'idle after retry');
  assert.equal(host.calls.filter(call => hint(call, 'persisted delivery intent')).length, 1);
  await reopened.close();
});

test('delivery waits while a turn is unknown and resumes after the user verifies it', async t => {
  const { bus, group, members, calls } = busScenario(t);
  const [lead, one] = members;
  await until(() => bus.running.size === 0, 'idle');

  const conversation = bus.store.conversation('member', one.id, `pair:${lead.id}`);
  const turnId = bus.store.createTurn(conversation, { executorKind: 'member', executorId: one.id });
  bus.store.run("UPDATE turns SET state='unknown' WHERE id=?", turnId);

  bus.store.append(group.id, one.id, lead.id, 'send', 'blocked by unknown turn');
  bus.pump();
  await tick();
  await tick();
  assert.equal(calls.some(call => hint(call, 'blocked by unknown turn')), false);

  // 用户核实宿主已停止后，投递继续。
  bus.store.run("UPDATE turns SET state='completed' WHERE id=?", turnId);
  bus.pump();
  await until(() => calls.some(call => hint(call, 'blocked by unknown turn')), 'delivery after verification');
  await until(() => bus.running.size === 0, 'idle after delivery');
  assert.equal(calls.filter(call => hint(call, 'blocked by unknown turn')).length, 1);
});

test('a failed delivery preparation leaves no half-delivered input', async t => {
  const { bus, group, members, calls } = busScenario(t);
  const [lead, one] = members;
  await until(() => bus.running.size === 0, 'idle');

  bus.store.append(group.id, one.id, lead.id, 'send', 'injected failure');
  const original = bus.store.prepareDelivery;
  let injected = false;
  bus.store.prepareDelivery = (...args) => {
    if (!injected) { injected = true; throw new Error('injected prepare failure'); }
    return original.apply(bus.store, args);
  };
  try {
    assert.throws(() => bus.pump(), /injected prepare failure/);
    assert.equal(calls.some(call => hint(call, 'injected failure')), false);
  } finally {
    bus.store.prepareDelivery = original;
  }

  bus.pump();
  await until(() => calls.some(call => hint(call, 'injected failure')), 'delivery after recovery');
  await until(() => bus.running.size === 0, 'idle after delivery');
  assert.equal(calls.filter(call => hint(call, 'injected failure')).length, 1);
});
});

describe('turn-failure-attribution', () => {
const until = async (predicate, ms = 5000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise(r => setTimeout(r, 10));
  }
};

function attachExecution(host, capabilities) {
  host.executionCapabilities = ({ mode, allowShell }) => ({
    effectivePolicy: mode === 'communication' ? 'communication' : 'workspace-write',
    capabilities: mode === 'communication'
      ? []
      : capabilities.filter(id => id !== 'exec.shell' || allowShell),
    reason: null,
  });
}

test('a failed member turn records declared execution capabilities', async t => {
  const { bus, members } = busScenario(t, {
    run: async () => { throw new Error('boom-from-host'); },
    emitHostEvent: false,
  });
  attachExecution(bus.hosts.get('fake'), ['exec.read', 'exec.write', 'exec.shell']);
  await until(() => bus.running.size === 0);

  const sender = members.find(member => member.name === 'one');
  const endpoint = bus.store.endpoint(sender.id, 'pair:test');
  await bus.tool(endpoint.id, endpoint.key, 'send', { to: 'two', text: 'do work' });
  await new Promise(r => setTimeout(r, 200));
  await until(() => bus.running.size === 0);

  const row = bus.store.get("SELECT detail FROM turns WHERE state='failed' ORDER BY created DESC LIMIT 1");
  assert.ok(row, 'a failed turn exists');
  assert.match(row.detail, /boom-from-host/);
  assert.match(row.detail, /宿主声明支持: exec\.read, exec\.write, exec\.shell/);
});

test('a failed communication turn adds no capability note', async t => {
  const { bus, group, members } = busScenario(t, {
    run: async () => { throw new Error('communication-boom'); },
    emitHostEvent: false,
  });
  attachExecution(bus.hosts.get('fake'), ['exec.read']);
  bus.store.run('UPDATE groups SET policy=? WHERE id=?', 'communication', group.id);
  await until(() => bus.running.size === 0);

  const sender = members.find(member => member.name === 'one');
  const endpoint = bus.store.endpoint(sender.id, 'pair:test');
  await bus.tool(endpoint.id, endpoint.key, 'send', { to: 'two', text: 'hello' });
  await new Promise(r => setTimeout(r, 200));
  await until(() => bus.running.size === 0);

  const row = bus.store.get("SELECT detail FROM turns WHERE state='failed' ORDER BY created DESC LIMIT 1");
  assert.ok(row, 'a failed turn exists');
  assert.equal(row.detail, 'communication-boom');
});
});

describe('message-trace-segment', () => {
async function settled(bus) {
  // 主控协调回合的团队能力快照是异步构造的:先让出一个 tick 再判空闲.
  for (let i = 0; i < 400; i++) {
    await new Promise(r => setTimeout(r, 5));
    if (!bus.running.size) return;
  }
  throw Error('timeout');
}

test('message trace returns only the events of the producing call', async t => {
  // 一次回合里连续发两条消息:每次发送各有一段独立的事件。
  const { bus, group } = busScenario(t, {
    members: ['one', 'two'],
    run: async context => {
      const [first, second] = bus.members(context.endpoint.group_id).filter(m => m.role !== 'lead');
      context.onEvent({ type: 'framework.model', model: 'm1', phase: 'session' });
      await context.onTool('send', { to: first.id, text: 'first' });
      context.onEvent({ type: 'framework.model', model: 'm2', phase: 'session' });
      await context.onTool('send', { to: second.id, text: 'second' });
      context.onAccepted();
      return '';
    },
  });
  await settled(bus);
  const lead = bus.store.get("SELECT * FROM members WHERE group_id=? AND role='lead'", group.id);
  const endpoint = bus.store.endpoint(lead.id, 'coordination');
  const message = bus.store.append(group.id, 'user', lead.id, 'send', 'go');
  bus.store.prepareDelivery(endpoint, message);
  bus.retry(group.id);
  await settled(bus);

  const rows = bus.store.all(
    "SELECT m.id FROM messages m JOIN message_origins o ON o.message_id=m.id WHERE m.group_id=? AND m.sender!='user' ORDER BY m.seq",
    group.id,
  );
  assert.ok(rows.length >= 2, `应当产出至少两条消息,实际 ${rows.length}`);
  const traces = rows.map(row => bus.store.messageTrace(row.id, { segment: true }));
  for (const trace of traces) {
    assert.ok(trace.segment, '有回合来源的消息应当有事件段');
    assert.ok(trace.segment.events.length > 0);
    assert.ok(trace.segment.startSeq <= trace.segment.endSeq);
    assert.equal(trace.turn.id, trace.source.turnId);
  }
  // 段只覆盖产出这条消息的那次调用:同回合内多段互不重叠。
  const byTurn = new Map();
  for (const trace of traces) {
    byTurn.set(trace.turn.id, [...(byTurn.get(trace.turn.id) ?? []), trace.segment]);
  }
  for (const [turnId, segments] of byTurn) {
    const sorted = [...segments].sort((a, b) => a.startSeq - b.startSeq);
    for (let i = 1; i < sorted.length; i++) {
      assert.ok(
        sorted[i].startSeq > sorted[i - 1].endSeq,
        `回合 ${turnId} 的第 ${i} 段应在上一段之后开始(${sorted[i].startSeq} vs ${sorted[i - 1].endSeq})`,
      );
    }
  }
});

test('message trace without a turn source has no segment', async t => {
  const { bus, group } = busScenario(t, { members: [] });
  await settled(bus);
  const message = bus.store.append(group.id, 'system', 'system', 'system', 'notice');
  const trace = bus.store.messageTrace(message.id, { segment: true });
  assert.deepEqual(trace.source, { kind: 'system' });
  assert.equal(trace.segment, null);
  assert.equal(trace.turn, null);
});
});

describe('agent-waiting', () => {
function tools(bus, member) {
  const endpoint = bus.store.endpoint(member.id, member.role === 'lead' ? 'coordination' : 'pair:test');
  return (name, args = {}) => bus.tool(endpoint.id, endpoint.key, name, args);
}

const settled = bus => until(() => bus.running.size === 0
  && bus.store.get('SELECT COUNT(*) AS n FROM outbox WHERE accepted IS NULL').n === 0);

test('agent requests are waiting only when expects_reply is set and close with reply_to', async t => {
  const { bus, members } = busScenario(t);
  await settled(bus);
  const [lead, one, two] = members;
  const immediate = { waitingThresholdMs: 0 };

  const normal = await tools(bus, one)('send', { to: two.id, text: '普通汇报' });
  await settled(bus);
  assert.deepEqual(homeWorkbench(bus, immediate).agentWaiting, []);

  // 对外语义由 homeWorkbench.agentWaiting 判定：普通汇报不进入等待列表；
  // 带 expects_reply 的请求才进入，并带回消息 id。内部列不再是断言对象。
  const request = await tools(bus, one)('send', { to: two.id, text: '请确认方案 X', expects_reply: true });
  await settled(bus);
  const waiting = homeWorkbench(bus, immediate).agentWaiting;
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].id, request.messageId);
  assert.equal(waiting[0].senderName, 'one');
  assert.equal(waiting[0].recipientName, 'two');
  assert.match(waiting[0].path, /\/groups\//);

  await assert.rejects(
    tools(bus, two)('send', { to: one.id, text: '乱回', reply_to: normal.messageId }),
    /只能回复/,
  );
  await assert.rejects(
    tools(bus, lead)('send', { to: two.id, text: '不是发给我的', reply_to: request.messageId }),
    /不是发给自己/,
  );

  await tools(bus, two)('send', { to: one.id, text: '确认 X', reply_to: request.messageId });
  await settled(bus);
  assert.deepEqual(homeWorkbench(bus, immediate).agentWaiting, []);
});

test('dismissing hides workbench entries without deleting records or resolving interactions', async t => {
  const { bus, group, members } = busScenario(t);
  await settled(bus);
  const [lead, one] = members;
  const immediate = { waitingThresholdMs: 0 };

  const directive = bus.store.append(group.id, 'user', lead.id, 'send', '等待中的用户指令');
  const request = await tools(bus, one)('send', { to: lead.id, text: '等待中的 Agent 请求', expects_reply: true });
  await settled(bus);
  const interactionId = randomUUID();
  bus.store.createInteraction({
    id: interactionId,
    groupId: group.id,
    memberId: lead.id,
    context: 'coordination',
    turnId: randomUUID(),
    callId: 'call-clean',
    kind: 'choice',
    payload: { kind: 'choice', text: '确认？', options: ['同意', '拒绝'] },
  });

  const before = homeWorkbench(bus, immediate);
  assert.equal(before.pending.length, 1);
  assert.equal(before.waiting.length, 1);
  assert.equal(before.agentWaiting.length, 1);

  const result = dismissWorkbench(bus, [
    { category: 'interaction', id: interactionId },
    { category: 'waiting:user', id: directive.id },
    { category: 'waiting:agent', id: request.messageId },
  ]);
  assert.deepEqual(result, { dismissed: 3 });

  const after = homeWorkbench(bus, immediate);
  assert.deepEqual(after.pending, []);
  assert.deepEqual(after.waiting, []);
  assert.deepEqual(after.agentWaiting, []);
  assert.equal(bus.store.interaction(interactionId).state, 'pending');
  assert.ok(messagesAgg.byId(bus.store, directive.id));
  assert.ok(messagesAgg.byId(bus.store, request.messageId));
  const fresh = bus.store.append(group.id, 'user', lead.id, 'send', '清理后的新指令');
  const afterFresh = homeWorkbench(bus, immediate);
  assert.equal(afterFresh.waiting.length, 1);
  assert.equal(afterFresh.waiting[0].id, fresh.id);
  assert.throws(
    () => dismissWorkbench(bus, [{ category: 'waiting:user', id: 'missing' }]),
    /已失效/,
  );
});

test('dismiss HTTP route hides entries and rejects malformed requests', async t => {
  const { bus, url, group, members } = await serverScenario(t, { members: ['one'] });
  const lead = bus.teamController(group.id);
  const directive = bus.store.append(group.id, 'user', lead.id, 'send', 'HTTP 清理');
  const endpoint = new URL(url);
  const post = (body, contentType = 'application/json') => fetch(new URL('/api/workbench/dismiss', endpoint), {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const ok = await post({ items: [{ category: 'waiting:user', id: directive.id }] });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { dismissed: 1 });
  const listed = await (await fetch(new URL('/api/workbench', endpoint))).json();
  assert.ok(!listed.waiting.some(item => item.id === directive.id));
  assert.equal((await post({ items: [{ category: 'waiting:user', id: 'missing' }] })).status, 400);
  assert.equal((await post({ items: [] })).status, 400);
  assert.equal((await post('{}', 'text/plain')).status, 415);
  assert.ok(members.length >= 1);
});

test('recent activity dismissal hides only the current window and rejects running turns', async t => {
  const { bus, group, members } = busScenario(t);
  await settled(bus);
  const member = members[0];
  const endpoint = bus.store.endpoint(member.id, 'coordination');
  const ids = [];
  for (let i = 0; i < 12; i++) {
    const id = randomUUID();
    ids.push(id);
    bus.store.run('INSERT INTO turns(id,conversation_id,executor_kind,executor_id,group_id,session,state,created) VALUES(?,?,?,?,?,?,?,?)',
      id, endpoint.id, 'member', member.id, group.id, endpoint.session, 'completed', new Date(Date.now() + i * 1000).toISOString());
  }
  const before = homeWorkbench(bus).recent;
  assert.equal(before.length, 10);
  assert.equal(dismissWorkbench(bus, before.map(row => ({ category: 'activity:recent', id: row.id }))).dismissed, 10);
  assert.deepEqual(homeWorkbench(bus).recent, []);
  assert.throws(() => dismissWorkbench(bus, [{ category: 'activity:recent', id: ids[0] }]), /失效/);
  const next = randomUUID();
  bus.store.run('INSERT INTO turns(id,conversation_id,executor_kind,executor_id,group_id,session,state,created) VALUES(?,?,?,?,?,?,?,?)',
    next, endpoint.id, 'member', member.id, group.id, endpoint.session, 'completed', new Date(Date.now() + 20000).toISOString());
  assert.deepEqual(homeWorkbench(bus).recent.map(row => row.id), [next]);
  const running = randomUUID();
  bus.store.run('INSERT INTO turns(id,conversation_id,executor_kind,executor_id,group_id,session,state,created) VALUES(?,?,?,?,?,?,?,?)',
    running, endpoint.id, 'member', member.id, group.id, endpoint.session, 'running', new Date().toISOString());
  assert.throws(() => dismissWorkbench(bus, [{ category: 'activity:recent', id: running }]), /失效/);
});


test('removed members do not leave deliveries blocking controller switches or retries', async t => {
  const { bus, group, members, calls } = busScenario(t);
  await settled(bus);
  const worker = members[1];
  const endpoint = bus.store.endpoint(worker.id, 'pair:user');
  const message = bus.store.append(group.id, 'user', worker.id, 'send', 'pending at removal');
  bus.store.prepareDelivery(endpoint, message);
  await bus.removeMember(group.id, worker.id);
  seedPanelAgent(bus, { host: 'fake' });
  assert.equal(bus.takeoverTeam(group.id, 0).controller.kind, 'panel_agent');
  const callCount = calls.length;
  bus.retry(group.id);
  assert.equal(calls.length, callCount);
  assert.equal(bus.handbackTeam(group.id, 1).controller.kind, 'member');
});

test('archived turns cannot crowd active teams out of recent activity', async t => {
  const { bus, group, members } = busScenario(t);
  await settled(bus);
  const endpoint = bus.store.endpoint(members[0].id, 'coordination');
  bus.store.run('INSERT INTO turns(id,conversation_id,executor_kind,executor_id,group_id,state,created) VALUES(?,?,?,?,?,?,?)',
    randomUUID(), endpoint.id, 'member', endpoint.member_id, group.id, 'completed', new Date(Date.now() - 1000).toISOString());
  const archived = bus.createGroup({ name: 'archive', workspace: group.workspace, lead: { name: 'lead', host: 'fake' } });
  await settled(bus);
  const archivedEndpoint = bus.store.endpoint(bus.members(archived.id)[0].id, 'coordination');
  for (let i = 0; i < 31; i++) {
    bus.store.run('INSERT INTO turns(id,conversation_id,executor_kind,executor_id,group_id,state,created) VALUES(?,?,?,?,?,?,?)',
      randomUUID(), archivedEndpoint.id, 'member', archivedEndpoint.member_id, archived.id, 'completed', new Date(Date.now() + i * 1000).toISOString());
  }
  await bus.archiveGroup(archived.id);
  assert.ok(homeWorkbench(bus).recent.some(row => row.endpoint_id === endpoint.id));
  assert.ok(homeWorkbench(bus).recent.every(row => row.group_id !== archived.id));
});
});

describe('waiting', () => {
test('workbench lists unanswered user directives until a reply points back to them', async t => {
  const { bus, group } = busScenario(t);
  await until(() => !bus.running.size);
  const controller = bus.teamController(group.id);

  const immediate = { waitingThresholdMs: 0 };
  const directive = bus.store.append(group.id, 'user', controller.id, 'send', '请整理发布说明');
  // 默认 5 分钟阈值内不打扰。
  assert.deepEqual(homeWorkbench(bus).waiting, []);
  const waiting = homeWorkbench(bus, immediate).waiting;
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].id, directive.id);
  assert.equal(waiting[0].recipientName, 'lead');
  assert.equal(waiting[0].recipientKind, 'member');
  assert.equal(waiting[0].groupName, group.name);
  assert.match(waiting[0].title, /发布说明/);
  assert.match(waiting[0].path, new RegExp(`/groups/${group.id}`));

  // 最终回复通过 reply_to 指回指令后，不再是未应答。
  bus.store.append(group.id, controller.id, 'user', 'send', '已完成', directive.id);
  assert.deepEqual(homeWorkbench(bus, immediate).waiting, []);

  // 用户回答互动卡的消息自身是 reply，不是新指令，不能算未应答。
  const question = bus.store.append(group.id, controller.id, 'user', 'send', '选哪个方案？');
  bus.store.append(group.id, 'user', controller.id, 'send', '选 A', question.id);
  assert.deepEqual(homeWorkbench(bus, immediate).waiting, []);

  // 超过阈值即列出；是否正在运行不参与判断。
  const stale = bus.store.append(group.id, 'user', controller.id, 'send', '另一条未回复指令');
  bus.store.run('UPDATE messages SET created=? WHERE id=?', new Date(Date.now() - 10 * 60 * 1000).toISOString(), stale.id);
  assert.equal(homeWorkbench(bus).waiting.length, 1);

  // 归档团队不进入等待视图。
  bus.setGroupState(group.id, 'archived');
  assert.deepEqual(homeWorkbench(bus, immediate).waiting, []);
});
});

describe('read-state', () => {
function poster(url) {
  const endpoint = new URL('/api/read', url);
  return (body, contentType = 'application/json') => fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('读水位按会话隔离，且只接受向前的更新', async t => {
  const { bus, url, group, directory } = await serverScenario(t, { members: ['one'] });
  const other = createTestGroup(bus, {
    name: 'other',
    workspace: directory,
    lead: { name: 'lead2', host: 'fake' },
  });
  const lead = bus.teamController(group.id);
  const first = bus.store.append(group.id, 'user', lead.id, 'send', '第一条指令');
  const second = bus.store.append(group.id, 'user', lead.id, 'send', '第二条指令');
  const post = poster(url);

  const advanced = await post({ scope: 'group', scopeId: group.id, seq: second.seq });
  assert.equal(advanced.status, 200);
  assert.deepEqual(await advanced.json(), { scope: 'group', scopeId: group.id, seq: second.seq });

  // 往回退的请求被忽略，已读不会变回未读。
  const regressed = await post({ scope: 'group', scopeId: group.id, seq: first.seq });
  assert.equal(regressed.status, 200);
  assert.equal((await regressed.json()).seq, second.seq);

  // 另一个团队的会话是另一个水位，互不影响。
  const isolated = await post({ scope: 'group', scopeId: other.id, seq: 1 });
  assert.equal((await isolated.json()).seq, 1);
  assert.equal((await (await post({ scope: 'group', scopeId: group.id, seq: 0 })).json()).seq, second.seq);
});

test('读水位拒绝非法目标与畸形请求', async t => {
  const { url, group } = await serverScenario(t, { members: ['one'] });
  const post = poster(url);

  assert.equal((await post({ scope: 'group', scopeId: 'missing-group', seq: 1 })).status, 400);
  assert.equal((await post({ scope: 'unknown', scopeId: group.id, seq: 1 })).status, 400);
  assert.equal((await post({ scope: 'group', scopeId: group.id, seq: -1 })).status, 400);
  assert.equal((await post({ scope: 'group', scopeId: group.id, seq: 1.5 })).status, 400);
  assert.equal((await post({ scope: 'group', scopeId: '', seq: 1 })).status, 400);
  assert.equal((await post({ scope: 'group', scopeId: group.id, seq: 1, extra: true })).status, 400);
  assert.equal((await post('{}', 'text/plain')).status, 415);
});

test('面板私聊的水位只允许当前 Panel Agent 自己的目标', async t => {
  const { bus, url } = await serverScenario(t);
  const agentId = seedPanelAgent(bus);
  const own = await poster(url)({ scope: 'panel', scopeId: `${agentId}:__global__`, seq: 3 });
  assert.equal(own.status, 200);
  assert.equal((await own.json()).seq, 3);

  const foreign = await poster(url)({ scope: 'panel', scopeId: 'someone-else:__global__', seq: 4 });
  assert.equal(foreign.status, 400);
});
});

describe('unread-projection', () => {
const unreadFor = (workbench, conversation) => workbench.unread.find(row => row.conversation === conversation);

function askAnchor(bus, group, member) {
  const message = bus.store.append(group.id, member.id, 'user', 'send', '需要你确认一下');
  bus.store.createInteraction({
    id: randomUUID(),
    groupId: group.id,
    memberId: member.id,
    context: 'coordination',
    turnId: 'turn-1',
    callId: 'call-1',
    messageId: message.id,
    kind: 'choice',
    payload: { kind: 'choice', text: '需要你确认一下', options: ['同意', '拒绝'], cardOnly: true },
  });
  return message;
}

test('卡片锚点只算待办，答完之后也不会变成未读', async t => {
  const { bus, group, members } = await busScenario(t, { members: [] });
  askAnchor(bus, group, bus.teamController(group.id));
  let workbench = homeWorkbench(bus);
  assert.equal(workbench.pending.length, 1);
  assert.equal(workbench.unreadTotal, 0);

  const interaction = workbench.pending[0];
  bus.decideInteraction(interaction.id, { selected: '同意' });
  workbench = homeWorkbench(bus);
  assert.equal(workbench.pending.length, 0);
  assert.equal(workbench.unreadTotal, 0);
  assert.ok(members.length >= 1);
});

test('主控回执在群里算一条未读，私聊副本不重复计数', async t => {
  const { bus, group } = await busScenario(t, { members: [] });
  const agentId = seedPanelAgent(bus);
  const receiptId = randomUUID();
  const message = bus.store.append(group.id, agentId, 'user', 'send', '回执：本轮已完成');
  bus.store.run(
    'INSERT INTO panel_messages(id,panel_agent_id,context,role,text,active_team_id,created,receipt_id) VALUES(?,?,?,?,?,?,?,?)',
    randomUUID(), agentId, 'private', 'assistant', '回执：本轮已完成', group.id, new Date().toISOString(), receiptId,
  );

  const workbench = homeWorkbench(bus);
  assert.equal(unreadFor(workbench, `group:${group.id}`).count, 1);
  assert.equal(workbench.unread.filter(row => row.scope === 'panel').length, 0);
  assert.ok(message.id);
});

test('投递失败这类系统通知算未读', async t => {
  const { bus, group } = await busScenario(t, { members: [] });
  bus.notify(group.id, 'user', '消息 m-1 发给成员的会话失败：不会自动重试。');
  const workbench = homeWorkbench(bus);
  assert.equal(unreadFor(workbench, `group:${group.id}`).count, 1);
});

test('读一个团队不会清掉另一个团队的未读', async t => {
  const { bus, group, directory } = await busScenario(t, { members: [] });
  const other = createTestGroup(bus, { name: 'other', workspace: directory, lead: { name: 'lead2', host: 'fake' } });
  const leadA = bus.teamController(group.id);
  const leadB = bus.teamController(other.id);
  bus.store.append(group.id, leadA.id, 'user', 'send', 'A 的汇报');
  bus.store.append(other.id, leadB.id, 'user', 'send', 'B 的汇报');

  assert.equal(homeWorkbench(bus).unreadTotal, 2);
  advanceReadState(bus, { scope: 'group', scopeId: group.id, seq: 99999 });
  const workbench = homeWorkbench(bus);
  assert.equal(unreadFor(workbench, `group:${group.id}`), undefined);
  assert.equal(unreadFor(workbench, `group:${other.id}`).count, 1);
});

test('归档期间不计数，恢复时视为全部已读', async t => {
  const { bus, group } = await busScenario(t, { members: [] });
  const lead = bus.teamController(group.id);
  const agentId = seedPanelAgent(bus);
  bus.store.append(group.id, lead.id, 'user', 'send', '归档前的汇报');
  bus.store.panelAppend(agentId, 'private', 'assistant', '归档前的私聊汇报', group.id);
  assert.equal(homeWorkbench(bus).unreadTotal, 2);

  await bus.archiveGroup(group.id);
  assert.equal(homeWorkbench(bus).unreadTotal, 0);

  bus.store.append(group.id, lead.id, 'user', 'send', '归档期间的汇报');
  bus.restoreGroup(group.id);
  assert.equal(homeWorkbench(bus).unreadTotal, 0);
});

test('已删除团队的私聊旧消息不制造清不掉的未读', async t => {
  const { bus, group } = await busScenario(t, { members: [] });
  const agentId = seedPanelAgent(bus);
  bus.store.panelAppend(agentId, 'private', 'assistant', '团队还在时的回复', group.id);
  const ghost = bus.store.panelAppend(agentId, 'private', 'assistant', '团队已删除后的旧消息', 'gone-team');

  const workbench = homeWorkbench(bus);
  assert.equal(unreadFor(workbench, `panel:${group.id}`).count, 1);
  assert.equal(workbench.unreadTotal, 1);
  assert.ok(ghost);
});

test('面板私聊按团队分桶，读一个团队不影响另一个', async t => {
  const { bus, group, directory } = await busScenario(t, { members: [] });
  const other = createTestGroup(bus, { name: 'other', workspace: directory, lead: { name: 'lead2', host: 'fake' } });
  const agentId = seedPanelAgent(bus);
  bus.store.panelAppend(agentId, 'private', 'assistant', 'A 团队的口头汇报', group.id);
  bus.store.panelAppend(agentId, 'private', 'assistant', 'B 团队的口头汇报', other.id);
  bus.store.panelAppend(agentId, 'private', 'assistant', '不属于任何团队的私聊', null);

  assert.equal(homeWorkbench(bus).unreadTotal, 3);
  advanceReadState(bus, { scope: 'panel', scopeId: `${agentId}:${group.id}`, seq: 99999 });
  const workbench = homeWorkbench(bus);
  assert.equal(unreadFor(workbench, `panel:${group.id}`), undefined);
  assert.equal(unreadFor(workbench, `panel:${other.id}`).count, 1);
  assert.equal(unreadFor(workbench, 'panel:__global__').count, 1);
});
});
