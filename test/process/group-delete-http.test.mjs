import test from 'node:test';
import assert from 'node:assert/strict';
import { serverScenario } from '../support/fixture.mjs';
import { until } from '../support/wait.mjs';
import { handleRpc } from '../../src/server.mjs';

const post = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' };

test('panel deletion only accepts archived teams, validates input and blocks restore after deletion', async t => {
  const { bus, group, url } = await serverScenario(t, { members: ['one'] });
  await until(() => !bus.running.size);
  const endpoint = new URL(`/api/teams/${group.id}/delete`, url);
  let response = await fetch(endpoint, post);
  assert.equal(response.status, 400);
  assert.match(await response.text(), /先归档/);
  await bus.archiveGroup(group.id);
  response = await fetch(endpoint, { ...post, headers: { ...post.headers, Origin: 'https://example.com' } });
  assert.equal(response.status, 403); await response.text();
  response = await fetch(endpoint, { ...post, body: '{"unexpected":true}' });
  assert.equal(response.status, 400); await response.text();
  response = await fetch(endpoint, post);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { deleted: group.id });
  response = await fetch(new URL('/api/groups?archived=1', url));
  assert.ok(!(await response.json()).some(row => row.id === group.id));
  response = await fetch(new URL(`/api/teams/${group.id}/restore`, url), post);
  assert.equal(response.status, 400); await response.text();
});

test('RPC deletion also works for archived teams', async t => {
  const { bus, group } = await serverScenario(t, { members: ['one'] });
  await until(() => !bus.running.size);
  await bus.archiveGroup(group.id);
  assert.deepEqual(await handleRpc(bus, { op: 'delete', group: group.id }), { deleted: group.id });
});

test('HTTP delete confirmation reports database failure and persists a failed card', async t => {
  const { bus, group, url } = await serverScenario(t, { members: ['one'] });
  await until(() => !bus.running.size);
  const endpoint = bus.store.endpoint(group.lead, 'coordination');
  const card = await bus.tool(endpoint.id, endpoint.key, 'group_delete', {});
  bus.store.db.exec("CREATE TEMP TRIGGER block_delete BEFORE DELETE ON groups BEGIN SELECT RAISE(ABORT,'deletion blocked'); END");
  const response = await fetch(new URL(`/api/interactions/${card.id}/answer`, url), { ...post, body: JSON.stringify({ answer: { approved: true } }) });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /deletion blocked/);
  const interactions = await (await fetch(new URL(`/api/interactions?group=${group.id}`, url))).json();
  assert.equal(interactions.find(row => row.id === card.id)?.state, 'failed');
});
