// Agent 间请求-答复协议与工作台清理:显式 expects_reply/reply_to，清理只隐藏不删除。
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { busScenario, serverScenario, seedPanelAgent } from '../support/fixture.mjs';
import { until } from '../support/wait.mjs';
import { homeWorkbench, dismissWorkbench } from '../../productivity.mjs';

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
  assert.ok(bus.store.get('SELECT 1 FROM messages WHERE id=?', directive.id));
  assert.ok(bus.store.get('SELECT 1 FROM messages WHERE id=?', request.messageId));
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
