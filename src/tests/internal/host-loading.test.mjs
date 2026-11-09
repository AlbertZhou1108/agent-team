import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadHosts, socketFor } from '../../server.mjs';

test('loadHosts derives the shared socket when callers omit it', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-host-loading-'));
  const modulePath = join(directory, 'probe-host.mjs');
  const configPath = join(directory, 'hosts.json');
  writeFileSync(modulePath, `
    export async function createHost({ directory, socketPath }) {
      globalThis.__agentTeamHostProbe = { directory, socketPath };
      return { run() {} };
    }
  `);
  writeFileSync(configPath, JSON.stringify({
    hosts: {
      probe: { adapter: 'probe', module: modulePath },
    },
  }));
  t.after(() => {
    delete globalThis.__agentTeamHostProbe;
    rmSync(directory, { recursive: true, force: true });
  });

  await loadHosts({ directory, configFile: configPath });
  assert.equal(globalThis.__agentTeamHostProbe.directory, directory);
  assert.equal(globalThis.__agentTeamHostProbe.socketPath, socketFor(directory));
});
