import test from 'node:test';
import assert from 'node:assert/strict';
import { busScenario, seedPanelAgent } from '../support/fixture.mjs';
import { until } from '../support/wait.mjs';
import { Bus } from '../../src/bus.mjs';

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
  bus.setAgentTasks({ ownerId: group.lead, groupId: group.id, tasks: [{ text: '检查', state: 'done' }] });
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
