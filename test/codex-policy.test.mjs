import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexHost } from '../src/hosts/codex.mjs';

test('Codex native child-agent and wait activity is interrupted instead of blocking a team turn', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-codex-policy-'));
  const fake = join(directory, 'fake-codex.mjs');
  writeFileSync(fake, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
createInterface({ input: process.stdin }).on('line', line => {
  const row = JSON.parse(line);
  if (row.method === 'initialize') return send({ id: row.id, result: {} });
  if (row.method === 'config/read') return send({ id: row.id, result: { config: { mcp_servers: {} } } });
  if (row.method === 'thread/start') return send({ id: row.id, result: { thread: { id: 'thread-1' }, model: 'test', modelProvider: 'test', reasoningEffort: null } });
  if (row.method === 'turn/start') {
    send({ id: row.id, result: { turn: { id: 'turn-1' } } });
    setImmediate(() => {
      send({ method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'collabAgentToolCall', tool: 'wait' } } });
    });
    return;
  }
  if (row.method === 'turn/interrupt') return send({ id: row.id, result: {} });
});
`);
  chmodSync(fake, 0o700);
  const host = createCodexHost({ command: fake });
  assert.equal(host.sessionKey({ policy: { mode: 'communication' } }), 'communication');
  assert.equal(host.sessionKey({ policy: { mode: 'read-only' } }), 'project');
  assert.equal(host.sessionKey({ policy: { mode: 'workspace-write' } }), 'project');
  assert.equal(host.supportsPolicy({ policy: { mode: 'communication', allowShell: false } }).supported, true);
  assert.equal(host.supportsPolicy({ policy: { mode: 'workspace-write', allowShell: false } }).supported, false);
  t.after(async () => {
    await host.close();
    rmSync(directory, { recursive: true, force: true });
  });

  await assert.rejects(host.run({
    endpoint: { id: 'endpoint', key: 'key', session: null },
    turnId: 'framework-turn',
    workspace: directory,
    prompt: 'wait for a teammate',
    instructions: 'Use only agent_team tools.',
    tools: [],
    policy: { mode: 'communication', allowShell: false },
    signal: new AbortController().signal,
    onSession() {},
    onAccepted() {},
    onNativeTurn() {},
    onModel() {},
    onEvent() {},
    onTool: async () => ({}),
  }), /原生子 Agent\/协同工具/);
});

test('Codex resumes an existing session when only MCP configuration order changes', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-codex-order-'));
  const fake = join(directory, 'fake-codex.mjs');
  writeFileSync(fake, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
createInterface({ input: process.stdin }).on('line', line => {
  const row = JSON.parse(line);
  if (row.method === 'initialize') return send({ id: row.id, result: {} });
  if (row.method === 'config/read') return send({ id: row.id, result: { config: { mcp_servers: { node_repl: {}, shadcn: {}, webstorm: {}, idea: {} } } } });
  if (row.method === 'thread/resume') return send({ id: row.id, result: { thread: { id: row.params.threadId }, model: 'test' } });
  if (row.method === 'thread/start') return send({ id: row.id, error: { message: 'must preserve existing session' } });
  if (row.method === 'turn/start') {
    send({ id: row.id, result: { turn: { id: 'turn-resumed' } } });
    setImmediate(() => send({ method: 'turn/completed', params: { threadId: 'original-session', turn: { id: 'turn-resumed', status: 'completed' } } }));
  }
});
`);
  chmodSync(fake, 0o700);
  const host = createCodexHost({ command: fake });
  t.after(async () => { await host.close(); rmSync(directory, { recursive: true, force: true }); });
  const { codexPolicyConfig } = await import('../src/hosts/policies.mjs');
  const policy = { mode: 'communication', allowShell: false };
  const config = codexPolicyConfig(policy, ['webstorm', 'idea', 'node_repl', 'shadcn']);
  let resumed;
  const context = {
    endpoint: { id: 'endpoint', session: 'original-session' }, workspace: directory,
    turnId: 'framework-turn', prompt: 'report status', instructions: 'Use team tools.', tools: [], policy,
    previousPolicy: { signature: JSON.stringify({ config, tools: [] }) },
    signal: new AbortController().signal, onSession(id) { resumed = id; },
    onAccepted() {}, onNativeTurn() {}, onModel() {}, onEvent() {}, onTool: async () => ({}),
  };
  await host.run(context);
  assert.equal(resumed, 'original-session');
  await assert.rejects(host.run({ ...context, previousPolicy: { signature: JSON.stringify({ config: { ...config, 'features.shell_tool': true }, tools: [] }) } }), /工具配置/);
  await assert.rejects(host.run({ ...context, previousPolicy: { signature: JSON.stringify({ config, tools: ['old_tool'] }) } }), /工具配置/);
  await assert.rejects(host.run({ ...context, previousPolicy: null }), /工具配置/);
});

test('Codex applies member model and effort per turn without breaking session continuity', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-codex-model-'));
  const fake = join(directory, 'fake-codex.mjs');
  writeFileSync(fake, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
createInterface({ input: process.stdin }).on('line', line => {
  const row = JSON.parse(line);
  if (row.method === 'initialize') return send({ id: row.id, result: {} });
  if (row.method === 'config/read') return send({ id: row.id, result: { config: { mcp_servers: {} } } });
  if (row.method === 'thread/resume') {
    if (row.params.config?.model_reasoning_effort) return send({ id: row.id, error: { message: 'effort must not ride in config' } });
    return send({ id: row.id, result: { thread: { id: row.params.threadId }, model: 'old-model' } });
  }
  if (row.method === 'turn/start') {
    const turnId = 'turn-' + row.params.model + '-' + (row.params.effort ?? 'none');
    send({ id: row.id, result: { turn: { id: turnId } } });
    setImmediate(() => send({ method: 'turn/completed', params: { threadId: 'session-1', turn: { id: turnId, status: 'completed' } } }));
  }
});
`);
  chmodSync(fake, 0o700);
  const host = createCodexHost({ command: fake });
  t.after(async () => { await host.close(); rmSync(directory, { recursive: true, force: true }); });
  const policy = { mode: 'communication', allowShell: false };
  const { codexPolicyConfig } = await import('../src/hosts/policies.mjs');
  const previousPolicy = { signature: JSON.stringify({ config: codexPolicyConfig(policy, []), tools: [] }) };
  let signature = null;
  const context = {
    endpoint: { id: 'endpoint', session: 'session-1' }, workspace: directory,
    turnId: 'framework-turn', prompt: 'report status', instructions: 'Use team tools.', tools: [], policy,
    previousPolicy,
    signal: new AbortController().signal, onSession() {}, onAccepted() {}, onNativeTurn() {},
    onModel() {}, onEvent() {}, onTool: async () => ({}),
    onPolicy: observation => { signature = observation.signature; },
  };
  await host.run({ ...context, modelSelection: { model_provider: null, model: 'model-a', reasoning_effort: 'low' } });
  assert.ok(signature);
  // 强度不进会话签名:同签名下换模型+强度恢复会话不应被拒
  await host.run({
    ...context,
    previousPolicy: { signature },
    modelSelection: { model_provider: null, model: 'model-b', reasoning_effort: 'high' },
  });
  assert.equal(JSON.parse(signature).config.model_reasoning_effort, undefined);
});
