import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createZcodeHost, zcodeCapabilities, probeZcode } from '../../member/zcode/index.mjs';
import { telemetryCapabilitiesFor } from '../../telemetry-capabilities.mjs';

function fixture(t, source) {
  const directory = mkdtempSync(join(tmpdir(), 'zcode-host-'));
  const file = join(directory, 'fixture.mjs');
  writeFileSync(file, `#!/usr/bin/env node\n${source}`);
  chmodSync(file, 0o700);
  const command = process.platform === 'win32' ? join(directory, 'fixture.cmd') : file;
  if (process.platform === 'win32') writeFileSync(command, `@echo off\r\n"${process.execPath}" "%~dp0fixture.mjs" %*\r\n`);
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return command;
}

function baseStub(extra = '') {
  return `
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
console.log(JSON.stringify({ method: 'startup/storagePath', params: { path: '/tmp/stub-db.sqlite' } }));
let acked = false;
function checkEndpointConfig() {
  const config = JSON.parse(readFileSync(join(process.env.HOME, '.zcode', 'cli', 'config.json'), 'utf8'));
  const server = config.mcp?.servers?.agent_team;
  assert.ok(server, 'agent_team MCP server must be configured for the endpoint home');
  assert.equal(process.env.STUB_EXPECT_ENDPOINT ? server.env.AGENT_TEAM_KEY : server.env.AGENT_TEAM_KEY, process.env.STUB_ENDPOINT_KEY ?? 'ep-key');
  assert.equal(server.env.AGENT_TEAM_TURN, process.env.STUB_ENDPOINT_TURN ?? 'turn-1');
  assert.ok(process.env.HOME.includes(process.env.STUB_HOME_HINT ?? 'zcode-endpoints'), 'must run inside the endpoint home');
}
createInterface({ input: process.stdin }).on('line', line => {
  const row = JSON.parse(line);
  const send = value => console.log(JSON.stringify(value));
  if (row.method === 'startup/storagePathReady') {
    acked = true;
    send({ method: 'startup/storageState', params: { sequence: 1 } });
    return;
  }
  if (row.method?.startsWith('startup/')) return;
  if (row.id && row.method === 'session/requestRuntimePreferences') {
    send({ id: row.id, result: { nativeSearchEnhancementsEnabled: false } });
    return;
  }
  if (!acked) {
    if ('id' in row) send({ id: row.id, error: { message: '启动握手未完成' } });
    return;
  }
  if (row.method === 'session/create') {
    checkEndpointConfig();
    send({ id: row.id, result: { session: { sessionId: 'sess-new-1', mode: 'build', model: { providerId: 'prov-1', modelId: 'deepseek-v4-flash' } } } });
  } else if (row.method === 'session/resume') {
    checkEndpointConfig();
    assert.equal(row.params.sessionId, process.env.STUB_RESUME_SESSION ?? 'sess-existing');
    send({ id: row.id, result: { messages: [] } });
  } else if (row.method === 'session/setModel') {
    assert.equal(row.params.sessionId, process.env.STUB_RESUME_SESSION ?? 'sess-new-1');
    assert.deepEqual(row.params.model, { providerId: process.env.STUB_MODEL_PROVIDER ?? 'prov-1', modelId: process.env.STUB_MODEL_ID ?? 'deepseek-v4-flash' });
    send({ id: row.id, result: {} });
  } else if (row.method === 'session/setThoughtLevel') {
    assert.equal(row.params.thoughtLevel, 'low');
    send({ id: row.id, result: {} });
  } else if (row.method === 'session/subscribe') {
    send({ id: row.id, result: { eventSeq: 0, events: [] } });
  } else if (row.method === 'mcp/list') {
    send({ id: row.id, result: { statuses: { agent_team: { status: 'connected', transport: 'stdio', toolCount: 5, workspaceTrust: { declarationDigest: 'a'.repeat(64), trusted: false, configuredEnabled: true } } } } });
  } else if (row.method === 'workspace/mcp/trust') {
    assert.equal(row.params.serverName, 'agent_team');
    assert.equal(row.params.trusted, true);
    send({ id: row.id, result: { accepted: true } });
  } else if (row.method === 'session/send') {
    assert.ok(row.params.content.includes('团队规则'), 'instructions must precede the prompt');
    assert.ok(row.params.content.includes('当前输入'), 'prompt must be labeled');
    send({ id: row.id, result: { accepted: true, stateRevision: 1 } });
    const sessionId = row.params.sessionId;
    send({ method: 'session/event', params: { sessionId, turnId: 'turn-native-1', timestamp: 1000, type: 'turn.started', payload: { input: row.params.content } } });
    send({ method: 'session/event', params: { sessionId, turnId: 'turn-native-1', timestamp: 1100, type: 'text_delta', payload: { delta: '你好', assistantMessageId: 'msg-1', done: false } } });
    send({ method: 'session/event', params: { sessionId, turnId: 'turn-native-1', timestamp: 1200, type: 'model_request_completed', payload: { requestId: 'req-1', modelId: 'deepseek-v4-flash', contextWindow: 200000, usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105, cacheReadTokens: 80, cacheWriteTokens: 0 } } } });
    send({ method: 'session/event', params: { sessionId, turnId: 'turn-native-1', timestamp: 1450, type: 'turn.completed', payload: { response: '你好，已收到', tokenCount: 105, usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105, cacheReadTokens: 80, cacheWriteTokens: 0, reasoningTokens: 0 } } } });
  } else if ('id' in row) send({ id: row.id, result: {} });
});
${extra}
`;
}

