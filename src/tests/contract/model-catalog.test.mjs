import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../../bus.mjs';
import { createCodexHost } from '../../member/codex/index.mjs';
import { createClaudeHost, createDshHost } from '../../hosts/cli-hosts.mjs';
import { createZcodeHost } from '../../member/zcode/index.mjs';
import { modelCatalog } from '../../hosts/catalog.mjs';
import { rpc } from '../../rpc.mjs';
import { startServer } from '../../server.mjs';

// Fake 宿主入口脚本。Windows 下命令是转发给 node 的 .cmd 垫片，
// 因此这些契约测试不依赖真实 CLI，且保持三平台中性。
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
