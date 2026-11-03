import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../../src/server.mjs';

test('host endpoints check independently and restrict installation to configured adapters', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'host-http-'));
  let installs = 0;
  let checks = 0;
  const host = { run() {}, async checkStatus() { checks++; return { status: 'missing' }; }, installationStatus() { return { installing: true, installation: { phase: 'installing' } }; }, async install() { installs++; return { status: 'available' }; } };
  const server = await startServer({ directory, hosts: new Map([
    ['cli', host], ['broken', { run() {}, checkStatus() { throw new Error('broken'); } }],
  ]) });
  const post = (path, body = {}, origin = server.url.slice(0, -1)) => fetch(new URL(path, server.url), {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body),
  });
  try {
    const response = await fetch(new URL('/api/hosts', server.url));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), [{ name: 'cli', status: 'missing' }, { name: 'broken', status: 'error', reason: 'broken' }]);
    for (let count = 0; count < 3; count++) {
      const progress = await fetch(new URL('/api/hosts/installations', server.url));
      assert.equal(progress.status, 200);
      assert.deepEqual(await progress.json(), [{ name: 'cli', installing: true, installation: { phase: 'installing' } }, { name: 'broken', installing: false }]);
    }
    assert.equal(checks, 1, 'polling progress must never execute host checks');
    assert.equal((await post('/api/hosts/cli/install', {}, 'https://external.example')).status, 403);
    assert.equal((await post('/api/hosts/cli/install', { command: 'bad' })).status, 400);
    assert.equal((await post('/api/hosts/unknown/install')).status, 404);
    assert.equal((await post('/api/hosts/broken/install')).status, 400);
    assert.equal(installs, 0);
    const installed = await post('/api/hosts/cli/install');
    assert.equal(installed.status, 200);
    assert.deepEqual(await installed.json(), { name: 'cli', status: 'available' });
    assert.equal(installs, 1);
  } finally {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
