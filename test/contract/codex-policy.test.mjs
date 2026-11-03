import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexHost } from '../../src/hosts/codex.mjs';

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
  const { codexPolicyConfig } = await import('../../src/hosts/policies.mjs');
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
  const { codexPolicyConfig } = await import('../../src/hosts/policies.mjs');
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

test('attachment policy helpers gate private sessions and build internal manifests', async () => {
  const { attachmentManifest, panelAttachmentsAllowed } = await import('../../src/hosts/policies.mjs');
  const { codexTurnInput } = await import('../../src/hosts/codex.mjs');

  // 只有带 access 的私人策略允许附件;communication 不扩大。
  assert.equal(panelAttachmentsAllowed({ mode: 'communication', allowShell: false }), false);
  assert.equal(panelAttachmentsAllowed({ mode: 'read-only', allowShell: true, access: 'read-only' }), true);
  assert.equal(panelAttachmentsAllowed({}), false);
  assert.equal(panelAttachmentsAllowed(null), false);

  // 清单包含 id/type/name/path;空清单返回空串。
  const manifest = attachmentManifest([
    { id: 'a1', mediaType: 'text/plain', name: 'a.txt', path: '/ws/.agent-team/attachments/a1' },
  ]);
  assert.ok(manifest.includes('[attachment:a1] text/plain a.txt -> /ws/.agent-team/attachments/a1'));
  assert.equal(attachmentManifest([]), '');
  assert.equal(attachmentManifest(undefined), '');

  // Codex turn 输入:正文保持原文,TXT 清单内嵌,PNG 附加 localImage。
  const input = codexTurnInput('看看附件', [
    { id: 'a1', mediaType: 'text/plain', name: 'a.txt', path: '/ws/att/a1' },
    { id: 'p1', mediaType: 'image/png', name: 'p.png', path: '/ws/att/p1' },
  ]);
  assert.equal(input.length, 2);
  assert.equal(input[0].type, 'text');
  assert.ok(input[0].text.startsWith('看看附件'));
  assert.ok(input[0].text.includes('[attachment:a1] text/plain a.txt -> /ws/att/a1'));
  assert.deepEqual(input[1], { type: 'localImage', path: '/ws/att/p1' });
  // 无附件时正文原样;多个 PNG 保持顺序。
  assert.deepEqual(codexTurnInput('plain', []).map(item => item.text), ['plain']);
  const many = codexTurnInput('x', [
    { id: 'p1', mediaType: 'image/png', name: '1.png', path: '/p1' },
    { id: 'p2', mediaType: 'image/png', name: '2.png', path: '/p2' },
  ]);
  assert.deepEqual(many.slice(1), [{ type: 'localImage', path: '/p1' }, { type: 'localImage', path: '/p2' }]);
});

test('Codex adapter forwards attachments as localImage items and refuses them in communication mode', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-codex-attach-'));
  const fake = join(directory, 'fake-codex.mjs');
  writeFileSync(fake, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const record = value => writeFileSync(join(dirname(process.argv[1]), 'turn-inputs.jsonl'), JSON.stringify(value) + '\\n', { flag: 'a' });
createInterface({ input: process.stdin }).on('line', line => {
  const row = JSON.parse(line);
  if (row.method === 'initialize') return send({ id: row.id, result: {} });
  if (row.method === 'config/read') return send({ id: row.id, result: { config: { mcp_servers: {} } } });
  if (row.method === 'thread/start') return send({ id: row.id, result: { thread: { id: 'thread-att' }, model: 'test', modelProvider: 'test', reasoningEffort: null } });
  if (row.method === 'turn/start') {
    record(row.params.input);
    send({ id: row.id, result: { turn: { id: 'turn-att' } } });
    setImmediate(() => send({ method: 'turn/completed', params: { threadId: 'thread-att', turn: { id: 'turn-att', status: 'completed' } } }));
    return;
  }
  if (row.method === 'turn/interrupt') return send({ id: row.id, result: {} });
});
`);
  chmodSync(fake, 0o700);
  const host = createCodexHost({ command: fake });
  t.after(async () => { await host.close(); rmSync(directory, { recursive: true, force: true }); });

  const attachments = [
    { id: 'a1', mediaType: 'text/plain', name: 'a.txt', path: join(directory, 'att', 'a1') },
    { id: 'p1', mediaType: 'image/png', name: 'p.png', path: join(directory, 'att', 'p1') },
  ];
  const base = {
    endpoint: { id: 'endpoint', key: 'key', session: null },
    turnId: 'framework-turn',
    workspace: directory,
    prompt: '读取附件',
    instructions: 'Use tools.',
    tools: [],
    attachments,
    signal: new AbortController().signal,
    onSession() {},
    onAccepted() {},
    onNativeTurn() {},
    onModel() {},
    onEvent() {},
    onTool: async () => ({}),
  };

  // 私人会话(read-only + allowShell,带 access):PNG → localImage,TXT → 内部清单,顺序保留。
  await host.run({ ...base, policy: { mode: 'read-only', allowShell: true, access: 'read-only', domain: 'project' } });
  const recorded = JSON.parse(readFileSync(join(directory, 'turn-inputs.jsonl'), 'utf8').trim().split('\n').at(-1));
  assert.equal(recorded[0].type, 'text');
  assert.ok(recorded[0].text.startsWith('读取附件'));
  assert.ok(recorded[0].text.includes('[attachment:a1] text/plain a.txt -> '));
  assert.deepEqual(recorded[1], { type: 'localImage', path: attachments[1].path });

  // communication 模式带附件:执行前明确拒绝,不进入宿主回合。
  await assert.rejects(
    host.run({ ...base, policy: { mode: 'communication', allowShell: false } }),
    /不支持附件输入/,
  );
});
