import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeCodex, probeClaude, exchange, connectionProbe } from '../../hosts/probe.mjs';
import { createDshHost } from '../../hosts/cli-hosts.mjs';

function fixture(t, source) {
  const directory = mkdtempSync(join(tmpdir(), 'probe space-'));
  const file = join(directory, 'fixture.mjs');
  writeFileSync(file, `#!/usr/bin/env node\n${source}`);
  chmodSync(file, 0o700);
  const command = process.platform === 'win32' ? join(directory, 'fixture.cmd') : file;
  if (process.platform === 'win32') writeFileSync(command, `@echo off\r\n"${process.execPath}" "%~dp0fixture.mjs" %*\r\n`);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { command, directory };
}

test('Codex and Claude probes exchange only initialization/catalog messages', async t => {
  const { command } = fixture(t, `
import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line', line=>{
 const row=JSON.parse(line);
 if(row.method==='initialize') console.log(JSON.stringify({id:row.id,result:{serverInfo:{}}}));
 else if(row.method==='model/list') console.log(JSON.stringify({id:row.id,result:{data:[{id:'model'}]}}));
 else if(row.method==='initialized') {}
 else if(row.type==='control_request' && row.request.subtype==='initialize') console.log(JSON.stringify({type:'control_response',response:{request_id:row.request_id,subtype:'success',response:{models:[{value:'model'}]}}}));
 else {console.error('unexpected task');process.exit(9);}
});`);
  assert.deepEqual(await probeCodex(command), { connected: true });
  assert.deepEqual(await probeClaude(command), { connected: true });
});

test('probes reject malformed output, early exit and missing commands', async () => {
  await assert.rejects(exchange(process.execPath, ['-e', 'console.log("not json");setInterval(()=>{},1000)'], { receive: JSON.parse }), SyntaxError);
  await assert.rejects(exchange(process.execPath, ['-e', 'process.exit(7)'], { receive: JSON.parse }), /退出 \(7\)/);
  await assert.rejects(exchange(join(tmpdir(), 'missing-agent-team-command'), [], { receive: JSON.parse }), /ENOENT/);
});

test('timeout and cancellation wait for their own process to stop', { timeout: 12000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'probe-stop-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const pidFile = join(directory, 'pid');
  const source = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
  await assert.rejects(exchange(process.execPath, ['-e', source], { receive: JSON.parse, timeout: 1500 }), /超时/);
  assert.throws(() => process.kill(Number(readFileSync(pidFile)), 0), { code: 'ESRCH' });
  rmSync(pidFile);
  const controller = new AbortController();
  const result = exchange(process.execPath, ['-e', source], { receive: JSON.parse, signal: controller.signal });
  const rejection = assert.rejects(result, /cancel test/);
  while (!existsSync(pidFile)) await new Promise(resolve => setTimeout(resolve, 10));
  controller.abort(new Error('cancel test'));
  await rejection;
  assert.throws(() => process.kill(Number(readFileSync(pidFile)), 0), { code: 'ESRCH' });
});

test('connection checks deduplicate probes and never install to repair an error', async () => {
  let calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const connection = connectionProbe({ async checkStatus() { return { status: 'available' }; } }, async () => { calls++; await gate; throw new Error('host rejected'); });
  const first = connection.probeConnection(), second = connection.probeConnection();
  assert.equal(first, second); assert.equal(connection.connectionStatus().status, 'checking');
  release(); assert.equal((await first).reason, 'host rejected'); assert.equal(calls, 1);
  assert.equal(connection.connectionStatus().status, 'error');
});

test('DSH directory discovery disables task drivers and supplies no task', async t => {
  const { command, directory } = fixture(t, `
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const args=process.argv.slice(2);assert.equal(args.length,4);assert.equal(args[0],'--profile');assert.equal(args[1],'headless');assert.equal(args[2],'--patch');
const rows=JSON.parse(readFileSync(args[3]));
for(const id of ['headless-runner','headless-startup']) assert.equal(rows.find(row=>row.id===id).disabled,true);
console.log('AGENT_TEAM_DSH_MODEL_CATALOG '+JSON.stringify({ok:true,providers:[{models:[{id:'model',key:'provider/model',isDefault:true}]}],defaultModel:'provider/model'}));`);
  const catalog = await createDshHost({ command, directory }).listModels();
  assert.equal(catalog.defaultModel, 'provider/model');
});
