import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../src/server.mjs';
import { createTestGroup } from '../support/fixture.mjs';

test('query projections isolate teams and never compute list model histories', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'query-projections-'));
  const server = await startServer({ directory, hosts: new Map([['fake', { async run() { return 'done'; } }]]) });
  t.after(async () => { await server.close(); rmSync(directory, { recursive: true, force: true }); });
  const create = name => createTestGroup(server.bus, { name, workspace: directory, lead: { name: 'lead', host: 'fake' }, members: [{ name: 'worker', host: 'fake' }] });
  const group = create('one'); const other = create('two');
  const base = new URL(server.url).origin;
  const get = async path => { const response = await fetch(base + path); assert.equal(response.status, 200, await response.clone().text()); return response.json(); };
  server.bus.store.endpointModelSummary = () => { throw new Error('list must not scan history'); };
  const sessions = await get(`/api/sessions?group=${group.id}`);
  assert.ok(sessions.endpoints.length);
  assert.ok(sessions.endpoints.every(row => row.group_id === group.id && !('modelState' in row) && !('key' in row)));
  const lead = server.bus.members(group.id)[0];
  const endpoint = server.bus.store.endpoint(lead.id, 'coordination');
  assert.equal((await get(`/api/session?group=${group.id}&endpoint=${endpoint.id}`)).id, endpoint.id);
  assert.equal((await fetch(base + `/api/session?group=${other.id}&endpoint=${endpoint.id}`)).status, 404);
  assert.deepEqual(await get('/api/panel-agent/unread'), { messages: [], receipts: [] });
  assert.equal((await get('/api/groups')).length, 2);
  assert.ok((await get('/api/directory')).members.length >= 4);
  assert.equal((await get(`/api/group?group=${group.id}`)).controller.kind, 'member');
  assert.deepEqual(await get(`/api/group-runtime?group=${group.id}`), []);
  assert.deepEqual(await get(`/api/agent-tasks?group=${group.id}`), {
    currentPlan: null,
    historicalPlans: [],
    memberTasks: [],
    cancelledSteps: [],
  });
  assert.deepEqual(await get('/api/home-summary'), []);
  assert.ok((await get('/api/model-policy/defaults')).smart);
  await server.bus.archiveGroup(group.id);
  assert.equal((await get('/api/groups')).some(row => row.id === group.id), false);
  assert.equal((await get('/api/groups?archived=1')).some(row => row.id === group.id), true);
  for (const path of [`/api/group?group=${group.id}`, `/api/messages?group=${group.id}`, `/api/models?endpoint=${endpoint.id}`, `/api/teams/${group.id}/events`]) assert.equal((await fetch(base+path)).status,410);
  server.bus.restoreGroup(group.id);
  assert.equal((await get(`/api/group?group=${group.id}`)).id,group.id);

});
