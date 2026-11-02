import test from 'node:test';
import net from 'node:net';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rpc } from '../src/rpc.mjs';
import { socketFor } from '../src/server.mjs';
import { applicationData, launch, discover, stopService } from '../src/launcher.mjs';

test('application data is stable and separate from the current directory', () => {
  assert.equal(applicationData({ platform: 'darwin', home: '/user', env: {} }), join('/user', 'Library', 'Application Support', 'Agent Team'));
  assert.equal(applicationData({ platform: 'linux', home: '/user', env: { XDG_DATA_HOME: '/data' } }), join('/data', 'agent-team'));
  assert.equal(applicationData({ platform: 'win32', home: '/user', env: { LOCALAPPDATA: '/local' } }), join('/local', 'Agent Team'));
});

test('concurrent launchers discover and reuse one service; stop preserves data', { timeout: 30000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'launcher 中文 space-'));
  const configFile = join(directory, 'hosts.json');
  writeFileSync(configFile, JSON.stringify({ hosts: {} }));
  t.after(async () => { await stopService(directory); rmSync(directory, { recursive: true, force: true }); });
  const [first, second] = await Promise.all([launch({ directory, configFile }), launch({ directory, configFile })]);
  assert.equal(first.pid, second.pid);
  assert.equal(first.instanceId, second.instanceId);
  assert.equal((await launch({ directory, configFile })).reused, true);
  assert.equal((await discover(directory)).url, first.url);
  await assert.rejects(rpc(socketFor(directory), { op: 'service_stop', instanceId: 'stale-instance' }), /实例已变更/);
  assert.equal(await stopService(directory), true);
  assert.equal(existsSync(join(directory, 'owner.json')), false);
  assert.equal(existsSync(join(directory, 'groups.sqlite')), true);
  assert.equal(await discover(directory), null);
  const next = await launch({ directory, configFile });
  assert.notEqual(next.instanceId, first.instanceId);
  assert.equal(next.url, first.url);
});


test('an occupied remembered port falls back without stopping its owner', { timeout: 30000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'launcher-port-'));
  const configFile = join(directory, 'hosts.json'); writeFileSync(configFile, JSON.stringify({ hosts: {} }));
  const occupied = net.createServer();
  t.after(async () => {
    await stopService(directory);
    if (occupied.listening) await new Promise(resolve => occupied.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  const first = await launch({ directory, configFile });
  await stopService(directory);
  await new Promise((resolve, reject) => { occupied.once('error', reject); occupied.listen(Number(new URL(first.url).port), '127.0.0.1', resolve); });
  const next = await launch({ directory, configFile });
  assert.notEqual(next.url, first.url);
  assert.equal(occupied.listening, true);
});
