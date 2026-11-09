import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wakeCodexAppServer } from '../../hosts/codex-wake.mjs';

function fixture(t, source) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-wake-'));
  const file = join(directory, 'fixture.mjs');
  writeFileSync(file, `#!/usr/bin/env node\n${source}`);
  chmodSync(file, 0o700);
  const command = process.platform === 'win32' ? join(directory, 'fixture.cmd') : file;
  if (process.platform === 'win32') writeFileSync(command, `@echo off\r\n"${process.execPath}" "%~dp0fixture.mjs" %*\r\n`);
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return command;
}

test('Codex active wake queues into the thread and waits for turn started', async t => {
  const command = fixture(t, `
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
let clientUserMessageId;
assert.deepEqual(process.argv.slice(2).slice(0, 2), ['app-server', '--stdio']);
createInterface({ input: process.stdin }).on('line', line => {
  const row = JSON.parse(line);
  const send = value => console.log(JSON.stringify(value));
  if (row.method === 'initialize') send({ id: row.id, result: { serverInfo: {} } });
  else if (row.method === 'initialized') {}
  else if (row.method === 'thread/resume') {
    assert.equal(row.params.threadId, 'thread-1');
    send({ id: row.id, result: { thread: { id: 'thread-1' }, model: 'deepseek-flash', modelProvider: 'custom' } });
  } else if (row.method === 'thread/queue/add') {
    clientUserMessageId = row.params.clientUserMessageId;
    assert.equal(row.params.threadId, 'thread-1');
    assert.equal(row.params.input[0].text, '请领取 Agent Team 事件');
    send({ id: row.id, result: { queuedSubmission: { id: 'queue-1', clientUserMessageId: row.params.clientUserMessageId, input: row.params.input } } });
    send({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } });
    send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } } });
  } else if ('id' in row) send({ id: row.id, error: { message: 'unexpected ' + row.method } });
});
`);
  const result = await wakeCodexAppServer({
    command,
    threadId: 'thread-1',
    text: '请领取 Agent Team 事件',
    cwd: process.cwd(),
    mcpConfig: {
      command: process.execPath,
      args: ['/tmp/agent-team.mjs', 'mcp'],
      env: { AGENT_TEAM_CLIENT_KEY: 'redacted' },
    },
  });
  assert.equal(result.supported, true);
  assert.equal(result.state, 'started');
  assert.equal(result.mode, 'codex');
  assert.equal(result.threadId, 'thread-1');
  assert.equal(result.turnId, 'turn-1');
  assert.equal(result.queuedSubmissionId, 'queue-1');
  assert.match(result.fingerprint, /^[0-9a-f]{64}$/);
});