function makeContext(endpoint) {
  const events = [];
  return {
    context: {
      endpoint,
      prompt: '干一件事',
      instructions: '团队规则',
      turnId: 'turn-1',
      workspace: mkdtempSync(join(tmpdir(), 'zcode-ws-')),
      signal: new AbortController().signal,
      modelSelection: { model_provider: 'prov-1', model: 'deepseek-v4-flash', reasoning_effort: 'low' },
      onSession: value => events.push(['session', value]),
      onAccepted: () => events.push(['accepted']),
      onTextDelta: delta => events.push(['delta', delta]),
      onTelemetry: observation => events.push(['telemetry', observation]),
      onModel: model => events.push(['model', model]),
      onSelection: selection => events.push(['selection', selection]),
      onPolicy: policy => events.push(['policy', policy]),
    },
    events,
  };
}

test('zcode member run creates a session, applies model selection and returns the final text', async t => {
  const root = mkdtempSync(join(tmpdir(), 'zcode-host-root-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const command = fixture(t, baseStub());
  const host = createZcodeHost({ directory: root, socketPath: join(root, 'bus.sock'), command });
  const { context, events } = makeContext({ id: 'endpoint-1', key: 'ep-key', context: 'coordination' });
  const result = await host.run(context);
  assert.equal(result, '你好，已收到');
  assert.deepEqual(events.find(row => row[0] === 'session')?.[1], 'sess-new-1');
  assert.ok(events.some(row => row[0] === 'accepted'), 'send receipt must be acknowledged');
  assert.deepEqual(events.find(row => row[0] === 'delta')?.[1], '你好');
  const selection = events.find(row => row[0] === 'selection')?.[1];
  assert.deepEqual(selection, { model: 'deepseek-v4-flash', reasoning_effort: 'low' });
  const turnTelemetry = events.filter(row => row[0] === 'telemetry').map(row => row[1]).at(-1);
  assert.equal(turnTelemetry.source, 'zcode.turn_completed');
  assert.equal(turnTelemetry.usage.totalTokens, 105);
  assert.equal(turnTelemetry.usage.cacheReadTokens, 80);
  assert.equal(turnTelemetry.usage.uncachedInputTokens, 20);
  assert.ok(Number.isFinite(turnTelemetry.usage.hostTurnWallMs));
  assert.ok(events.some(row => row[0] === 'policy'), 'policy observation must be emitted');
  rmSync(context.workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test('zcode member run resumes the bound endpoint session', async t => {
  const root = mkdtempSync(join(tmpdir(), 'zcode-host-root-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const command = fixture(t, baseStub());
  const host = createZcodeHost({ directory: root, socketPath: join(root, 'bus.sock'), command });
  const { context, events } = makeContext({ id: 'endpoint-2', key: 'ep-key', context: 'coordination' });
  context.endpoint.session = 'sess-existing';
  context.endpoint.key = 'ep-key';
  process.env.STUB_RESUME_SESSION = 'sess-existing';
  t.after(() => { delete process.env.STUB_RESUME_SESSION; });
  const result = await host.run(context);
  assert.equal(result, '你好，已收到');
  assert.deepEqual(events.find(row => row[0] === 'session')?.[1], 'sess-existing');
});

test('zcode listModels reads the catalog from isolated session state', async t => {
  const root = mkdtempSync(join(tmpdir(), 'zcode-host-root-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const command = fixture(t, `
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
console.log(JSON.stringify({ method: 'startup/storagePath', params: { path: '/tmp/stub-db.sqlite' } }));
let acked = false;
createInterface({ input: process.stdin }).on('line', line => {
  const row = JSON.parse(line);
  const send = value => console.log(JSON.stringify(value));
  if (row.method === 'startup/storagePathReady') { acked = true; send({ method: 'startup/storageState', params: { sequence: 1 } }); return; }
  if (row.method?.startsWith('startup/')) return;
  if (row.id && row.method === 'session/requestRuntimePreferences') { send({ id: row.id, result: {} }); return; }
  if (!acked) { if ('id' in row) send({ id: row.id, error: { message: '启动握手未完成' } }); return; }
  if (row.method === 'session/create') {
    assert.ok(process.env.HOME.includes('zcode-catalog-home'), 'catalog probe must use the scratch home');
    send({ id: row.id, result: { session: { sessionId: 'sess-catalog' } } });
    send({ method: 'state.updated', params: { patch: { model: { available: [{ ref: { providerId: 'prov-1', modelId: 'deepseek-v4-flash' }, label: 'deepseek-v4-flash', providerLabel: 'DeepSeek', contextWindow: 200000, reasoning: { levels: [{ value: 'disabled', label: 'disabled' }, { value: 'low', label: 'low' }, { value: 'high', label: 'high' }, { value: 'max', label: 'max' }], defaultLevel: 'max' } }] } } } });
  } else if (row.method === 'session/close') { send({ id: row.id, result: {} }); }
  else if ('id' in row) send({ id: row.id, result: {} });
});
`);
  const host = createZcodeHost({ directory: root, socketPath: join(root, 'bus.sock'), command });
  const catalog = await host.listModels({});
  assert.equal(catalog.host, 'zcode');
  assert.equal(catalog.models.length, 1);
  const model = catalog.models[0];
  assert.equal(model.id, 'deepseek-v4-flash');
  assert.equal(model.provider, 'prov-1');
  assert.deepEqual(model.reasoningEfforts.map(effort => effort.id), ['disabled', 'low', 'high', 'max']);
  assert.equal(model.defaultReasoningEffort, 'max');
  assert.equal(catalog.models.filter(item => item.isDefault).length, 1);
});

test('zcode listModels reads the catalog from session/create settings and answers runtime preferences', async t => {
  const root = mkdtempSync(join(tmpdir(), 'zcode-host-root-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const command = fixture(t, `
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
console.log(JSON.stringify({ method: 'startup/storagePath', params: { path: '/tmp/stub-db.sqlite' } }));
let acked = false;
createInterface({ input: process.stdin }).on('line', line => {
  const row = JSON.parse(line);
  const send = value => console.log(JSON.stringify(value));
  if (row.method === 'startup/storagePathReady') { acked = true; send({ method: 'startup/storageState', params: { sequence: 1 } }); return; }
  if (row.method?.startsWith('startup/')) return;
  if (row.id && row.method === 'session/requestRuntimePreferences') {
    // 新版 app-server 校验应答里必须有布尔 nativeSearchEnhancementsEnabled。
    assert.equal(row.result.nativeSearchEnhancementsEnabled, false);
    send({ id: row.id, result: { nativeSearchEnhancementsEnabled: false } });
    return;
  }
  if (!acked) { if ('id' in row) send({ id: row.id, error: { message: '启动握手未完成' } }); return; }
  if (row.method === 'session/create') {
    assert.ok(process.env.HOME.includes('zcode-catalog-home'), 'catalog probe must use the scratch home');
    // 新版 app 不再推送 state.updated，目录随 session/create 返回。
    send({ id: row.id, result: {
      session: { sessionId: 'sess-catalog' },
      settings: { model: {
        available: [{ ref: { providerId: 'prov-9', modelId: 'deepseek-v4-flash' }, label: 'deepseek-v4-flash', providerLabel: 'DeepSeek', contextWindow: 1000000, reasoning: { levels: [{ value: 'disabled', label: 'disabled' }, { value: 'low', label: 'low' }, { value: 'high', label: 'high' }, { value: 'max', label: 'max' }], defaultLevel: 'max' } }],
        current: { providerId: 'prov-9', modelId: 'deepseek-v4-flash' },
        lastUsed: { providerId: 'prov-9', modelId: 'deepseek-v4-flash' },
      } },
    } });
  } else if (row.method === 'session/close') { send({ id: row.id, result: {} }); }
  else if ('id' in row) send({ id: row.id, result: {} });
});
`);
  const host = createZcodeHost({ directory: root, socketPath: join(root, 'bus.sock'), command });
  const catalog = await host.listModels({});
  assert.equal(catalog.host, 'zcode');
  assert.equal(catalog.models.length, 1);
  const model = catalog.models[0];
  assert.equal(model.id, 'deepseek-v4-flash');
  assert.equal(model.provider, 'prov-9');
  assert.equal(model.defaultReasoningEffort, 'max');
  assert.equal(catalog.defaultModel, 'prov-9:deepseek-v4-flash');
});

test('zcode execution capabilities follow the group policy', t => {
  const root = mkdtempSync(join(tmpdir(), 'zcode-host-root-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const host = createZcodeHost({ directory: root, socketPath: 'unused', command: 'unused-host' });
  assert.deepEqual(host.executionCapabilities({ mode: 'communication', allowShell: true }), {
    effectivePolicy: 'communication', capabilities: [], reason: '仅允许团队通信',
  });
  assert.deepEqual(host.executionCapabilities({ mode: 'read-only', allowShell: true }), {
    effectivePolicy: 'read-only', capabilities: ['exec.read'], reason: '群策略只允许读取',
  });
  const write = host.executionCapabilities({ mode: 'workspace-write', allowShell: false });
  assert.equal(write.effectivePolicy, 'workspace-write');
  assert.ok(write.capabilities.includes('exec.write'));
  assert.ok(!write.capabilities.includes('exec.shell'));
});

test('zcode telemetry capability declaration covers the unified fields', () => {
  const value = telemetryCapabilitiesFor('zcode');
  assert.equal(value.host, 'zcode');
  assert.equal(value.metrics.uncachedInputTokens.capability, 'derived');
  const direct = zcodeCapabilities();
  assert.equal(direct.metrics.inputTokensTotal.capability, 'direct');
});

test('zcode connection probe completes the startup handshake', async t => {
  const command = fixture(t, `
import { createInterface } from 'node:readline';
console.log(JSON.stringify({ method: 'startup/storagePath', params: { path: '/tmp/stub-db.sqlite' } }));
createInterface({ input: process.stdin }).on('line', line => {
  const row = JSON.parse(line);
  const send = value => console.log(JSON.stringify(value));
  if (row.method === 'startup/storagePathReady') { send({ method: 'startup/storageState', params: { sequence: 1 } }); return; }
  if (row.method?.startsWith('startup/')) return;
  if (row.id && row.method) { send({ id: row.id, result: { sessions: [] } }); return; }
});
`);
  const status = await probeZcode(command, {});
  assert.deepEqual(status, { connected: true });
});
