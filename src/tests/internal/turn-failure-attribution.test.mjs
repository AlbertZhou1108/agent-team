// 失败归因：回合失败时，若本次策略确实开放了执行能力，detail 追加一条声明说明。
// 断言的是回合内部表示（turns.detail），因此放在 internal 层。
import test from 'node:test';
import assert from 'node:assert/strict';
import { busScenario } from '../support/fixture.mjs';

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
