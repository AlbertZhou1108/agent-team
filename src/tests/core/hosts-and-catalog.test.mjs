import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOST_FACTORIES, DEFAULT_HOST_SPECS, assertHostContract } from '../../hosts/index.mjs';
import { HOST_DEFINITIONS } from '../../hosts/definitions.mjs';
import { wakeDriverFor } from '../../host-runtime/wake-drivers.mjs';
import { telemetryCapabilitiesFor, UNIFIED_FIELDS } from '../../telemetry-capabilities.mjs';
import { loadHosts, startServer } from '../../server.mjs';
import { Bus } from '../../bus.mjs';
import { createCodexHost } from '../../member/codex/index.mjs';
import { createClaudeHost, createDshHost } from '../../hosts/cli-hosts.mjs';
import { createZcodeHost, zcodeMcpConfig, trustAgentTeamServer, trustWorkspaceMcpServers } from '../../member/zcode/index.mjs';
import { modelCatalog } from '../../hosts/catalog.mjs';
import { rpc } from '../../rpc.mjs';
import { CAPABILITY_IDS, CAPABILITY_GROUPS, normalizeDeclaration, hasCapability, deriveRoles, resolveCapabilities, controllerCapabilityIds, mergeDeclarations, canonicalMemberCapabilityId, canonicalMemberCapabilityIds, describeDeclaredCapabilities } from '../../hosts/capabilities.mjs';
import { BROWSER_MCP_UNAVAILABLE_REASON, normalizeBrowserProbeResult, probeBrowserMcpServers, resolveHostCommand } from '../../hosts/browser-mcp-probe.mjs';
import { claudeMcpAllowRule, claudeExecutionConfig, dshMcpToolPrefix } from '../../hosts/policies.mjs';
import { claudeMcpServersConfig, summarizeHostStderr } from '../../host-runtime/process.mjs';
import { apply as applyDshPolicy } from '../../member/dsh/policy.mjs';
import { runInNewContext } from 'node:vm';
import { readDshApiKey, dshProcessEnv } from '../../member/dsh/credentials.mjs';
import { runDshCatalogProbe } from '../../member/dsh/index.mjs';
import { dshWakeEnv, wakeDshSession } from '../../member/dsh/wake.mjs';

