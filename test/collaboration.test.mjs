import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../src/bus.mjs';
import { confirmedGroup, testContract } from './helpers.mjs';

const tick = () => new Promise(r => setImmediate(r));
async function until(fn) { for (let i = 0; i < 300; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error('timeout'); }
async function fixture(t, run) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-contract-'));
  const calls = [];
  const host = { async run(c) {
    calls.push(c); c.onSession(c.endpoint.session ?? c.endpoint.id);
    if (c.endpoint.context === 'profile') { await c.onTool('profile_set', { text: 'test profile' }); c.onAccepted(); return ''; }
    if (run) return run(c);
    c.onAccepted(); return 'done';
  } };
  const bus = new Bus({ directory, hosts: new Map([['fake', host]]) });
  const spec = { name: 'isolated', workspace: directory, lead: { name: 'lead', host: 'fake' }, members: [{ name: 'executor', host: 'fake' }, { name: 'reviewer', host: 'fake' }] };
  const group = confirmedGroup(bus, spec);
  await until(() => !bus.running.size);
  t.after(async () => { await bus.close(); rmSync(directory, { recursive: true, force: true }); });
  const members = bus.members(group.id);
  const actor = { role: 'lead', context: 'coordination', group_id: group.id };
  let op = 0;
  const apply = command => bus.collaboration.apply(actor, command, bus.collaboration.state(group.id).revision, `op-${++op}`);
  const create = (extra = {}) => apply({ title: '成果', purpose: '满足目标', standard: '可复核', participants: [{ memberId: members[1].id, role: 'executor' }, { memberId: members[2].id, role: 'reviewer' }], note: '派发', ...extra }).item;
  const update = (item, change) => apply({ id: item.id, itemRevision: bus.collaboration.item(item.id, group.id).revision, note: '依据证据推进', ...change }).item;
  const report = (member, text) => {
    const message = bus.store.append(group.id, member.id, group.lead, 'send', text);
    bus.store.run('INSERT INTO message_context VALUES(?,?,?)', message.id, null, bus.collaboration.state(group.id).contract_version);
    return message;
  };
  return { bus, group, directory, spec, members, actor, apply, create, update, report, calls };
}

test('preparation confirmation binds exact version, is idempotent, and cannot be approved by an agent', async t => {
  const { bus, spec, calls } = await fixture(t);
  const n = calls.length;
  let p = bus.prepareGroup(spec);
  assert.throws(() => bus.confirmPreparation(p.id, 0, null), /不匹配/);
  p = bus.collaboration.propose(p.id, testContract, 0);
  const old = p;
  p = bus.collaboration.propose(p.id, { ...testContract, goal: '新目标' }, p.revision);
  assert.throws(() => bus.confirmPreparation(p.id, old.revision, old.hash), /不匹配/);
  assert.equal(calls.length, n);
  const g = bus.confirmPreparation(p.id, p.revision, p.hash);
  assert.equal(bus.confirmPreparation(p.id, p.revision, p.hash).id, g.id);
  const e = bus.store.endpoint(g.lead, 'coordination');
  await assert.rejects(bus.tool(e.id, e.key, 'approve_preparation', {}), /不存在|不可使用/);
  assert.equal(bus.store.all('SELECT * FROM contract_versions WHERE group_id=?', g.id).length, 1);
});

test('work items preserve multi-member responsibility, independent reviews, revisions and rework', async t => {
  const { bus, group, members, actor, create, update, report } = await fixture(t);
  let item = create({ reviewRequired: true });
  assert.equal(item.participants.length, 2);
  assert.throws(() => bus.collaboration.apply({ ...actor, role: 'member' }, {}, 1, 'bad'), /仅主/);
  const start = { id: item.id, itemRevision: item.revision, state: 'in_progress', note: '开始执行' };
  const rev = bus.collaboration.state(group.id).revision;
  const first = bus.collaboration.apply(actor, start, rev, 'idempotent');
  assert.deepEqual(bus.collaboration.apply(actor, start, rev, 'idempotent'), first);
  assert.throws(() => bus.collaboration.apply(actor, { ...start, note: '改写' }, rev, 'idempotent'), /不同命令/);
  assert.throws(() => bus.collaboration.apply(actor, start, rev, 'stale'), /版本冲突/);
  item = first.item;
  const evidence = report(members[1], '成果v1');
  assert.throws(() => update(item, { state: 'pending_decision', artifact: 'v1', evidence: [evidence.id] }), /审查尚未/);
  assert.throws(() => update(item, { reviews: [{ messageId: evidence.id, artifact: 'v1' }], artifact: 'v1' }), /独立审查/);
  const review = report(members[2], 'v1通过，意见保留在原消息');
  assert.throws(() => update(item, { reviews: [{ messageId: review.id, artifact: 'v0' }], artifact: 'v1' }), /版本不一致/);
  item = update(item, { state: 'pending_decision', artifact: 'v1', evidence: [evidence.id], reviews: [{ messageId: review.id, artifact: 'v1' }] });
  item = update(item, { state: 'accepted' });
  assert.throws(() => update(item, { artifact: 'v2' }), /重新打开|版本不一致/);
  item = update(item, { state: 'in_progress', artifact: 'v2', reviews: [], evidence: [] });
  item = update(item, { state: 'blocked' });
  item = update(item, { state: 'in_progress' });
  assert.equal(item.state, 'in_progress');
  assert.equal(bus.store.get('SELECT text FROM messages WHERE id=?', review.id).text, 'v1通过，意见保留在原消息');
});

