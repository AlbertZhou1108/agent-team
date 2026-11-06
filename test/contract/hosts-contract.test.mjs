// 宿主契约:注册表、可选方法校验、遥测能力表与"外部宿主模块"扩展路径。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOST_FACTORIES, DEFAULT_HOST_SPECS, assertHostContract } from '../../src/hosts/index.mjs';
import { telemetryCapabilitiesFor, UNIFIED_FIELDS } from '../../src/telemetry-capabilities.mjs';
import { loadHosts } from '../../src/server.mjs';

function tempDir(t) {
  const directory = mkdtempSync(join(tmpdir(), 'host-contract-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return directory;
}

test('builtin host factories and default specs stay in sync', () => {
  const names = [...HOST_FACTORIES.keys()].sort();
  assert.deepEqual(names, ['claude', 'codex', 'dsh']);
  assert.deepEqual(Object.keys(DEFAULT_HOST_SPECS).sort(), names);
  for (const [name, factory] of HOST_FACTORIES) {
    assert.equal(typeof factory, 'function');
    assert.equal(DEFAULT_HOST_SPECS[name].adapter, name);
  }
});

test('host contract accepts a complete adapter and rejects missing or invalid methods', () => {
  const adapter = { run: async () => 'ok', connectionStatus: () => ({ connected: true }), sessionKey: () => 'default' };
  assert.equal(assertHostContract('fake', adapter), adapter);
  assert.throws(() => assertHostContract('fake', {}), /缺少 run 接口/);
  assert.throws(() => assertHostContract('fake', { run: async () => 'ok', sessionKey: 'not-a-function' }), /sessionKey 不是函数/);
});

test('telemetry capabilities are declared for every builtin host and unknown hosts fall back', () => {
  for (const name of HOST_FACTORIES.keys()) {
    const value = telemetryCapabilitiesFor(name);
    assert.equal(value.host, name);
    assert.deepEqual(Object.keys(value.metrics), UNIFIED_FIELDS);
    assert.notEqual(value.metrics.inputTokensTotal.capability, undefined);
  }
  const unknown = telemetryCapabilitiesFor('unknown-host');
  assert.equal(unknown.host, 'unknown-host');
  assert.equal(unknown.metrics.inputTokensTotal.capability, 'unsupported');
});

test('an external host module is loaded through config and validated by the contract', async t => {
  const directory = tempDir(t);
  const modulePath = join(directory, 'fake-host.mjs');
  writeFileSync(modulePath, "export async function createHost() { return { run: async () => ({ ok: true }), connectionStatus: () => ({ connected: true }) }; }\n");
  const okConfig = join(directory, 'hosts-ok.json');
  writeFileSync(okConfig, JSON.stringify({ hosts: { fake: { adapter: 'fake', module: modulePath } } }));
  const hosts = await loadHosts({ directory, socketPath: join(directory, 'bus.sock'), configFile: okConfig });
  assert.equal(typeof hosts.get('fake').run, 'function');
  assert.equal(typeof hosts.get('fake').connectionStatus, 'function');

  const badModule = join(directory, 'bad-host.mjs');
  writeFileSync(badModule, "export async function createHost() { return { connectionStatus: () => ({}) }; }\n");
  const badConfig = join(directory, 'hosts-bad.json');
  writeFileSync(badConfig, JSON.stringify({ hosts: { fake: { adapter: 'fake', module: badModule } } }));
  await assert.rejects(loadHosts({ directory, socketPath: join(directory, 'bus.sock'), configFile: badConfig }), /缺少 run 接口/);
});