describe('hosts-contract', () => {
function tempDir(t) {
  const directory = mkdtempSync(join(tmpdir(), 'host-contract-'));
  t.after(() => { try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ } });
  return directory;
}

test('builtin host factories and default specs stay in sync', () => {
  const names = [...HOST_FACTORIES.keys()].sort();
  assert.deepEqual(names, ['claude', 'codex', 'dsh', 'zcode']);
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

test('host definitions stay in sync with every derived registry', () => {
  // 有工厂的才能当成员；没有工厂的（桌面应用类主控）只出现在定义表里。
  const memberHosts = [...HOST_DEFINITIONS]
    .filter(([, definition]) => typeof definition.factory === 'function')
    .map(([name]) => name)
    .sort();
  assert.deepEqual([...HOST_FACTORIES.keys()].sort(), memberHosts);
  assert.deepEqual(Object.keys(DEFAULT_HOST_SPECS).sort(), [...HOST_FACTORIES.keys()].sort());
  for (const [name, definition] of HOST_DEFINITIONS) {
    if (definition.factory !== undefined) assert.equal(typeof definition.factory, 'function', `${name} factory`);
    if (definition.telemetryCapabilities !== undefined) assert.equal(typeof definition.telemetryCapabilities, 'function', `${name} telemetry builder`);
    if (definition.wake) {
      assert.equal(typeof definition.wake.id, 'string', `${name} wake id`);
      assert.equal(typeof definition.wake.fingerprint, 'function', `${name} wake fingerprint`);
      assert.equal(typeof definition.wake.wake, 'function', `${name} wake driver`);
    }
    if (definition.skill) {
      assert.ok(['copy', 'shared'].includes(definition.skill.mode), `${name} skill mode`);
      assert.equal(typeof definition.skill.dir, 'function', `${name} skill dir`);
    }
    if (definition.discoverControllerSession) {
      assert.equal(typeof definition.discoverControllerSession, 'function', `${name} session discovery`);
    }
  }
  for (const name of ['codex', 'dsh', 'zcode']) {
    assert.ok(wakeDriverFor(name), `${name} must expose an active wake driver`);
  }
  assert.equal(wakeDriverFor('claude'), null, 'claude stays pull-only until a wake driver lands');
  // 桌面应用类主控：没有工厂、没有唤醒驱动，只作为外部主控接入。
  assert.equal(HOST_FACTORIES.has('workbuddy'), false, 'workbuddy is not a launchable member');
  assert.equal(wakeDriverFor('workbuddy'), null, 'workbuddy has no injection channel');
});
});

describe('model-catalog', () => {
function fixture(t, source) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-model-catalog-'));
  const file = join(directory, 'fixture.mjs');
  writeFileSync(file, '#!/usr/bin/env node\n' + source);
  chmodSync(file, 0o700);
  const command = process.platform === 'win32' ? join(directory, 'fixture.cmd') : file;
  if (process.platform === 'win32') writeFileSync(command, '@echo off\r\n"' + process.execPath + '" "%~dp0fixture.mjs" %*\r\n');
  const cleanup = () => {
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
    catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  };
  return { command, directory, cleanup };
}

test('Codex forwards only the capabilities its app-server reports through model/list', async t => {
  const { command, cleanup } = fixture(t, `
import { createInterface } from 'node:readline';
const send = value => console.log(JSON.stringify(value));
createInterface({ input: process.stdin }).on('line', line => {
  const row = JSON.parse(line);
  if (row.method === 'initialize') return send({ id: row.id, result: {} });
  if (row.method === 'config/read') return send({ id: row.id, result: { config: { mcp_servers: {} } } });
  if (row.method === 'model/list') return send({ id: row.id, result: { data: [{
    id: 'model-a', model: 'model-a', displayName: 'Model A', description: 'catalog fixture',
    hidden: false, isDefault: true, defaultReasoningEffort: 'low',
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'fast' },
      { reasoningEffort: 'high' }
    ],
    inputModalities: ['text', 'image']
  }, {
    id: 'model-b', model: 'model-b', displayName: 'Model B', isDefault: false,
    supportedReasoningEfforts: [{ reasoningEffort: 'low' }]
  }], nextCursor: null } });
});
`);
  const host = createCodexHost({ command });
  t.after(async () => { await host.close(); cleanup(); });
  const catalog = await host.listModels();
  assert.equal(catalog.defaultModel, 'model-a');
  assert.deepEqual(catalog.models.map(model => model.id), ['model-a', 'model-b']);
  const [reported, undeclared] = catalog.models;
  assert.deepEqual(reported.inputModalities, ['text', 'image']);
  assert.deepEqual(reported.reasoningEfforts, [
    { id: 'low', label: 'low', description: 'fast' },
    { id: 'high', label: 'high' },
  ]);
  assert.ok(!Object.hasOwn(reported, 'contextWindow'), 'model/list 未上报 contextWindow 时不得虚构');
  assert.ok(!Object.hasOwn(undeclared, 'inputModalities'), 'model/list 未上报 inputModalities 时字段不应存在');
});

test('Claude leaves modality and context undeclared when initialize reports neither', async t => {
  const { command, directory, cleanup } = fixture(t, `
import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', line => {
  const row = JSON.parse(line);
  if (row.type !== 'control_request') process.exit(9);
  console.log(JSON.stringify({ type: 'control_response', response: {
    request_id: row.request_id, subtype: 'success', response: { models: [
      { value: 'default', resolvedModel: 'claude-default-fixture', displayName: 'Default', description: 'default model', supportedEffortLevels: ['low', 'high'], supportsEffort: true },
      { value: 'sonnet', resolvedModel: 'claude-sonnet-fixture', displayName: 'Sonnet', supportedEffortLevels: ['low', 'high'] }
    ] }
  } }));
});
`);
  t.after(cleanup);
  const host = createClaudeHost({ directory, socketPath: join(directory, 'bus.sock'), command, configDirectory: join(directory, 'claude-config') });
  const catalog = await host.listModels();
  assert.equal(catalog.defaultModel, 'default');
  assert.deepEqual(catalog.models.map(model => model.id), ['default', 'sonnet']);
  for (const model of catalog.models) {
    assert.ok(!Object.hasOwn(model, 'inputModalities'), 'initialize 未返回 inputModalities 时字段不应存在');
    assert.ok(!Object.hasOwn(model, 'contextWindow'), 'initialize 未返回 contextWindow 时不得虚构');
  }
  assert.deepEqual(catalog.models[0].reasoningEfforts.map(effort => effort.id), ['low', 'high']);
});

test('DSH forwards reported modalities and context but never fabricates them', async t => {
  const { command, directory, cleanup } = fixture(t, `
console.log('AGENT_TEAM_DSH_MODEL_CATALOG ' + JSON.stringify({
  ok: true,
  defaultModel: 'provider/model-a',
  providers: [{ id: 'provider', label: 'Provider', models: [{
    key: 'provider/model-a', id: 'model-a', label: 'Model A', provider: 'provider',
    inputModalities: ['text', 'image'], contextWindow: 1000000,
    reasoningEfforts: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High', description: 'deep' }],
    defaultReasoningEffort: 'high', isDefault: true
  }, {
    key: 'provider/model-b', id: 'model-b', label: 'Model B', provider: 'provider',
    inputModalities: ['text']
  }, {
    key: 'provider/model-c', id: 'model-c', label: 'Model C', provider: 'provider',
    contextWindow: 0
  }] }],
  failures: []
}));
setTimeout(() => process.exit(0), 50);
`);
  t.after(cleanup);
  const catalog = await createDshHost({ directory, socketPath: join(directory, 'bus.sock'), command }).listModels();
  assert.equal(catalog.defaultModel, 'provider/model-a');
  assert.deepEqual(catalog.models.map(model => model.id), ['model-a', 'model-b', 'model-c']);
  const [multimodal, textOnly, undeclared] = catalog.models;
  assert.deepEqual(multimodal.inputModalities, ['text', 'image']);
  assert.equal(multimodal.contextWindow, 1000000);
  assert.deepEqual(multimodal.reasoningEfforts, [
    { id: 'low', label: 'Low' },
    { id: 'high', label: 'High', description: 'deep' },
  ]);
  assert.deepEqual(textOnly.inputModalities, ['text']);
  assert.ok(!Object.hasOwn(textOnly, 'contextWindow'), '目录未上报 contextWindow 时字段不应存在');
  assert.ok(!Object.hasOwn(undeclared, 'inputModalities'), '目录未上报 inputModalities 时字段不应存在');
  assert.ok(!Object.hasOwn(undeclared, 'contextWindow'), '非正整数 contextWindow 不得写入目录');
  assert.deepEqual(undeclared.reasoningEfforts, [], '未上报推理档位时归一化为空数组');
});

test('ZCode maps structured inputFormat booleans from the created session catalog', async t => {
  const { command, directory, cleanup } = fixture(t, `
import { createInterface } from 'node:readline';
const send = value => console.log(JSON.stringify(value));
send({ method: 'startup/storagePath', params: { path: '/tmp/zcode-catalog-fixture.sqlite' } });
createInterface({ input: process.stdin }).on('line', line => {
  const row = JSON.parse(line);
  if (row.method === 'startup/storagePathReady') return send({ method: 'startup/storageState', params: { sequence: 1 } });
  if (row.method && row.method.startsWith('startup/')) return;
  if (row.id && row.method === 'session/create') return send({ id: row.id, result: {
    session: { sessionId: 'sess-catalog-1' },
    settings: { model: {
      available: [{
        ref: { providerId: 'prov-1', modelId: 'model-a' }, label: 'Model A', providerLabel: 'Provider',
        contextWindow: 1000000, maxOutputTokens: 384000,
        reasoning: { levels: [{ value: 'low', label: 'low' }, { value: 'high', label: 'high' }], defaultLevel: 'high' },
        properties: { inputFormat: { supportsText: true, supportsImage: true, supportsVideo: false, supportsAudio: false, supportsPdf: false }, outputFormat: { supportsText: true } }
      }, {
        ref: { providerId: 'prov-1', modelId: 'model-b' }, label: 'Model B', providerLabel: 'Provider'
      }],
      lastUsed: { providerId: 'prov-1', modelId: 'model-a' }
    } }
  } });
  if (row.id) return send({ id: row.id, result: {} });
});
`);
  t.after(cleanup);
  const host = createZcodeHost({ directory, socketPath: join(directory, 'bus.sock'), command });
  const catalog = await host.listModels();
  assert.equal(catalog.defaultModel, 'prov-1:model-a');
  assert.deepEqual(catalog.models.map(model => model.id), ['model-a', 'model-b']);
  const [multimodal, undeclared] = catalog.models;
  assert.deepEqual(multimodal.inputModalities, ['text', 'image']);
  assert.equal(multimodal.contextWindow, 1000000);
  assert.deepEqual(multimodal.reasoningEfforts.map(effort => effort.id), ['low', 'high']);
  assert.equal(multimodal.defaultReasoningEffort, 'high');
  assert.ok(!Object.hasOwn(undeclared, 'inputModalities'), '未提供 properties.inputFormat 时字段不应存在');
  assert.ok(!Object.hasOwn(undeclared, 'contextWindow'), '未上报 contextWindow 时字段不应存在');
});

test('ZCode maps inputFormat booleans from legacy state.updated patches too', async t => {
  const { command, directory, cleanup } = fixture(t, `
import { createInterface } from 'node:readline';
const send = value => console.log(JSON.stringify(value));
send({ method: 'startup/storagePath', params: { path: '/tmp/zcode-catalog-fixture.sqlite' } });
createInterface({ input: process.stdin }).on('line', line => {
  const row = JSON.parse(line);
  if (row.method === 'startup/storagePathReady') return send({ method: 'startup/storageState', params: { sequence: 1 } });
  if (row.method && row.method.startsWith('startup/')) return;
  if (row.id && row.method === 'session/create') {
    send({ method: 'state.updated', params: { patch: { model: {
      available: [{
        ref: { providerId: 'prov-2', modelId: 'model-vision' }, label: 'Vision', providerLabel: 'Provider',
        contextWindow: 200000,
        properties: { inputFormat: { supportsText: true, supportsImage: true } }
      }, {
        ref: { providerId: 'prov-2', modelId: 'model-text' }, label: 'Text', providerLabel: 'Provider',
        properties: { inputFormat: { supportsText: true, supportsImage: false } }
      }],
      lastUsed: { providerId: 'prov-2', modelId: 'model-vision' }
    } } } });
    return send({ id: row.id, result: { session: { sessionId: 'sess-catalog-2' } } });
  }
  if (row.id) return send({ id: row.id, result: {} });
});
`);
  t.after(cleanup);
  const host = createZcodeHost({ directory, socketPath: join(directory, 'bus.sock'), command });
  const catalog = await host.listModels();
  assert.equal(catalog.defaultModel, 'prov-2:model-vision');
  assert.deepEqual(catalog.models.map(model => model.id), ['model-vision', 'model-text']);
  const [vision, text] = catalog.models;
  assert.deepEqual(vision.inputModalities, ['text', 'image']);
  assert.equal(vision.contextWindow, 200000);
  assert.deepEqual(text.inputModalities, ['text'], '显式 false 的模态不出现在能力列表');
  assert.ok(!Object.hasOwn(text, 'contextWindow'), '未上报 contextWindow 时字段不应存在');
});

test('model catalogue normalizes capability fields without fabricating them', () => {
  const catalog = modelCatalog({
    host: 'fake',
    source: 'test',
    models: [
      { id: 'bad-modalities', inputModalities: 'text', contextWindow: 0 },
      { id: 'negative-window', contextWindow: -1 },
      { id: 'fractional-window', contextWindow: 1.5 },
      { id: 'valid', inputModalities: ['text', 'image', ''], contextWindow: 200000 },
    ],
  });
  const [badModalities, negative, fractional, valid] = catalog.models;
  assert.ok(!Object.hasOwn(badModalities, 'inputModalities'), '非数组 inputModalities 不落键');
  assert.ok(!Object.hasOwn(badModalities, 'contextWindow'), '非正整数 contextWindow 不落键');
  assert.ok(!Object.hasOwn(negative, 'contextWindow'), '负整数 contextWindow 不落键');
  assert.ok(!Object.hasOwn(fractional, 'contextWindow'), '非整数 contextWindow 不落键');
  assert.deepEqual(valid.inputModalities, ['text', 'image'], '空串模态被过滤');
  assert.equal(valid.contextWindow, 200000);
  assert.deepEqual(badModalities.reasoningEfforts, []);
});

test('model catalog is cached, refreshable, and exposed through the read-only API', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-model-catalog-api-'));
  let calls = 0;
  const host = {
    async listModels() {
      calls++;
      return modelCatalog({
        host: 'fake',
        source: 'test',
        defaultModel: 'model-a',
        models: [{ id: 'model-a', label: 'Model A', isDefault: true }],
      });
    },
  };
  const server = await startServer({ directory, hosts: new Map([['fake', host]]) });
  t.after(async () => { await server.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
  const first = await server.bus.modelCatalog();
  const second = await server.bus.modelCatalog();
  const refreshed = await server.bus.modelCatalog({ refresh: true });
  assert.equal(calls, 2);
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(refreshed.cached, false);
  const response = await (await fetch(`${new URL(server.url).origin}/api/model-catalog?refresh=1`)).json();
  assert.equal(response.hosts[0].catalog.models[0].id, 'model-a');
  assert.equal(calls, 3);
  const rpcResult = await rpc(server.socketPath, { op: 'model_catalog', refresh: true });
  assert.equal(rpcResult.hosts[0].catalog.models[0].id, 'model-a');
  assert.equal(calls, 4);
});

test('Bus reports a host that cannot discover models without failing other hosts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-model-catalog-unsupported-'));
  const bus = new Bus({
    directory,
    hosts: new Map([
      ['unsupported', { async run() { return ''; } }],
      ['supported', {
        async listModels() {
          return modelCatalog({ host: 'supported', source: 'test', models: [{ id: 'ok' }] });
        },
      }],
    ]),
  });
  try {
    const result = await bus.modelCatalog({ refresh: true });
    assert.equal(result.hosts.find(host => host.host === 'unsupported').ok, false);
    assert.equal(result.hosts.find(host => host.host === 'supported').ok, true);
  } finally {
    await bus.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  }
});

