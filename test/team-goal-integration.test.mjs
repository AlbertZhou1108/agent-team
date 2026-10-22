import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../src/bus.mjs';
import { confirmedGroup, testContract } from './helpers.mjs';

async function until(fn) {
  for (let index = 0; index < 400; index++) {
    if (fn()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('timeout');
}

test('member reports to the Main Agent carry the Current Goal id', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-goal-integration-'));
  const calls = [];
  const host = {
    async run(context) {
      calls.push(context);
      if (context.endpoint.context === 'profile') {
        await context.onTool('profile_set', { text: 'ready' });
      }
      context.onAccepted();
      return 'done';
    },
  };
  const bus = new Bus({ directory, hosts: new Map([['fake', host]]) });
  t.after(async () => {
    await bus.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const group = confirmedGroup(bus, {
    name: 'goal integration',
    workspace: directory,
    lead: { name: 'Lead', host: 'fake' },
    members: [{ name: 'Worker', host: 'fake' }],
  });
  await until(() => bus.running.size === 0);
  const worker = bus.members(group.id).find(member => member.role === 'member');
  assert.ok(worker);
  const goal = bus.lifecycle.read(group.id).current;
  assert.equal(goal.state, 'active');

  const coordination = bus.store.endpoint(group.lead, 'coordination');
  const assigned = await bus.tool(coordination.id, coordination.key, 'send', {
    to: worker.id,
    text: 'please execute',
  });
  assert.equal(
    bus.store.get(
      'SELECT goal_id FROM message_context WHERE message_id=?',
      assigned.messageId,
    ).goal_id,
    goal.id,
  );

  const endpoint = bus.store.endpoint(worker.id, `pair:${group.lead}`, group.lead);
  const sent = await bus.tool(endpoint.id, endpoint.key, 'send', {
    to: group.lead,
    text: 'member report',
  });
  const context = bus.store.get(
    'SELECT * FROM message_context WHERE message_id=?',
    sent.messageId,
  );
  assert.equal(context.goal_id, goal.id);
  await until(() => bus.running.size === 0);

  const beforeQueue = bus.lifecycle.read(group.id);
  const draft = bus.lifecycle.apply(
    group.id,
    { kind: 'main_agent', id: group.lead },
    {
      type: 'draft.create',
      contract: { ...testContract, goal: 'next queued goal' },
      requirements: { requiredMemberIds: [] },
    },
    beforeQueue.team.revision,
    'integration-queue-draft',
  );
  const queued = bus.lifecycle.apply(
    group.id,
    { kind: 'user', id: 'local-user' },
    {
      type: 'draft.confirm',
      draftId: draft.draft.id,
      draftRevision: draft.draft.revision,
      hash: draft.draft.hash,
    },
    draft.revision,
    'integration-queue-confirm',
  );
  assert.equal(queued.goal.state, 'queued');

  await bus.terminate(group.id, 'integration test complete');
  const promoted = bus.lifecycle.read(group.id).current;
  assert.equal(promoted.id, queued.goal.id);
  assert.equal(promoted.state, 'active');
  assert.equal(bus.collaboration.state(group.id).phase, 'active');
  assert.equal(bus.collaboration.state(group.id).goal_version, promoted.number);
  assert.equal(bus.collaboration.contract(group.id).body.goal, 'next queued goal');
  await until(() => calls.some(call => (
    call.endpoint.context === 'coordination'
    && call.prompt.includes(`Goal #${promoted.number}`)
  )));
  await until(() => bus.running.size === 0);

  await bus.terminate(group.id, 'finish promoted goal');
  assert.equal(
    bus.lifecycle.read(group.id).history.find(item => item.id === promoted.id).state,
    'terminated',
  );
  const directive = bus.directive(group.id, 'post-goal team chat');
  assert.equal(
    bus.store.get(
      'SELECT goal_id FROM message_context WHERE message_id=?',
      directive.messageId,
    ).goal_id,
    null,
  );
});
