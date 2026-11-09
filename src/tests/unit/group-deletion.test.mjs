import test from 'node:test';
import assert from 'node:assert/strict';
import { busScenario, seedPanelAgent } from '../support/fixture.mjs';
import { until } from '../support/wait.mjs';

async function fixture(t, run = null) {
  const f = busScenario(t, { members: [], profileText: null, run });
  await until(() => !f.bus.running.size);
  return f;
}

test('a failed database cleanup leaves the team accessible and can be retried', async t => {
  const { bus, group } = await fixture(t);
  bus.store.db.exec("CREATE TEMP TRIGGER block_cleanup BEFORE DELETE ON information_measurements BEGIN SELECT RAISE(ABORT,'cleanup blocked'); END");
  await assert.rejects(bus.deleteGroup(group.id), /cleanup blocked/);
  assert.equal(bus.groupSummary(group.id).communicationOpen, true);
  bus.store.db.exec('DROP TRIGGER block_cleanup');
  assert.deepEqual(await bus.deleteGroup(group.id), { deleted: group.id });
  assert.throws(() => bus.groupSummary(group.id), /找不到|不存在/);
});

test('delete confirmation awaits failure and exposes a failed card instead of success', async t => {
  const { bus, group } = await fixture(t);
  const endpoint = bus.store.endpoint(group.lead, 'coordination');
  const card = await bus.tool(endpoint.id, endpoint.key, 'group_delete', {});
  bus.store.db.exec("CREATE TEMP TRIGGER block_delete BEFORE DELETE ON groups BEGIN SELECT RAISE(ABORT,'deletion blocked'); END");
  await assert.rejects(Promise.resolve(bus.decideInteraction(card.id, { approved: true })), /deletion blocked/);
  assert.equal(bus.groupSummary(group.id).communicationOpen, true);
  assert.throws(() => bus.decideInteraction(card.id, { approved: false }), /已经结束/);
});

test('deletion prevents new runs while awaiting an existing host and stops the full run', async t => {
  let finish;
  let signal;
  const { bus, group } = await fixture(t, context => {
    signal = context.signal;
    return new Promise(resolve => { finish = resolve; });
  });
  const running = bus.privateTurn(group.id, 'existing run');
  await until(() => finish);
  const deleting = bus.deleteGroup(group.id);
  await until(() => signal.aborted);
  let attempt;
  try {
    attempt = await bus.runEndpoint(bus.store.endpoint(group.lead, 'coordination'), 'new run');
  } catch (error) { attempt = error; }
  finally { finish('stopped'); }
  await running;
  await deleting;
  assert.match(attempt?.message ?? '', /正在删除/);
  assert.equal(bus.running.size, 0);
});


test('deleting an archived team waits for summary cancellation and leaves no late snapshot', async t => {
  let finish;
  let signal;
  const { bus, group } = await fixture(t, context => {
    signal = context.signal;
    return new Promise(resolve => { finish = resolve; });
  });
  seedPanelAgent(bus, { host: 'fake' });
  await bus.archiveGroup(group.id);
  bus.summarizeArchive(group.id);
  await until(() => finish);
  const deleting = bus.deleteGroup(group.id, { archivedOnly: true });
  await until(() => signal.aborted);
  finish('late summary');
  await deleting;
  assert.throws(() => bus.archiveSnapshot(group.id), /不存在/);
  assert.equal(bus.archiveSnapshots.pending.size, 0);
  assert.equal(bus.running.size, 0);
});