test('DSH rejects abnormal exit even after a complete valid catalog', async t => {
  const { command, directory, cleanup } = fixture(t, `
console.log('AGENT_TEAM_DSH_MODEL_CATALOG ' + JSON.stringify({ok:true,providers:[],failures:[]}));
setTimeout(() => process.exit(7), 50);
`);
  t.after(cleanup);
  await assert.rejects(createDshHost({ directory, command }).listModels(), /退出 \(7\)/);
});
});

describe('host-capabilities', () => {
test('capability catalog is flat, unique and fully grouped', () => {
  const grouped = Object.values(CAPABILITY_GROUPS).flat();
  assert.equal(grouped.length, 13);
  assert.deepEqual([...CAPABILITY_IDS].sort(), [...grouped].sort());
  assert.equal(new Set(CAPABILITY_IDS).size, CAPABILITY_IDS.length);
  assert.ok(CAPABILITY_IDS.every(id => id.includes('.')));
});

test('an absent declaration normalizes to all false instead of failing', () => {
  const declaration = normalizeDeclaration(undefined);
  assert.equal(CAPABILITY_IDS.every(id => declaration[id] === false), true);
  assert.deepEqual(deriveRoles(declaration), []);
});

test('unknown capability ids and non-boolean values are rejected', () => {
  assert.throws(() => normalizeDeclaration({ 'session.spawn': true, 'session.teleport': true }), /未知能力位/);
  assert.throws(() => normalizeDeclaration({ 'session.spawn': 'yes' }), /必须是布尔值/);
  assert.throws(() => normalizeDeclaration([]), /能力声明必须是对象/);
  assert.throws(() => hasCapability({}, 'exec.teleport'), /未知能力位/);
});

test('partial declarations are filled with false', () => {
  const declaration = normalizeDeclaration({ 'session.deliver': true });
  assert.equal(declaration['session.deliver'], true);
  assert.equal(declaration['session.spawn'], false);
  assert.equal(declaration['exec.read'], false);
});

test('roles derive from delivery, observation and spawn only', () => {
  assert.deepEqual(deriveRoles(normalizeDeclaration({ 'session.deliver': true, 'turn.observe': true })), ['controller']);
  assert.deepEqual(deriveRoles(normalizeDeclaration({ 'session.wake': true, 'turn.observe': true })), []);
  assert.deepEqual(deriveRoles(normalizeDeclaration({ 'session.spawn': true })), ['member']);
  assert.deepEqual(deriveRoles(normalizeDeclaration({ 'exec.read': true })), []);
  assert.deepEqual(deriveRoles(normalizeDeclaration({})), []);
});

test('spawn and wake come from factory and driver, never from the declaration', () => {
  const caps = resolveCapabilities({
    declaration: { 'session.deliver': true, 'turn.observe': true, 'session.spawn': true, 'session.wake': true },
    hasFactory: false,
    hasWake: false,
  });
  assert.equal(caps['session.spawn'], false);
  assert.equal(caps['session.wake'], false);
  assert.deepEqual(deriveRoles(caps), ['controller']);
});

test('a host without session.spawn is never a member', () => {
  const roles = deriveRoles(normalizeDeclaration({ 'session.deliver': true, 'turn.observe': true }));
  assert.equal(roles.includes('member'), false);
});

test('builtin hosts declare a complete catalog and derive expected roles', () => {
  const expected = {
    codex: ['controller', 'member'],
    claude: ['controller', 'member'],
    dsh: ['controller', 'member'],
    zcode: ['controller', 'member'],
    workbuddy: ['controller'],
  };
  for (const [name, definition] of HOST_DEFINITIONS) {
    assert.equal(Object.keys(definition.capabilities).sort().join(','), [...CAPABILITY_IDS].sort().join(','), `${name} declaration is complete`);
    assert.deepEqual(deriveRoles(definition.capabilities), expected[name], `${name} roles`);
  }
});

test('claude declares no wake while the other builtin hosts do', () => {
  assert.equal(HOST_DEFINITIONS.get('claude').capabilities['session.wake'], false);
  for (const name of ['codex', 'dsh', 'zcode']) {
    assert.equal(HOST_DEFINITIONS.get(name).capabilities['session.wake'], true, name);
  }
});

test('user.notify stays false everywhere without invalidating the catalog', () => {
  for (const [, definition] of HOST_DEFINITIONS) {
    assert.equal(definition.capabilities['user.notify'], false);
  }
  assert.equal(CAPABILITY_IDS.includes('user.notify'), true);
});

test('controller capability ids follow the declaration', () => {
  for (const name of ['codex', 'dsh', 'zcode']) {
    const ids = controllerCapabilityIds(HOST_DEFINITIONS.get(name).capabilities);
    assert.ok(ids.includes('session.deliver'), name);
    assert.ok(ids.includes('session.wake'), name);
    assert.ok(ids.includes('turn.observe'), name);
  }
  const claude = controllerCapabilityIds(HOST_DEFINITIONS.get('claude').capabilities);
  assert.ok(claude.includes('session.deliver'));
  assert.equal(claude.includes('session.wake'), false);
  assert.deepEqual(controllerCapabilityIds(normalizeDeclaration({ 'exec.read': true })), []);
});

test('mergeDeclarations unions positions', () => {
  const merged = mergeDeclarations({ 'exec.read': true }, { 'session.deliver': true }, undefined);
  assert.equal(merged['exec.read'], true);
  assert.equal(merged['session.deliver'], true);
  assert.equal(merged['exec.write'], false);
});

test('legacy member capability ids normalize, and boundary folds into write', () => {
  assert.deepEqual(
    canonicalMemberCapabilityIds(['file.read', 'file.write', 'filesystem.boundary', 'shell.exec']),
    ['exec.read', 'exec.write', 'exec.shell'],
  );
  assert.equal(canonicalMemberCapabilityId('filesystem.boundary'), 'exec.write');
  assert.deepEqual(canonicalMemberCapabilityIds(undefined), []);
  assert.deepEqual(canonicalMemberCapabilityIds(['exec.read', 'exec.read']), ['exec.read']);
  assert.deepEqual(canonicalMemberCapabilityIds(['made-up']), ['made-up']);
});

test('failure attribution names declared capabilities without claiming cause', () => {
  assert.equal(describeDeclaredCapabilities([]), '');
  assert.equal(describeDeclaredCapabilities(undefined), '');
  assert.equal(
    describeDeclaredCapabilities(['exec.read', 'exec.write']),
    '（宿主声明支持: exec.read, exec.write）',
  );
});
});

