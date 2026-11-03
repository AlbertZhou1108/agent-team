import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { busScenario, seedPanelAgent } from '../support/fixture.mjs';
import { until } from '../support/wait.mjs';

test('deletion removes non-FK team records and snapshot, retaining unrelated and private data', async t => {
  const { bus, group, directory } = busScenario(t, { members: [], profileText: null });
  await until(() => !bus.running.size);
  const agent = seedPanelAgent(bus, { host: 'fake' });
  const other = bus.createGroup({ name: 'other', workspace: directory, lead: { name: 'other lead', host: 'fake' }, members: [] });
  await until(() => !bus.running.size);
  const endpoint = bus.store.endpoint(group.lead, 'coordination');
  const message = bus.store.append(group.id, group.lead, 'user', 'send', 'delete');
  const ask = bus.store.createInteraction({ id: 'audit-card', groupId: group.id, memberId: group.lead, endpointId: endpoint.id, context: 'coordination', turnId: '', callId: 'audit-call', messageId: message.id, kind: 'input', payload: { text: 'question' } });
  bus.store.dismissWorkbench('interaction', ask.id);
  bus.store.dismissWorkbench('waiting:user', message.id);
  bus.store.dismissWorkbench('waiting:agent', message.id);
  bus.store.dismissWorkbench('waiting:user', 'unrelated');
  bus.telemetry.rotateSession(endpoint.id, 'default');
  const privateMessage = bus.store.panelAppend(agent, 'private', 'user', 'keep private', group.id);
  bus.store.panelAppend(agent, 'coordination', 'assistant', 'delete coordination', group.id);
  const file = join(directory, 'project.txt');
  writeFileSync(file, 'keep');
  await bus.archiveGroup(group.id);
  bus.summarizeArchive(group.id);
  await until(() => !bus.archiveSnapshot(group.id).generating);
  await bus.deleteGroup(group.id);
  for (const table of ['members', 'messages', 'conversations', 'turns', 'interactions', 'agent_tasks', 'archive_snapshots', 'information_measurements']) {
    assert.equal(bus.store.get(`SELECT count(*) n FROM ${table} WHERE group_id=?`, group.id).n, 0, table);
  }
  assert.equal(bus.store.get('SELECT count(*) n FROM telemetry_session_generations WHERE endpoint_id=?', endpoint.id).n, 0);
  assert.deepEqual(bus.store.all('SELECT item_id FROM workbench_dismissals').map(row => row.item_id), ['unrelated']);
  assert.equal(bus.store.get('SELECT count(*) n FROM panel_messages WHERE active_team_id=?', group.id).n, 0);
  assert.equal(bus.store.get('SELECT text FROM panel_messages WHERE id=?', privateMessage.id).text, 'keep private');
  assert.equal(bus.store.group(other.id).name, 'other');
  assert.equal(readFileSync(file, 'utf8'), 'keep');
  assert.deepEqual(bus.store.all('PRAGMA foreign_key_check'), []);
});

test('a failed final team delete rolls back earlier non-FK cleanup', async t => {
  const { bus, group } = busScenario(t, { members: [], profileText: null });
  await until(() => !bus.running.size);
  const agent = seedPanelAgent(bus, { host: 'fake' });
  const endpoint = bus.store.endpoint(group.lead, 'coordination');
  const message = bus.store.append(group.id, group.lead, 'user', 'send', 'retain on rollback');
  bus.store.dismissWorkbench('waiting:agent', message.id);
  bus.telemetry.rotateSession(endpoint.id, 'default');
  const panelMessage = bus.store.panelAppend(agent, 'coordination', 'assistant', 'retain', group.id);
  bus.store.db.exec("CREATE TEMP TRIGGER block_delete BEFORE DELETE ON groups BEGIN SELECT RAISE(ABORT,'delete blocked'); END");
  await assert.rejects(bus.deleteGroup(group.id), /delete blocked/);
  assert.ok(bus.store.group(group.id));
  assert.ok(bus.store.get('SELECT 1 FROM workbench_dismissals WHERE item_id=?', message.id));
  assert.ok(bus.store.get('SELECT 1 FROM telemetry_session_generations WHERE endpoint_id=?', endpoint.id));
  assert.ok(bus.store.get('SELECT 1 FROM panel_messages WHERE id=?', panelMessage.id));
  assert.ok(bus.store.get('SELECT 1 FROM information_measurements WHERE group_id=?', group.id));
});

test('deletion waits for executor completion callbacks, not only the host result', async t => {
  const { bus, group } = busScenario(t, { members: [], profileText: null });
  await until(() => !bus.running.size);
  let complete;
  const original = bus.turnExecutor.run.bind(bus.turnExecutor);
  bus.turnExecutor.run = config => original({ ...config, onComplete: () => new Promise(resolve => { complete = resolve; }) });
  const running = bus.privateTurn(group.id, 'finish callback');
  await until(() => complete);
  let deleted = false;
  const deleting = bus.deleteGroup(group.id).then(() => { deleted = true; });
  await new Promise(resolve => setImmediate(resolve));
  const deletedEarly = deleted;
  complete();
  await running;
  await deleting;
  assert.equal(deletedEarly, false);
  assert.equal(bus.running.size, 0);
});
