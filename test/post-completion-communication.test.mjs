import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../src/bus.mjs';
import { confirmedGroup, testContract } from './helpers.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));

async function until(predicate) {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('condition timed out');
}

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-post-complete-'));
  const calls = [];
  const host = {
    async run(context) {
      calls.push(context);
      context.onSession(context.endpoint.session ?? context.endpoint.id);
      if (context.endpoint.context === 'profile') {
        await context.onTool('profile_set', { text: 'test profile' });
      }
      context.onAccepted();
      return 'done';
    },
  };
  const bus = new Bus({ directory, hosts: new Map([['fake', host]]) });
  const spec = {
    name: 'post-completion',
    workspace: directory,
    lead: { name: 'lead', host: 'fake' },
    members: [
      { name: 'executor', host: 'fake' },
      { name: 'reviewer', host: 'fake' },
    ],
  };
  const group = confirmedGroup(bus, spec, { ...testContract, reviewRequired: false });
  await until(() => bus.running.size === 0);
  t.after(async () => {
    await bus.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const members = bus.members(group.id);
  const actor = { role: 'lead', context: 'coordination', group_id: group.id };
  let operation = 0;
  const apply = command => bus.collaboration.apply(
    actor,
    command,
    bus.collaboration.state(group.id).revision,
    `post-complete-${++operation}`,
  );
  return { bus, group, members, calls, apply };
}

async function completeGoal(bus, group, members, apply) {
  let item = apply({
    title: 'completed result',
    purpose: 'preserve the accepted result',
    standard: 'result remains immutable',
    participants: [{ memberId: members[1].id, role: 'executor' }],
    policy: 'communication',
    allowShell: false,
    reviewRequired: false,
    note: 'create result',
  }).item;
  item = apply({
    id: item.id,
    itemRevision: item.revision,
    state: 'in_progress',
    note: 'start result',
  }).item;
  const report = bus.store.append(group.id, members[1].id, group.lead, 'send', 'accepted result v1');
  item = apply({
    id: item.id,
    itemRevision: item.revision,
    state: 'pending_decision',
    artifact: 'v1',
    evidence: [report.id],
    note: 'submit result',
  }).item;
  item = apply({
    id: item.id,
    itemRevision: item.revision,
    state: 'accepted',
    note: 'accept result',
  }).item;
  apply({
    action: 'finish',
    outcome: 'completed',
    final: 'accepted final result',
    note: 'all criteria covered',
    coverage: { c1: [item.id] },
    dispositions: [{ messageId: report.id, reason: 'used as accepted evidence' }],
  });
  assert.equal(bus.collaboration.reconcile(group.id, false), true);
  return item;
}

test('completed goal keeps group communication open without reopening accepted work', async t => {
  const { bus, group, members, calls, apply } = await fixture(t);
  const accepted = await completeGoal(bus, group, members, apply);
  const beforeRecords = bus.collaboration.read(group.id).records.length;

  const state = bus.collaboration.read(group.id);
  assert.equal(state.state.phase, 'closed');
  assert.equal(state.state.outcome, 'completed');
  assert.equal(state.communicationOpen, true);
  assert.equal(state.state.final, 'accepted final result');

  const coordinator = bus.store.endpoint(group.lead, 'coordination');
  const directive = bus.directive(group.id, '请解释已经接受的最终结果');
  await until(() => bus.running.size === 0 && bus.store.get('SELECT accepted FROM outbox WHERE id=(SELECT outbox_id FROM attached WHERE message_id=?)', directive.messageId)?.accepted);
  const coordinationRun = calls.findLast(call => call.endpoint.context === 'coordination');
  assert.equal(coordinationRun.policy.mode, 'communication');
  assert.equal(coordinationRun.policy.allowShell, false);
  assert.match(coordinationRun.instructions, /目标完成后群仍可继续沟通/);
  assert.match(coordinationRun.prompt, /请解释已经接受的最终结果/);

  const executor = bus.store.endpoint(members[1].id, `pair:${group.lead}`, group.lead);
  await assert.rejects(
    bus.tool(executor.id, executor.key, 'send', {
      to: group.lead,
      workItemId: accepted.id,
      text: '不能把后续聊天关联到已验收工作项',
    }),
    /不能关联旧工作项/,
  );
  const reply = await bus.tool(executor.id, executor.key, 'send', {
    to: group.lead,
    text: '目标完成后仍可继续讨论结果',
  });
  assert.ok(reply.messageId);
  await until(() => bus.running.size === 0 && bus.store.get('SELECT accepted FROM outbox WHERE id=(SELECT outbox_id FROM attached WHERE message_id=?)', reply.messageId)?.accepted);

  const reviewer = bus.store.endpoint(members[2].id, `pair:${members[1].id}`, members[1].id);
  const peerReply = await bus.tool(executor.id, executor.key, 'send', {
    to: members[2].id,
    text: '成员之间也可以在完成后继续交流',
  });
  assert.ok(peerReply.messageId);
  await until(() => bus.running.size === 0 && bus.store.get('SELECT accepted FROM outbox WHERE id=(SELECT outbox_id FROM attached WHERE message_id=?)', peerReply.messageId)?.accepted);
  assert.ok(calls.some(call => call.endpoint.id === reviewer.id && call.policy.mode === 'communication'));

  await bus.privateTurn(group.id, '请继续解释结果');
  assert.equal(calls.at(-1).endpoint.context, 'private');
  assert.equal(calls.at(-1).policy.mode, 'communication');

  const after = bus.collaboration.read(group.id);
  assert.equal(after.state.phase, 'closed');
  assert.equal(after.state.outcome, 'completed');
  assert.equal(after.state.final, 'accepted final result');
  assert.equal(after.items[0].state, 'accepted');
  assert.equal(after.items[0].revision, accepted.revision);
  assert.equal(after.records.length, beforeRecords);
  assert.throws(() => bus.collaboration.apply(
    { role: 'lead', context: 'coordination', group_id: group.id },
    { id: accepted.id, itemRevision: accepted.revision, state: 'in_progress', note: 'reopen silently' },
    after.state.revision,
    'post-complete-reopen',
  ), /closed/);
});

test('incomplete goal remains readable but communication stays stopped', async t => {
  const { bus, group } = await fixture(t);
  bus.collaboration.terminate(group.id, '必要证据缺失');
  assert.equal(bus.collaboration.reconcile(group.id, false), true);
  const state = bus.collaboration.read(group.id);
  assert.equal(state.state.phase, 'closed');
  assert.equal(state.state.outcome, 'incomplete');
  assert.equal(state.communicationOpen, false);
  assert.equal(state.outputs.length, 1);
  assert.match(state.outputs[0].body, /任务未完成/);
  assert.throws(() => bus.directive(group.id, '继续聊天'), /不接受消息/);
  await assert.rejects(bus.privateTurn(group.id, '继续聊天'), /不接受消息/);
});
