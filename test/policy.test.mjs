import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../src/bus.mjs';
import { confirmedGroup, testContract } from './helpers.mjs';

async function until(fn) {
  const end = Date.now() + 2500;
  while (!fn()) {
    if (Date.now() > end) throw new Error('condition timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('policy follows task and role while contract remains the ceiling', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-policy-'));
  const bus = new Bus({
    directory,
    hosts: new Map([['fake', {
      async run(c) {
        if (c.endpoint.context === 'profile') await c.onTool('profile_set', { text: 'policy test' });
        c.onAccepted();
        return '';
      },
    }]]),
  });
  const group = confirmedGroup(bus, {
    name: 'policy',
    workspace: directory,
    lead: { name: 'lead', host: 'fake' },
    members: [{ name: 'executor', host: 'fake' }, { name: 'reviewer', host: 'fake' }],
  }, { ...testContract, policy: 'workspace-write', allowShell: true });
  await until(() => !bus.running.size);
  t.after(async () => { if (!bus.closing) await bus.close(); rmSync(directory, { recursive: true, force: true }); });
  bus.pump = () => {};
  const [lead, executor, reviewer] = bus.members(group.id);
  const actor = { role: 'lead', context: 'coordination', group_id: group.id };
  let operation = 0;
  const apply = command => bus.collaboration.apply(
    actor,
    command,
    bus.collaboration.state(group.id).revision,
    `policy-${++operation}`,
  );
  const item = apply({
    title: 'mixed roles',
    purpose: 'verify role narrowing',
    standard: 'executor may write and reviewer may only read',
    participants: [
      { memberId: executor.id, role: 'executor' },
      { memberId: reviewer.id, role: 'reviewer' },
    ],
    policy: 'workspace-write',
    allowShell: true,
    reviewRequired: false,
    note: 'policy test',
  }).item;

  const contextual = recipient => {
    const message = bus.store.append(group.id, lead.id, recipient.id, 'send', 'policy input');
    bus.store.run(
      'INSERT INTO message_context(message_id,work_item_id,contract_version) VALUES(?,?,?)',
      message.id,
      item.id,
      1,
    );
    return message;
  };
  const executorPolicy = bus.collaboration.policy(
    bus.store.endpoint(executor.id, `pair:${lead.id}`, lead.id),
    [contextual(executor)],
  );
  const reviewerPolicy = bus.collaboration.policy(
    bus.store.endpoint(reviewer.id, `pair:${lead.id}`, lead.id),
    [contextual(reviewer)],
  );
  const coordinationInput = contextual(lead);
  assert.equal(bus.collaboration.policy(bus.store.endpoint(lead.id, 'coordination'), [coordinationInput]).mode, 'communication');
  const coordinator = bus.collaboration.policy(
    bus.store.endpoint(lead.id, 'coordination'),
    [bus.store.append(group.id, executor.id, lead.id, 'send', 'report')],
  );

  assert.deepEqual(
    { mode: executorPolicy.mode, shell: executorPolicy.allowShell, domain: executorPolicy.domain },
    { mode: 'workspace-write', shell: true, domain: 'project' },
  );
  assert.deepEqual(
    { mode: reviewerPolicy.mode, shell: reviewerPolicy.allowShell, domain: reviewerPolicy.domain },
    { mode: 'read-only', shell: true, domain: 'project' },
  );
  assert.equal(coordinator.mode, 'communication');
  assert.equal(coordinator.domain, 'communication');
  assert.equal(coordinator.allowShell, false);
  const unassociated = bus.store.append(group.id, lead.id, executor.id, 'send', 'unassociated');
  assert.throws(
    () => bus.collaboration.policy(
      bus.store.endpoint(executor.id, `pair:${lead.id}`, lead.id),
      [contextual(executor), unassociated],
    ),
    /不同执行策略/,
  );
});

