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