describe('browser-mcp-probe', () => {
const HOME = '/home/tester';
const CONFIG_DIR = '/conf/claude';
const claudeConfigPath = join(CONFIG_DIR, '.claude.json');
const claudeHomePath = join(HOME, '.claude.json');
const zcodeConfigPath = join(HOME, '.zcode', 'cli', 'config.json');
const dshConfigPath = join(HOME, '.dsh', 'profiles', 'headless', 'cordis.patch.yml');

function jsonServers(servers) {
  return JSON.stringify({ mcpServers: servers });
}

function zcodeServers(servers) {
  return JSON.stringify({ mcp: { servers } });
}

/** 内存里监听固定路径的 readText；未登记路径按 ENOENT（正常未配置）。 */
function reader(files) {
  return path => {
    if (path in files) return files[path];
    const error = new Error('missing ' + path);
    error.code = 'ENOENT';
    throw error;
  };
}

function probeClaude(files, options = {}) {
  return probeBrowserMcpServers({
    host: 'claude',
    configDirectory: CONFIG_DIR,
    home: HOME,
    readText: reader(files),
    resolveCommand: options.resolveCommand ?? (command => (command === 'npx' ? '/usr/local/bin/npx' : null)),
    ...(options.now ? { now: options.now } : {}),
    ...(options.deadlineMs ? { deadlineMs: options.deadlineMs } : {}),
  });
}

function probeZcode(files, options = {}) {
  return probeBrowserMcpServers({
    host: 'zcode',
    home: HOME,
    readText: reader(files),
    resolveCommand: options.resolveCommand ?? (command => (command === 'npx' ? '/usr/local/bin/npx' : null)),
    ...(options.now ? { now: options.now } : {}),
  });
}

function probeDsh(files, options = {}) {
  return probeBrowserMcpServers({
    host: 'dsh',
    home: HOME,
    dshHome: join(HOME, '.dsh'),
    readText: reader(files),
    resolveCommand: options.resolveCommand ?? (command => (command === 'npx' ? '/usr/local/bin/npx' : null)),
    ...(options.now ? { now: options.now } : {}),
  });
}

test('claude: a declared and executable browser MCP is detected', () => {
  const result = probeClaude({
    [claudeHomePath]: jsonServers({
      playwright: { command: 'npx', args: ['-y', '@playwright/mcp'], env: { PLAYWRIGHT_BROWSERS_PATH: '/cache' } },
      webstorm: { type: 'http', url: 'http://127.0.0.1:64542/stream' },
    }),
  });
  assert.deepEqual(result.servers, [{
    name: 'playwright',
    config: { command: 'npx', args: ['-y', '@playwright/mcp'], env: { PLAYWRIGHT_BROWSERS_PATH: '/cache' } },
  }]);
  assert.equal(result.reason, null);
  assert.deepEqual(result.checked.sort(), [claudeConfigPath, claudeHomePath].sort());
  assert.equal(result.timedOut, false);
});

test('claude: config directory takes precedence and duplicate server names are deduped', () => {
  const result = probeClaude({
    [claudeConfigPath]: jsonServers({ playwright: { command: 'npx', args: ['first'] } }),
    [claudeHomePath]: jsonServers({ playwright: { command: 'npx', args: ['second'] } }),
  });
  assert.equal(result.servers.length, 1);
  assert.deepEqual(result.servers[0].config.args, ['first']);
});

test('claude: a browser-named MCP whose command is missing stays unavailable with a reason', () => {
  const result = probeClaude({ [claudeHomePath]: jsonServers({ browser: { command: 'missing-browser' } }) });
  assert.deepEqual(result.servers, []);
  assert.match(result.reason, new RegExp(BROWSER_MCP_UNAVAILABLE_REASON.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(result.reason, /不在 PATH 或不可执行: missing-browser/);
});

test('claude: HTTP browser MCP declarations are never reported as usable', () => {
  const result = probeClaude({ [claudeHomePath]: jsonServers({ playwright: { type: 'http', url: 'http://127.0.0.1:1234/mcp' } }) });
  assert.deepEqual(result.servers, []);
  assert.match(result.reason, /HTTP\/SSE 声明无法在启动前同步确认可用/);
});

test('claude: non-browser MCP declarations are reported by name, not guessed into browser capability', () => {
  const result = probeClaude({
    [claudeHomePath]: jsonServers({
      figwright: { command: 'npx', args: ['-y', '@figwright/mcp@latest'] },
      idea: { type: 'http', url: 'http://127.0.0.1:64342/stream' },
    }),
  });
  assert.deepEqual(result.servers, []);
  assert.match(result.reason, /均不在浏览器名称白名单（figwright、idea）/);
});

test('claude: unreadable config degrades to unavailable instead of throwing', () => {
  const result = probeBrowserMcpServers({
    host: 'claude',
    configDirectory: CONFIG_DIR,
    home: HOME,
    readText: path => {
      const error = new Error('denied ' + path);
      error.code = 'EACCES';
      throw error;
    },
  });
  assert.deepEqual(result.servers, []);
  assert.match(result.reason, /读取异常：/);
  assert.match(result.reason, /EACCES/);
});

test('claude: probe stops reading once the deadline is exceeded', () => {
  let ticks = 0;
  const result = probeClaude({ [claudeHomePath]: jsonServers({ playwright: { command: 'npx' } }) }, {
    now: () => { ticks += 1000; return ticks; },
    deadlineMs: 200,
  });
  assert.equal(result.timedOut, true);
  assert.deepEqual(result.servers, []);
  assert.match(result.reason, /探测超过 200ms，已停止读取剩余配置/);
});

test('zcode: enabled browser MCP is detected; disabled ones are skipped', () => {
  const result = probeZcode({
    [zcodeConfigPath]: zcodeServers({
      playwright: { type: 'stdio', command: 'npx', args: ['@playwright/mcp'] },
      'computer-use': { type: 'stdio', command: 'npx', enabled: false },
      figwright: { type: 'stdio', command: 'npx', args: ['@figwright/mcp@latest'] },
    }),
  });
  assert.deepEqual(result.servers.map(server => server.name), ['playwright']);
  assert.equal(result.reason, null);
});

test('zcode: only disabled browser declarations yields an unavailable reason', () => {
  const result = probeZcode({
    [zcodeConfigPath]: zcodeServers({ browser: { type: 'stdio', command: 'npx', enabled: false } }),
  });
  assert.deepEqual(result.servers, []);
  assert.match(result.reason, /未发现浏览器 MCP 声明/);
});

test('zcode: http browser declarations are unverified', () => {
  const result = probeZcode({
    [zcodeConfigPath]: zcodeServers({ 'chrome-devtools': { type: 'http', url: 'http://127.0.0.1:9222/mcp' } }),
  });
  assert.deepEqual(result.servers, []);
  assert.match(result.reason, /HTTP\/SSE 声明无法在启动前同步确认可用/);
});

test('dsh: headless profile patch declares a stdio browser MCP that is inherited at launch', () => {
  const patch = [
    '- insert:',
    '    - id: mcp-playwright',
    '      name: "@deepseek-ai/dsh-mcp-client"',
    '      config:',
    '        serverName: playwright',
    '        transport: stdio',
    '        command: npx',
    '        args:',
    '          - "-y"',
    '          - "@playwright/mcp@latest"',
    '    - id: mcp-figma',
    '      name: "@deepseek-ai/dsh-mcp-client"',
    '      config:',
    '        serverName: figwright',
    '        transport: stdio',
    '        command: npx-figma',
  ].join('\n');
  const result = probeDsh({ [dshConfigPath]: patch });
  assert.deepEqual(result.servers, [{ name: 'playwright', config: { command: 'npx' } }]);
  assert.equal(result.reason, null);
});

test('dsh: disabled or http browser declarations never become capability', () => {
  const patch = [
    '- insert:',
    '    - id: mcp-browser',
    '      name: "@deepseek-ai/dsh-mcp-client"',
    '      config:',
    '        serverName: browser-tools',
    '        transport: stdio',
    '        command: npx',
    '        disabled: true',
    '    - id: mcp-chrome',
    '      name: "@deepseek-ai/dsh-mcp-client"',
    '      config:',
    '        serverName: chrome-devtools',
    '        transport: streamable-http',
    '        url: "http://127.0.0.1:9222/mcp"',
  ].join('\n');
  const result = probeDsh({ [dshConfigPath]: patch });
  assert.deepEqual(result.servers, []);
  assert.match(result.reason, /HTTP\/SSE 声明无法在启动前同步确认可用/);
});

test('dsh: malformed patch content never throws and is reported as a read note', () => {
  const patch = ['- insert:', '    - name: "@deepseek-ai/dsh-mcp-client"', '      config:', '        command: npx'].join('\n');
  const result = probeDsh({ [dshConfigPath]: patch });
  assert.deepEqual(result.servers, []);
  assert.match(result.reason, /无法解析 serverName 的 MCP 客户端声明/);
});

test('unknown hosts and malformed config files degrade to unavailable', () => {
  const unknown = probeBrowserMcpServers({ host: 'mystery', home: HOME, readText: reader({}) });
  assert.deepEqual(unknown.servers, []);
  assert.match(unknown.reason, /未知宿主，未读取任何配置/);
  const malformed = probeClaude({ [claudeHomePath]: '{not json' });
  assert.deepEqual(malformed.servers, []);
  assert.match(malformed.reason, /JSON 解析失败/);
});

test('resolveHostCommand only accepts real executables and never throws', () => {
  assert.equal(resolveHostCommand(''), null);
  assert.equal(resolveHostCommand('definitely-not-installed-agent-team', { env: { PATH: '/nonexistent-dir' } }), null);
  assert.equal(resolveHostCommand('/definitely/not/here', { env: {} }), null);
  assert.equal(resolveHostCommand(process.execPath, { env: {} }), process.execPath);
});

test('normalizeBrowserProbeResult filters malformed servers and keeps a reason', () => {
  assert.deepEqual(normalizeBrowserProbeResult(undefined), { servers: [], reason: BROWSER_MCP_UNAVAILABLE_REASON });
  assert.deepEqual(normalizeBrowserProbeResult({ servers: [{ name: 'playwright' }] }), { servers: [], reason: BROWSER_MCP_UNAVAILABLE_REASON });
  assert.deepEqual(normalizeBrowserProbeResult(null), { servers: [], reason: BROWSER_MCP_UNAVAILABLE_REASON });
  const server = { name: 'playwright', config: { command: 'npx' } };
  assert.deepEqual(normalizeBrowserProbeResult({ servers: [server], reason: 'ignored' }), { servers: [server], reason: null });
  assert.deepEqual(normalizeBrowserProbeResult({ servers: [], reason: '自定义原因' }), { servers: [], reason: '自定义原因' });
});

test('claude allow rules and dsh tool prefixes reject unsafe server names', () => {
  assert.equal(claudeMcpAllowRule('playwright'), 'mcp__playwright__*');
  assert.equal(dshMcpToolPrefix('playwright'), 'mcp__playwright__');
  for (const name of ['', 'bad/name', 'bad name', null, undefined]) {
    assert.equal(claudeMcpAllowRule(name), null);
    assert.equal(dshMcpToolPrefix(name), null);
  }
});

test('claude execution config widens allow rules only when browser is authorized', () => {
  const authorized = claudeExecutionConfig({ mode: 'read-only', allowShell: true, allowBrowser: true }, [], '/ws', [{ name: 'playwright' }]);
  assert.ok(authorized.allowed.includes('mcp__playwright__*'));
  const unauthorized = claudeExecutionConfig({ mode: 'read-only', allowShell: true, allowBrowser: false }, [], '/ws', [{ name: 'playwright' }]);
  assert.ok(!unauthorized.allowed.includes('mcp__playwright__*'));
  const communication = claudeExecutionConfig({ mode: 'communication', allowShell: false, allowBrowser: false }, [], '/ws', [{ name: 'playwright' }]);
  assert.deepEqual(communication.builtins, []);
  assert.ok(!communication.allowed.includes('mcp__playwright__*'));
});

test('claudeMcpServersConfig keeps agent_team first and skips unsafe browser clones', () => {
  const config = { command: 'node', args: ['cli.mjs'], env: { AGENT_TEAM_KEY: 'k' } };
  const result = claudeMcpServersConfig(config, [
    { name: 'playwright', config: { command: 'npx', args: ['@playwright/mcp'], env: { A: '1' }, cwd: '/work' } },
    { name: 'agent_team', config: { command: 'evil' } },
    { name: 'broken' },
    { name: 'playwright', config: { command: 'npx' } },
  ]);
  assert.deepEqual(Object.keys(result.mcpServers), ['agent_team', 'playwright']);
  assert.deepEqual(result.mcpServers.agent_team, config);
  assert.deepEqual(result.mcpServers.playwright, { command: 'npx', args: ['@playwright/mcp'], env: { A: '1' }, cwd: '/work' });
});

test('zcodeMcpConfig merges browser stdio servers into the isolated HOME config', () => {
  const mcp = { command: 'node', args: ['cli.mjs'], env: { AGENT_TEAM_KEY: 'k' } };
  const result = zcodeMcpConfig(mcp, [
    { name: 'playwright', config: { command: 'npx', args: ['@playwright/mcp'], env: { A: '1' } } },
    { name: 'agent_team', config: { command: 'evil' } },
    { name: 'broken' },
  ]);
  assert.deepEqual(Object.keys(result.mcp.servers), ['agent_team', 'playwright']);
  assert.deepEqual(result.mcp.servers.agent_team, mcp);
  assert.deepEqual(result.mcp.servers.playwright, { type: 'stdio', command: 'npx', args: ['@playwright/mcp'], env: { A: '1' } });
});

/** 触发 DSH agent-team-policy 插件的 agent/created，返回 restrict 收到的精确工具白名单。 */
function runDshPolicy(config, registered) {
  let created;
  applyDshPolicy({ on(event, handler) { if (event === 'agent/created') created = handler; } }, config);
  const restrictions = [];
  created({
    agent: {
      session: { append() {} },
      ctx: {
        tools: {
          definitions: () => registered.map(name => ({ name })),
          get: name => ({ name }),
          restrict: options => restrictions.push(options),
        },
      },
    },
  });
  return restrictions;
}

test('dsh policy allows exactly the registered browser MCP tools and refuses missing servers', () => {
  const restrictions = runDshPolicy({
    mode: 'read-only',
    allowShell: false,
    tools: ['mcp__agent_team__team_read'],
    browserServers: [{ name: 'playwright', toolPrefix: 'mcp__playwright__' }],
  }, ['mcp__agent_team__team_read', 'mcp__playwright__browser_navigate', 'mcp__playwright__browser_click', 'mcp__other__unrelated']);
  assert.deepEqual(restrictions[0].allow.sort(), [
    'glob', 'grep', 'mcp__agent_team__team_read', 'mcp__playwright__browser_click', 'mcp__playwright__browser_navigate', 'read', 'read_image',
  ].sort());
  assert.throws(
    () => runDshPolicy({
      mode: 'read-only',
      allowShell: false,
      tools: ['mcp__agent_team__team_read'],
      browserServers: [{ name: 'playwright', toolPrefix: 'mcp__playwright__' }],
    }, ['mcp__agent_team__team_read']),
    /浏览器 MCP 工具尚未加载，拒绝启动任务：playwright/,
  );
});

test('dsh policy keeps its pre-existing allow list when no browser MCP was detected', () => {
  let definitionCalls = 0;
  let created;
  applyDshPolicy({ on(event, handler) { if (event === 'agent/created') created = handler; } }, {
    mode: 'read-only', allowShell: false, tools: ['mcp__agent_team__team_read'],
  });
  const restrictions = [];
  created({
    agent: {
      session: { append() {} },
      ctx: {
        tools: {
          definitions: () => { definitionCalls += 1; return []; },
          get: name => ({ name }),
          restrict: options => restrictions.push(options),
        },
      },
    },
  });
  assert.equal(definitionCalls, 0);
  assert.deepEqual(restrictions[0].allow.sort(), ['glob', 'grep', 'mcp__agent_team__team_read', 'read', 'read_image'].sort());
});

test('dsh policy fails loudly when a detected browser server exposes no tools', () => {
  assert.throws(
    () => runDshPolicy({
      mode: 'workspace-write',
      allowShell: true,
      tools: ['mcp__agent_team__team_read'],
      browserServers: [{ name: 'playwright', toolPrefix: 'mcp__playwright__' }],
    }, ['mcp__agent_team__team_read']),
    /浏览器 MCP 工具尚未加载/,
  );
});

/** 记录请求顺序与载荷的 fake ZCode 协议，覆盖授信矩阵。 */
function fakeZcodeProtocol(statuses, responses = {}) {
  const requests = [];
  return {
    requests,
    async request(method, payload) {
      requests.push({ method, payload });
      if (method === 'mcp/list') return { statuses };
      if (method === 'workspace/mcp/trust') {
        const key = payload.serverName;
        return responses[key] ?? { accepted: true };
      }
      throw new Error('unexpected request ' + method);
    },
  };
}

test('trustWorkspaceMcpServers requires agent_team and trusts only untrusted digest servers', async () => {
  const protocol = fakeZcodeProtocol({
    agent_team: { workspaceTrust: { declarationDigest: 'digest-team', trusted: false } },
    playwright: { workspaceTrust: { declarationDigest: 'digest-browser', trusted: false } },
    trusted: { workspaceTrust: { declarationDigest: 'digest-trusted', trusted: true } },
    noDigest: { workspaceTrust: {} },
  });
  await trustWorkspaceMcpServers(protocol, { workspacePath: '/ws' }, ['agent_team', 'playwright', 'trusted', 'noDigest']);
  assert.deepEqual(protocol.requests.map(request => request.method), ['mcp/list', 'workspace/mcp/trust', 'workspace/mcp/trust']);
  assert.deepEqual(protocol.requests[1].payload, { workspace: { workspacePath: '/ws' }, serverName: 'agent_team', declarationDigest: 'digest-team', trusted: true });
  assert.deepEqual(protocol.requests[2].payload.serverName, 'playwright');
});

test('trustWorkspaceMcpServers fails loudly for missing servers and rejected trust', async () => {
  const missingTeam = fakeZcodeProtocol({});
  await assert.rejects(
    trustWorkspaceMcpServers(missingTeam, { workspacePath: '/ws' }, ['agent_team']),
    /ZCode 会话未加载 agent_team MCP server；请检查 endpoint 配置/,
  );
  const missingBrowser = fakeZcodeProtocol({ agent_team: { workspaceTrust: { trusted: true } } });
  await assert.rejects(
    trustWorkspaceMcpServers(missingBrowser, { workspacePath: '/ws' }, ['agent_team', 'playwright']),
    /ZCode 会话未加载 playwright MCP server；请检查宿主配置/,
  );
  const rejected = fakeZcodeProtocol(
    { agent_team: {}, playwright: { workspaceTrust: { declarationDigest: 'd', trusted: false } } },
    { playwright: { accepted: false, reasonCode: 'declaration-mismatch' } },
  );
  await assert.rejects(
    trustWorkspaceMcpServers(rejected, { workspacePath: '/ws' }, ['agent_team', 'playwright']),
    /playwright MCP server 授信失败: declaration-mismatch/,
  );
  const accepted = fakeZcodeProtocol({ agent_team: {} }, { agent_team: { accepted: true } });
  await trustAgentTeamServer(accepted, { workspacePath: '/ws' });
  assert.deepEqual(accepted.requests.map(request => request.method), ['mcp/list']);
});
});

describe('host-stderr-summary', () => {
const moduleFailure = `policy (file:///Library/Development/Projects/AgentProjects/agent-team/src/host-runtime/dsh-policy.mjs): failed to import: Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Library/Development/Projects/AgentProjects/agent-team/src/host-runtime/dsh-policy.mjs' imported from /Users/zhoujunxiang/.dsh/profiles/headless/
    at finalizeResolution (node:internal/modules/esm/resolve:275:11)
    at moduleResolve (node:internal/modules/esm/resolve:861:10)
    at defaultResolve (node:internal/modules/esm/resolve:985:11)
    at ModuleLoader.resolve (node:internal/modules/esm/loader:747:20)
    at ModuleLoader.getModuleJobForImport (node:internal/modules/esm/loader:320:38)
    at file:///Users/zhoujunxiang/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:2728:77
`;

test('丢掉堆栈帧,只留根因那一行', () => {
  const summary = summarizeHostStderr(moduleFailure);
  assert.match(summary, /ERR_MODULE_NOT_FOUND/);
  assert.doesNotMatch(summary, /^\s+at /m);
  assert.doesNotMatch(summary, /node:internal/);
  assert.ok(!summary.includes('\n'), '摘要应是单行,不含换行');
});

test('多行长文本截断到上限并保留省略号', () => {
  const summary = summarizeHostStderr(moduleFailure, { max: 80 });
  assert.ok(summary.length <= 80 + '…'.length);
  assert.ok(summary.endsWith('…'));
});

test('多处同类错误合并计数,不逐条铺开', () => {
  const three = [
    'policy: failed to import: Error [ERR_MODULE_NOT_FOUND]: cannot find a',
    '    at resolve (node:internal/modules/esm/resolve:1:1)',
    'model-observer: failed to import: Error [ERR_MODULE_NOT_FOUND]: cannot find b',
    'telemetry-observer: failed to import: Error [ERR_MODULE_NOT_FOUND]: cannot find c',
  ].join('\n');
  const summary = summarizeHostStderr(three);
  assert.match(summary, /另有 2 处同类错误/);
  assert.ok(summary.split('\n').length === 1);
});

test('额度类错误保留可读原因', () => {
  const quota = '[lm-deepseek-api-key] model listing from https://api.deepseek.com/models loaded 2 model(s), skipped 0 row(s) (dsh: QUOTA: Insufficient Balance (request_id: 35b42063))';
  assert.match(summarizeHostStderr(quota), /Insufficient Balance/);
});

test('空输入回落到空串,由调用方给默认话术', () => {
  assert.equal(summarizeHostStderr(''), '');
  assert.equal(summarizeHostStderr('   \n  \n'), '');
  assert.equal(summarizeHostStderr(undefined), '');
});

test('纯堆栈输入不产生根因', () => {
  const onlyStack = ['    at a (node:internal/x:1:1)', '    at b (node:internal/y:2:2)'].join('\n');
  assert.equal(summarizeHostStderr(onlyStack), '');
});
});

describe('dsh-member', () => {
function credentialsFixture(t, content) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-credentials-'));
  const path = join(directory, '.credentials.yaml');
  if (content !== null) writeFileSync(path, content);
  t.after(() => { try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ } });
  return path;
}

test('readDshApiKey extracts DEEPSEEK_API_KEY from credentials', t => {
  const path = credentialsFixture(t, 'other: 1\n  DEEPSEEK_API_KEY: "sk-test-abc123"\nlast: 2\n');
  assert.equal(readDshApiKey(path), 'sk-test-abc123');
});

test('readDshApiKey returns null when file or field is missing', t => {
  assert.equal(readDshApiKey(credentialsFixture(t, 'other: 1\n')), null);
  assert.equal(readDshApiKey(credentialsFixture(t, null)), null);
});

test('dshProcessEnv injects key only when absent, without mutating base', t => {
  const path = credentialsFixture(t, 'DEEPSEEK_API_KEY: sk-from-file\n');
  const base = { PATH: '/usr/bin' };
  const injected = dshProcessEnv(base, path);
  assert.equal(injected.DEEPSEEK_API_KEY, 'sk-from-file');
  assert.equal(base.DEEPSEEK_API_KEY, undefined, 'base env must stay untouched');
  assert.equal(injected.PATH, '/usr/bin');
});

test('dshProcessEnv preserves an existing key and passes through when unreadable', t => {
  const path = credentialsFixture(t, 'DEEPSEEK_API_KEY: sk-from-file\n');
  const existing = { DEEPSEEK_API_KEY: 'sk-from-env' };
  assert.equal(dshProcessEnv(existing, path).DEEPSEEK_API_KEY, 'sk-from-env');
  const empty = { PATH: '/usr/bin' };
  assert.deepEqual(dshProcessEnv(empty, credentialsFixture(t, null)), empty);
});

test('runDshCatalogProbe passes the injected key to the dsh child process', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-env-probe-'));
  const seen = join(directory, 'seen.txt');
  const script = join(directory, 'fake-dsh.mjs');
  writeFileSync(script, `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(seen)}, process.env.DEEPSEEK_API_KEY ?? '<missing>');
process.stdout.write('AGENT_TEAM_DSH_MODEL_CATALOG ' + JSON.stringify({ ok: true, defaultModel: 'p/m', providers: [{ id: 'p', models: [{ id: 'm' }] }], failures: [] }) + '\\n');
`);
  const fake = process.platform === 'win32' ? join(directory, 'fake-dsh.cmd') : script;
  if (process.platform === 'win32') writeFileSync(fake, `@echo off\r\n"${process.execPath}" "%~dp0fake-dsh.mjs" %*\r\n`);
  else { writeFileSync(script, `#!/usr/bin/env node\n` + readFileSync(script, 'utf8')); chmodSync(fake, 0o700); }
  t.after(() => { try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ } });
  const env = dshProcessEnv({ PATH: process.env.PATH ?? '' }, credentialsFixture(t, 'DEEPSEEK_API_KEY: sk-injected\n'));
  const result = await runDshCatalogProbe(fake, directory, { env });
  assert.ok(Array.isArray(result.providers));
  assert.equal(readFileSync(seen, 'utf8'), 'sk-injected');
});

