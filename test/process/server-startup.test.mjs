import { version } from '../../src/version.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { socketFor, startServer } from '../../src/server.mjs';
import { rpc } from '../../src/rpc.mjs';

test('server IPC starts, answers requests and can restart with the same data directory', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-startup-'));
  let server;
  try {
    const address = socketFor(directory);
    assert.equal(socketFor(join(directory, '.')), address);
    assert.notEqual(socketFor(join(directory, 'other')), address);
    if (process.platform === 'win32') assert.ok(address.startsWith('\\\\.\\pipe\\'));
    for (let attempt = 0; attempt < 2; attempt++) {
      server = await startServer({ directory, hosts: new Map() });
      assert.deepEqual(await rpc(address, { op: 'ping' }), { version });
      const response = await fetch(new URL('/api/model-policy', server.url));
      assert.equal(response.status, 200);
      await response.text();
      await server.close();
      server = null;
    }
  } finally {
    await server?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
