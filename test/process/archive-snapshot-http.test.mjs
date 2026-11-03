import test from 'node:test';
import assert from 'node:assert/strict';
import { serverScenario, seedPanelAgent } from '../support/fixture.mjs';
import { until } from '../support/wait.mjs';

test('archive snapshot is readable and summarized through HTTP while ordinary archived content stays blocked', async t => {
  const { bus, group, url } = await serverScenario(t, { members: ['one'], finalText: 'HTTP summary' });
  await until(() => !bus.running.size);
  seedPanelAgent(bus, { host: 'fake' });
  const endpoint = new URL(`/api/teams/${group.id}/archive-snapshot`, url);
  const post = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' };
  await bus.archiveGroup(group.id);
  let response = await fetch(endpoint);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).summary, null);
  response = await fetch(new URL(`/api/messages?group=${group.id}`, url));
  assert.equal(response.status, 410);
  await response.text();
  response = await fetch(endpoint, { ...post, headers: { ...post.headers, Origin: 'https://example.com' } });
  assert.equal(response.status, 403);
  await response.text();
  response = await fetch(endpoint, post);
  assert.equal(response.status, 200);
  await response.json();
  await until(() => bus.archiveSnapshot(group.id).summary);
  response = await fetch(endpoint);
  assert.equal((await response.json()).summary, 'HTTP summary');
  bus.restoreGroup(group.id);
  response = await fetch(endpoint);
  assert.notEqual(response.status, 200);
  await response.text();
});

test('restore works with a legacy groups.state NOT NULL column', async t => {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = mkdtempSync(join(tmpdir(), 'archive-legacy-state-'));
  const legacy = new DatabaseSync(join(directory, 'groups.sqlite'));
  legacy.exec(`CREATE TABLE groups(id TEXT PRIMARY KEY,name TEXT NOT NULL,workspace TEXT NOT NULL,
    lead TEXT,created TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'open',execution_epoch INTEGER NOT NULL DEFAULT 0,
    charter TEXT,policy TEXT NOT NULL DEFAULT 'workspace-write',allow_shell INTEGER NOT NULL DEFAULT 1);`);
  legacy.close();
  const { bus, group, url } = await serverScenario(t, { directory, members: ['one'] });
  await until(() => !bus.running.size);
  await bus.archiveGroup(group.id);
  const previous = bus.archiveSnapshot(group.id).id;
  const response = await fetch(new URL(`/api/teams/${group.id}/restore`, url), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  assert.equal(JSON.parse(body).state, 'open');
  assert.equal(bus.collaboration.communicationOpen(group.id), true);
  await until(() => !bus.running.size);
  await bus.archiveGroup(group.id);
  assert.notEqual(bus.archiveSnapshot(group.id).id, previous);
});