test('cancellation cannot erase responsibility and finish waits for messages and actual running caller', async t => {
  const { bus, group, members, create, update, report, apply } = await fixture(t);
  let item = create();
  assert.throws(() => update(item, { state: 'cancelled' }), /取消必须/);
  const extra = create();
  assert.throws(() => update(extra, { state: 'cancelled', cancellation: { kind: 'covered', by: [item.id], reason: '覆盖' } }), /已接受/);
  item = update(item, { state: 'in_progress' });
  const m = report(members[1], '完成');
  item = update(item, { state: 'pending_decision', artifact: 'v1', evidence: [m.id] });
  item = update(item, { state: 'accepted' });
  update(extra, { state: 'cancelled', cancellation: { kind: 'covered', by: [item.id], reason: '重复责任已由成果覆盖' } });
  assert.throws(() => apply({ action: 'finish', outcome: 'completed', final: '完成', note: '已检查', coverage: {} }), /覆盖/);
  assert.throws(() => apply({ action: 'finish', outcome: 'completed', final: '正式交付', note: '满足契约', coverage: { c1: [item.id] } }), /未处理消息.*1:/);
  assert.equal(bus.collaboration.state(group.id).phase, 'active');
  apply({ action: 'finish', outcome: 'completed', final: '正式交付', note: '满足契约', coverage: { c1: [item.id] }, dispositions: [{ messageId: m.id, reason: '已作为贡献证据采纳' }] });
  assert.equal(bus.collaboration.reconcile(group.id, true), false);
  assert.throws(() => bus.directive(group.id, '新工作'), /closing/);
  bus.collaboration.reopen(group.id, '处理尚未交付的消息');
  apply({ action: 'finish', outcome: 'completed', final: '正式交付', note: '满足契约', coverage: { c1: [item.id] }, dispositions: [{ messageId: m.id, reason: '已作为贡献证据采纳' }] });
  assert.equal(bus.collaboration.reconcile(group.id, true), false);
  assert.equal(bus.collaboration.reconcile(group.id, false), true);
  assert.equal(bus.collaboration.read(group.id).outputs.length, 1);
  assert.equal(bus.collaboration.reconcile(group.id, false), false);
  assert.throws(() => bus.collaboration.terminate(group.id, '改写'), /已结束/);
});

test('contract proposals require explicit versioned user decision; scope cannot escalate by work item', async t => {
  const { bus, group, create } = await fixture(t);
  assert.throws(() => create({ policy: 'workspace-write' }), /超出契约/);
  const c = bus.collaboration;
  const r = c.request(group.id, 'contract', { contract: { ...testContract, goal: '变更目标' }, reason: '需用户确认' });
  assert.equal(c.contract(group.id).body.goal, testContract.goal);
  assert.throws(() => c.decideRequest(group.id, r.requestId, true, 1, true), /当前回合/);
  assert.throws(() => c.decideRequest(group.id, r.requestId, true, 2, false), /过期/);
  c.decideRequest(group.id, r.requestId, true, 1, false);
  assert.equal(c.contract(group.id).version, 2);
  assert.equal(c.contract(group.id).body.goal, '变更目标');
  assert.equal(bus.store.all('SELECT * FROM contract_versions WHERE group_id=?', group.id).length, 2);
});

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

test('unknown runtime prevents replay and user termination preserves incomplete work', async t => {
  const { bus, group, create } = await fixture(t);
  const item = create();
  bus.store.run('INSERT INTO runtime_attempts VALUES(?,?,?,?,?,?,?,?,?)', 'interrupted', group.id, 'old-endpoint', 'unknown', '{}', 1, '无法核实', new Date().toISOString(), null);
  assert.throws(() => bus.directive(group.id, '继续'), /待核实/);
  bus.collaboration.terminate(group.id, '无法取得必要证据');
  assert.equal(bus.collaboration.reconcile(group.id, false), false);
  bus.collaboration.resolveRuntime(group.id, 'interrupted', '用户确认原进程已退出');
  assert.equal(bus.collaboration.reconcile(group.id, false), true);
  assert.equal(bus.collaboration.item(item.id, group.id).state, 'pending');
  assert.equal(bus.collaboration.state(group.id).outcome, 'incomplete');
});
