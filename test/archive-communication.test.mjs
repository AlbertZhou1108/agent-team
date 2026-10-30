import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../src/bus.mjs';
import { confirmedGroup } from './helpers.mjs';

const _tick = () => new Promise(resolve => setImmediate(resolve));

async function until(predicate) {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('condition timed out');
}

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-post-archive-'));
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
    name: 'post-archive',
    workspace: directory,
    lead: { name: 'lead', host: 'fake' },
    members: [
      { name: 'executor', host: 'fake' },
      { name: 'reviewer', host: 'fake' },
    ],
  };
  const group = confirmedGroup(bus, spec);
  await until(() => bus.running.size === 0);
  t.after(async () => {
    await bus.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { bus, group, members: bus.members(group.id), calls };
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
  await until(() => bus.running.size === 0);
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
  assert.equal(bus.store.get('SELECT 1 FROM attached WHERE message_id=?', queued.id), undefined);
  await bus.restoreGroup(group.id);
  assert.equal(bus.collaboration.communicationOpen(group.id), true);
  bus.pump();
  await until(() => bus.running.size === 0 && bus.store.get('SELECT accepted FROM outbox WHERE id=(SELECT outbox_id FROM attached WHERE message_id=?)', queued.id)?.accepted);
  await bus.tool(executor.id, executor.key, 'send', { to: group.lead, text: '恢复后可以继续投递' });
  await until(() => bus.running.size === 0);
});