test('dshWakeEnv 从凭据文件补齐唤醒回合的 key,extraEnv 优先', t => {
  const path = credentialsFixture(t, 'DEEPSEEK_API_KEY: sk-wake-file\n');
  const injected = dshWakeEnv({ baseEnv: { PATH: '/usr/bin' }, credentialsPath: path });
  assert.equal(injected.DEEPSEEK_API_KEY, 'sk-wake-file');
  assert.equal(injected.PATH, '/usr/bin');

  const explicit = dshWakeEnv({ baseEnv: { PATH: '/usr/bin' }, extraEnv: { DEEPSEEK_API_KEY: 'sk-explicit' }, credentialsPath: path });
  assert.equal(explicit.DEEPSEEK_API_KEY, 'sk-explicit', '调用方显式提供的 key 优先');

  const empty = { PATH: '/bin' };
  assert.deepEqual(dshWakeEnv({ baseEnv: empty, credentialsPath: credentialsFixture(t, null) }), empty);
});

test('wakeDshSession 把凭据注入唤醒子进程', async t => {
  const saved = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  t.after(() => { if (saved !== undefined) process.env.DEEPSEEK_API_KEY = saved; });

  const directory = mkdtempSync(join(tmpdir(), 'dsh-wake-env-'));
  const seen = join(directory, 'seen.txt');
  const script = join(directory, 'fake-dsh.mjs');
  writeFileSync(script, `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(seen)}, process.env.DEEPSEEK_API_KEY ?? '<missing>');
process.stdout.write(JSON.stringify({ type: 'status', phase: 'turn_end', reason: { kind: 'completed' } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'final', text: 'ok' }) + '\\n');
`);
  const fake = process.platform === 'win32' ? join(directory, 'fake-dsh.cmd') : script;
  if (process.platform === 'win32') writeFileSync(fake, `@echo off\r\n"${process.execPath}" "%~dp0fake-dsh.mjs" %*\r\n`);
  else { writeFileSync(script, `#!/usr/bin/env node\n` + readFileSync(script, 'utf8')); chmodSync(fake, 0o700); }
  t.after(() => { try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ } });

  const result = await wakeDshSession({
    command: fake,
    threadId: 'thread-1',
    text: 'hi',
    credentialsPath: credentialsFixture(t, 'DEEPSEEK_API_KEY: sk-wake-injected\n'),
    timeout: 15000,
  });

  assert.equal(result.state, 'started');
  assert.equal(readFileSync(seen, 'utf8'), 'sk-wake-injected');
});

