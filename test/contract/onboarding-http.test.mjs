import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../src/server.mjs';
import { modelCatalog } from '../../src/hosts/catalog.mjs';

test('first use isolates hosts, resolves explicit defaults, creates teams once and downloads scoped results', async t => {
  const root = mkdtempSync(join(tmpdir(), 'first-use-'));
  const directory = join(root, 'data');
  const workspace = join(root, 'workspace'); mkdirSync(workspace);
  let otherCalls = 0, profiles = 0;
  const fake = {
    listModels: async () => modelCatalog({ host: 'fake', source: 'test', defaultModel: 'model', models: [{ id: 'model', isDefault: true, reasoningEfforts: ['low', 'high'] }] }),
    async run(ctx) { if (ctx.endpoint.context === 'profile') { profiles++; await ctx.onTool('profile_set', { text: 'fixture' }); } ctx.onAccepted(); return 'done'; },
    async probeConnection() { return { status: 'available' }; },
    connectionStatus() { return { status: 'available' }; },
  };
  let server = await startServer({ directory, hosts: new Map([['fake', fake], ['other', { async listModels() { otherCalls++; throw new Error('must not be queried'); } }]]) });
  t.after(async () => { await server.close(); rmSync(root, { recursive: true, force: true }); });
  const post = (path, body, headers = {}) => fetch(new URL(path, server.url), { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const catalog = await (await fetch(new URL('/api/model-catalog?host=fake', server.url))).json();
  assert.equal(catalog.hosts.length, 1); assert.equal(otherCalls, 0);
  const agent = await post('/api/panel-agent', { name: '助手', host: 'fake', workspace });
  assert.equal(agent.status, 200); const initialized = (await agent.json()).agent; assert.equal(initialized.model, 'model'); assert.equal(initialized.reasoning_effort, null); assert.equal(otherCalls, 0);
  const args = { operationId: 'create-once', name: 'team', workspace, lead: { name: 'lead', host: 'fake' }, members: [], policy: 'read-only' };
  const responses = await Promise.all([post('/api/groups', args), post('/api/groups', args)]);
  assert.ok(responses.every(response => response.status === 200));
  const [a, b] = await Promise.all(responses.map(response => response.json()));
  assert.equal(a.id, b.id); assert.equal(profiles, 1);
  assert.equal((await post('/api/groups', { ...args, name: 'changed' })).status, 400);
  assert.equal((await post('/api/groups', { ...args, operationId: 'cross-origin' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/api/hosts/probe', { host: 'fake' })).status, 200);
  assert.equal((await fetch(new URL('/api/hosts/connections', server.url))).status, 200);
  writeFileSync(join(workspace, 'result.txt'), 'delivered'); writeFileSync(join(directory, 'outside.txt'), 'private');
  const download = path => fetch(new URL(`/api/files?${new URLSearchParams({ group: a.id, path })}`, server.url));
  const result = await download('result.txt');
  assert.equal(await result.text(), 'delivered'); assert.match(result.headers.get('content-disposition'), /^attachment;/);
  assert.equal((await download('../outside.txt')).status, 404);
  if (process.platform !== 'win32') {
    symlinkSync(join(directory, 'outside.txt'), join(workspace, 'escape.txt'));
    assert.equal((await download('escape.txt')).status, 404);
  }
  server.bus.store.run("UPDATE groups SET policy='communication' WHERE id=?", a.id);
  assert.equal((await download('result.txt')).status, 404);
  server.bus.store.run("UPDATE groups SET policy='read-only',workspace=? WHERE id=?", root, a.id);
  assert.equal((await download('data/groups.sqlite')).status, 404);
  await server.close();
  server = await startServer({ directory, hosts: new Map([['fake', fake]]) });
  const replay = await post('/api/groups', args);
  assert.equal(replay.status, 200); assert.equal((await replay.json()).id, a.id); assert.equal(profiles, 1);
});