test('host session key persists communication and project sessions independently', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-policy-domain-'));
  const calls = [];
  const host = {
    sessionKey({ policy }) { return policy.domain; },
    async run(c) {
      if (c.endpoint.context === 'profile') {
        await c.onTool('profile_set', { text: 'policy sessions' });
        c.onAccepted();
        return '';
      }
      calls.push({
        mode: c.policy.mode,
        domain: c.policy.domain,
        session: c.endpoint.session,
        previous: c.previousPolicy?.signature,
      });
      c.onPolicy({ signature: `${c.policy.domain}:${c.policy.mode}:${c.policy.allowShell}` });
      c.onSession(`${c.endpoint.id}:${c.policy.domain}`);
      c.onAccepted();
      return c.policy.domain;
    },
  };
  const bus = new Bus({ directory, hosts: new Map([['fake', host]]) });
  const group = confirmedGroup(bus, {
    name: 'domains',
    workspace: directory,
    lead: { name: 'lead', host: 'fake' },
    members: [{ name: 'worker', host: 'fake' }],
  }, { ...testContract, policy: 'workspace-write', allowShell: false });
  await until(() => !bus.running.size);
  t.after(async () => { if (!bus.closing) await bus.close(); rmSync(directory, { recursive: true, force: true }); });
  bus.pump = () => {};
  const [lead, worker] = bus.members(group.id);
  const actor = { role: 'lead', context: 'coordination', group_id: group.id };
  let operation = 0;
  const item = policy => {
    const result = bus.collaboration.apply(actor, {
      title: `item-${policy}`,
      purpose: policy,
      standard: policy,
      participants: [{ memberId: worker.id, role: 'executor' }],
      policy,
      allowShell: false,
      reviewRequired: false,
      note: 'domain test',
    }, bus.collaboration.state(group.id).revision, `domain-${++operation}`).item;
    return bus.collaboration.apply(actor, {
      id: result.id,
      itemRevision: result.revision,
      state: 'in_progress',
      note: 'start',
    }, bus.collaboration.state(group.id).revision, `domain-${++operation}`).item;
  };
  const communication = item('communication');
  const project = item('workspace-write');
  const run = item => {
    const message = bus.store.append(group.id, lead.id, worker.id, 'send', item.title);
    bus.store.run(
      'INSERT INTO message_context(message_id,work_item_id,contract_version) VALUES(?,?,?)',
      message.id,
      item.id,
      1,
    );
    return bus.runEndpoint(bus.store.endpoint(worker.id, `pair:${lead.id}`, lead.id), item.title, () => {}, [message]);
  };

  assert.equal(await run(communication), 'communication');
  assert.equal(await run(project), 'project');
  assert.equal(await run(communication), 'communication');
  const endpoint = bus.store.endpoint(worker.id, `pair:${lead.id}`, lead.id);
  assert.equal(calls[0].session, null);
  assert.equal(calls[1].session, null);
  assert.equal(calls[2].session, `${endpoint.id}:communication`);
  assert.equal(calls[2].previous, 'communication:communication:false');
  assert.equal(bus.snapshot().sessionBindings.length, 2);
});

test('unsupported host policy is rejected before a work item is committed', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-policy-preflight-'));
  const host = {
    supportsPolicy({ policy }) {
      return policy.mode === 'workspace-write'
        ? { supported: false, reason: 'test host cannot enforce writes' }
        : { supported: true };
    },
    async run(c) {
      if (c.endpoint.context === 'profile') await c.onTool('profile_set', { text: 'preflight' });
      c.onAccepted();
      return '';
    },
  };
  const bus = new Bus({ directory, hosts: new Map([['limited', host]]) });
  const group = confirmedGroup(bus, {
    name: 'preflight',
    workspace: directory,
    lead: { name: 'lead', host: 'limited' },
    members: [{ name: 'worker', host: 'limited' }],
  }, { ...testContract, policy: 'workspace-write', allowShell: false });
  await until(() => !bus.running.size);
  t.after(async () => { if (!bus.closing) await bus.close(); rmSync(directory, { recursive: true, force: true }); });
  const worker = bus.members(group.id).find(member => member.role === 'member');
  assert.throws(() => bus.collaboration.apply({
    role: 'lead',
    context: 'coordination',
    group_id: group.id,
  }, {
    title: 'unsupported write',
    purpose: 'preflight',
    standard: 'must fail',
    participants: [{ memberId: worker.id, role: 'executor' }],
    policy: 'workspace-write',
    allowShell: false,
    reviewRequired: false,
    note: 'preflight',
  }, bus.collaboration.state(group.id).revision, 'preflight-write'), /test host cannot enforce writes/);
  assert.equal(bus.store.all('SELECT * FROM work_items').length, 0);
});