test('DSH catalog waits for stdout completion and defers exit outside the write callback', async () => {
  const timers = [];
  const writes = [];
  const exits = [];
  const source = readFileSync(new URL('../../member/dsh/model-catalog.mjs', import.meta.url), 'utf8');
  const apply = runInNewContext(source.replace('export const inject', 'const inject').replace('export function apply', 'function apply') + '; apply;', {
    process: { stdout: { write: (text, callback) => writes.push({ text, callback }) }, exit: code => exits.push(code) },
    setTimeout: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimeout: () => {},
  });
  apply({
    llm: { listProviders: () => [{ id: 'fixture', name: 'Fixture' }], listModels: async () => [{ id: 'model' }], resolveModelInfo: async () => ({ id: 'model', name: 'Model' }) },
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'model' }) },
    on: () => {},
  });
  await timers.find(timer => timer.delay === 1000).callback();
  assert.equal(writes.length, 1);
  const catalog = JSON.parse(writes[0].text.trim().slice('AGENT_TEAM_DSH_MODEL_CATALOG '.length));
  assert.equal(catalog.ok, true);
  assert.equal(catalog.providers[0].models[0].key, 'fixture/model');
  assert.equal(timers.filter(timer => timer.delay === 50).length, 0);
  writes[0].callback();
  assert.deepEqual(exits, []);
  const exitTimer = timers.find(timer => timer.delay === 50);
  assert.ok(exitTimer);
  exitTimer.callback();
  assert.deepEqual(exits, [0]);
});

test('DSH 目录探测写入 patch 的插件模块路径必须真实存在', () => {
  const source = readFileSync(new URL('../../member/dsh/index.mjs', import.meta.url), 'utf8');
  const base = new URL('../../member/dsh/index.mjs', import.meta.url);
  const refs = [...source.matchAll(/new URL\('(\.\/[^']+)'/g)].map(match => match[1]);
  assert.ok(refs.length > 0, 'index.mjs 应至少引用一个相对插件模块');
  assert.ok(source.includes("'agent-team-model-catalog'"), '目录探测应插入 agent-team 模型目录插件');
  for (const ref of refs) {
    assert.ok(existsSync(new URL(ref, base)), `引用的插件模块不存在: ${ref}`);
  }
});
});
