import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.mjs';
import { confirmedGroup } from './helpers.mjs';

test('panel scopes messages before paging and preserves legacy cursors', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'panel-loading-'));
  const server = await startServer({ directory,  hosts: new Map([['fake', { async run() { return 'done'; } }]]) });
  t.after(async () => { await server.close(); rmSync(directory, { recursive: true, force: true }); });
  const group = confirmedGroup(server.bus, { name: 'paging', workspace: directory, lead: { name: 'lead', host: 'fake' }, members: [{ name: 'worker', host: 'fake' }] });
  const members = server.bus.members(group.id);
  const endpoint = server.bus.store.endpoint(members[0].id, 'pair:' + members[1].id, members[1].id);
  assert.ok(endpoint);
  const expected = [];
  for (let i = 0; i < 125; i++) {
    expected.push(server.bus.store.append(group.id, endpoint.member_id, endpoint.peer, 'note', `pair ${i}`));
    server.bus.store.append(group.id, members[0].id, 'other', 'note', `unrelated ${i}`);
  }
  const base = new URL(server.url).origin;
  const get = async path => { const response = await fetch(base + path); assert.equal(response.status, 200); return response.json(); };
  const path = `/api/messages?group=${group.id}&endpoint=${endpoint.id}&latest=1`;
  const recent = await get(path);
  assert.deepEqual(recent.map(m => m.id), expected.slice(-50).map(m => m.id));
  const older = await get(path + '&before=' + recent[0].seq);
  assert.deepEqual(older.map(m => m.id), expected.slice(25, 75).map(m => m.id));
  assert.equal((await get(path + '&after=' + recent.at(-1).seq)).length, 0);
  const next = server.bus.store.append(group.id, endpoint.peer, endpoint.member_id, 'note', 'new');
  assert.deepEqual((await get(path + '&after=' + recent.at(-1).seq)).map(m => m.id), [next.id]);
  assert.equal((await get(`/api/messages?group=${group.id}`)).length, 200);
  const nav = await get('/api/snapshot?scoped=1');
  assert.equal(nav.endpoints.length, 0);
  const scoped = await get(`/api/snapshot?scoped=1&group=${group.id}`);
  assert.ok(scoped.endpoints.length > 0);
  const foreign = await fetch(base + path.replace(endpoint.id, 'missing'));
  assert.equal(foreign.status, 404);
});
