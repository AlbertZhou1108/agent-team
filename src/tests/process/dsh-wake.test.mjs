import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dshWakeFingerprint, wakeDshSession } from '../../member/dsh/wake.mjs';

function fixture(t, source) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-wake-'));
  const file = join(directory, 'fixture.mjs');
  writeFileSync(file, `#!/usr/bin/env node\n${source}`);
  chmodSync(file, 0o700);
  const command = process.platform === 'win32' ? join(directory, 'fixture.cmd') : file;
  if (process.platform === 'win32') writeFileSync(command, `@echo off\r\n"${process.execPath}" "%~dp0fixture.mjs" %*\r\n`);
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return command;
}

const COMMON_STUB = `
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const profileAt = argv.indexOf('--profile');
assert.equal(argv[profileAt + 1], 'headless');
const patchAt = argv.indexOf('--patch');
const overlayPath = argv[patchAt + 1];
const overlay = JSON.parse(readFileSync(overlayPath, 'utf8'));
const inserted = overlay.flatMap(entry => entry.insert ?? []);
const mcp = inserted.find(item => item.id === 'agent-team-mcp');
assert.ok(mcp, 'wake overlay must inject the agent_team MCP server');
assert.equal(mcp.config.serverName, 'agent_team');
assert.equal(mcp.config.command, process.env.STUB_MCP_COMMAND ?? '/tmp/agent-team-node');
assert.equal(mcp.config.failOnStartupError, true);
assert.equal(argv[argv.indexOf('--session-id') + 1], process.env.STUB_SESSION ?? 'session-1');
assert.equal(argv[argv.indexOf('--approval-policy') + 1], 'never');
assert.ok(argv.includes('--json'), 'wake must request the NDJSON event stream');
const task = argv[argv.length - 1];
assert.equal(task, process.env.STUB_TEXT ?? '请领取 Agent Team 事件');
const send = value => console.log(JSON.stringify(value));
send({ type: 'session', sessionId: process.env.STUB_SESSION ?? 'session-1' });
send({ type: 'text', text: '好的' });
send({ type: 'final', text: '已领取' });
send({ type: 'status', phase: 'turn_end', reason: { kind: 'completed' } });
`;

test('DSH active wake resumes the session through headless with an MCP overlay', async t => {
  const command = fixture(t, COMMON_STUB);
  const result = await wakeDshSession({
    command,
    threadId: 'session-1',
    text: '请领取 Agent Team 事件',
    cwd: process.cwd(),
    mcpConfig: {
      command: '/tmp/agent-team-node',
      args: ['/tmp/agent-team.mjs', 'mcp'],
      env: { AGENT_TEAM_CLIENT_KEY: 'redacted' },
    },
  });
  assert.equal(result.supported, true);
  assert.equal(result.state, 'started');
  assert.equal(result.mode, 'dsh');
  assert.equal(result.sessionId, 'session-1');
  assert.equal(result.response, '已领取');
  assert.match(result.fingerprint, /^[0-9a-f]{64}$/);
});

test('DSH active wake surfaces adoption failures as structured wake failures', async t => {
  const command = fixture(t, `
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const overlay = JSON.parse(readFileSync(argv[argv.indexOf('--patch') + 1], 'utf8'));
assert.ok(overlay.flatMap(entry => entry.insert ?? []).find(item => item.id === 'agent-team-mcp'));
console.log(JSON.stringify({ type: 'error', message: 'session-cwd-mismatch: recorded working directory does not match' }));
process.exit(1);
`);
  const result = await wakeDshSession({ command, threadId: 'session-404', text: '唤醒' });
  assert.equal(result.supported, true);
  assert.equal(result.state, 'failed');
  assert.match(result.reason, /session-cwd-mismatch/);
});

test('DSH active wake fails when the turn ends without completion', async t => {
  const command = fixture(t, `
import { createInterface } from 'node:readline';
console.log(JSON.stringify({ type: 'session', sessionId: 'session-1' }));
console.log(JSON.stringify({ type: 'final', text: '半途' }));
console.log(JSON.stringify({ type: 'status', phase: 'turn_end', reason: { kind: 'cancelled' } }));
`);
  const result = await wakeDshSession({ command, threadId: 'session-1', text: '唤醒' });
  assert.equal(result.state, 'failed');
  assert.match(result.reason, /cancelled/);
});

test('DSH wake fingerprint tracks the dsh home patch layer', t => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-wake-fp-'));
  t.after(() => {
    delete process.env.DSH_HOME;
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const mcpConfig = { command: '/tmp/n', args: [], env: {} };
  const base = dshWakeFingerprint({ command: 'dsh', threadId: 'session-1', mcpConfig });
  writeFileSync(join(directory, 'cordis.patch.yml'), '[]\n');
  process.env.DSH_HOME = directory;
  const changed = dshWakeFingerprint({ command: 'dsh', threadId: 'session-1', mcpConfig });
  assert.notEqual(base, changed);
  const same = dshWakeFingerprint({ command: 'dsh', threadId: 'session-1', mcpConfig });
  assert.equal(changed, same);
});
