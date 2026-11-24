import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { spawnHost, stopHost } from '../../host-runtime/subprocess.mjs';
import { until } from '../support/wait.mjs';
import { createCliLifecycle, installationPlan, runCommand } from '../../host-runtime/lifecycle.mjs';
import { probeCodex, probeClaude, exchange, connectionProbe } from '../../host-runtime/probe.mjs';
import { createDshHost } from '../../hosts/cli-hosts.mjs';

describe('subprocess', () => {
test('host launcher preserves arguments through a Windows npm-style cmd shim', { skip: process.platform !== 'win32', timeout: 10000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'host 中文 space-'));
  let child;
  try {
    const entry = join(directory, 'entry.js');
    writeFileSync(entry, 'console.log(JSON.stringify(process.argv.slice(2)))');
    const shim = join(directory, 'probe.cmd');
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "%~dp0entry.js" %*\r\n`);
    const args = ['中文 path with spaces', JSON.stringify({ prompt: 'a & b | c < d > e "quoted"', path: 'C:\\中文 文件夹\\' }), '%PATH%', 'a^b', 'hello!'];
    child = spawnHost(shim, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    const [code] = await once(child, 'close');
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(output), args);
  } finally {
    await stopHost(child);
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  }
});

// stdout 的 data chunk 不保证与一次 write 对齐，按完整行读取并保留失败现场。
async function readPidLine(host, diagnostics) {
  if (!host.stdout) throw new Error(`宿主 stdout 不可用：${diagnostics()}`);
  const lines = createInterface({ input: host.stdout });
  try {
    for await (const line of lines) return line.trim();
  } finally {
    lines.close();
  }
  throw new Error(`宿主未输出后代进程 pid：${diagnostics()}`);
}

test('stopping a host also terminates its child process', { timeout: 12000 }, async () => {
  // 后代进程要等 'spawn' 才有 pid：spawn 失败时 child.pid 是 undefined，
  // 直接打印会得到 "undefined"，父侧 Number() 变 NaN，把环境错误误报成产品行为。
  const script = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    child.on('error', error => { console.error('SPAWN_FAILED ' + error.code); process.exit(2); });
    child.on('spawn', () => console.log(child.pid));
    setInterval(()=>{},1000);
  `;
  const host = spawnHost(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  host.stderr?.setEncoding('utf8');
  host.stderr?.on('data', chunk => { stderr += chunk; });
  host.on('error', error => { stderr += `\nHOST_ERROR ${error.message}`; });
  const diagnostics = () => `stderr=${JSON.stringify(stderr.trim())}`;
  let descendant;
  try {
    const line = await readPidLine(host, diagnostics);
    assert.match(line, /^\d+$/, `宿主输出的 pid 非法：line=${JSON.stringify(line)} ${diagnostics()}`);
    descendant = Number(line);
    assert.ok(descendant > 0);
    await stopHost(host);
    // 后代进程被杀后可能短暂处于僵尸态，signal 0 仍会成功；给回收留一个有界窗口。
    await until(() => {
      try { process.kill(descendant, 0); return false; }
      catch (error) {
        if (error.code !== 'ESRCH') throw new Error(`检查后代进程状态失败：${error.code}`, { cause: error });
        return true;
      }
    }, `宿主停止后后代进程 ${descendant} 仍存活（${diagnostics()}）`, 2000);
    await stopHost(host);
  } finally {
    await stopHost(host);
    if (descendant) { try { process.kill(descendant, 'SIGKILL'); } catch { /* 后代进程可能已自行退出 */ } }
  }
});
});

describe('host-lifecycle', () => {
test('installation plans choose supported native shells or fixed npm packages', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    for (const host of ['codex', 'dsh']) {
      const plan = installationPlan(host, platform, 'arm64');
      assert.equal(plan.command, 'npm');
      assert.ok(plan.args.includes('--engine-strict'));
      assert.equal(plan.args.at(-1), host === 'codex' ? '@openai/codex' : '@deepseek-ai/dsh');
    }
    const claude = installationPlan('claude', platform, 'x64');
    assert.equal(claude.command, platform === 'win32' ? 'powershell.exe' : 'bash');
    assert.match(claude.args.at(-1), /https:\/\/claude.ai\/install\.(ps1|sh)/);
  }
  assert.throws(() => installationPlan('codex', 'freebsd', 'x64'), /不支持/);
  assert.throws(() => installationPlan('codex', 'linux', 'ia32'), /不支持/);
});

test('missing, available and broken commands stay distinct, including custom commands', async () => {
  let selected;
  const lifecycle = createCliLifecycle('codex', '/custom/cli', value => { selected = value; }, {
    locate: () => '/custom/cli', run: async () => 'version',
  });
  assert.deepEqual(await lifecycle.checkStatus(), { status: 'available' });
  assert.equal(selected, '/custom/cli');
  const broken = createCliLifecycle('codex', 'codex', () => {}, {
    locate: () => '/broken', run: async () => { throw new Error('无法启动'); },
  });
  assert.deepEqual(await broken.checkStatus(), { status: 'error', reason: '无法启动' });
  await assert.rejects(broken.install(), /启动异常/);
  const missing = createCliLifecycle('codex', '/missing/custom', () => {}, { locate: () => null });
  assert.equal((await missing.checkStatus()).status, 'missing');
  await assert.rejects(missing.install(), /自定义命令/);
});

test('npm install is deduplicated and newly installed path is used without restarting', async () => {
  let installed = false, selected, installs = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const lifecycle = createCliLifecycle('dsh', 'dsh', value => { selected = value; }, {
    platform: 'linux', arch: 'x64',
    locate: command => command === 'npm' ? '/npm' : null,
    exists: () => installed,
    run: async (command, args) => {
      if (args[0] === 'prefix') return '/user-prefix';
      if (args[0] === 'install') {
        installs++;
        assert.equal((await lifecycle.checkStatus()).installation.phase, 'installing');
        await gate; installed = true; return '';
      }
      assert.equal(command, join('/user-prefix', 'bin', 'dsh'));
      return 'dsh version';
    },
  });
  assert.equal((await lifecycle.checkStatus()).status, 'missing');
  const first = lifecycle.install(), second = lifecycle.install();
  assert.equal(first, second);
  assert.equal((await lifecycle.checkStatus()).installing, true);
  release();
  assert.equal((await first).status, 'available');
  assert.equal(installs, 1);
  assert.equal(selected, join('/user-prefix', 'bin', 'dsh'));
  assert.equal((await lifecycle.checkStatus()).installation.phase, 'completed');
});

test('native install discovers the user binary even when PATH has not refreshed', async () => {
  let installed = false, selected;
  const lifecycle = createCliLifecycle('claude', 'claude', value => { selected = value; }, {
    platform: 'win32', arch: 'x64', home: '/user',
    locate: command => command === 'powershell.exe' ? '/powershell.exe' : null,
    exists: () => installed,
    run: async (command, args) => {
      if (command === '/powershell.exe') { assert.ok(args.includes('-NonInteractive')); installed = true; }
      return 'version';
    },
  });
  assert.equal((await lifecycle.install()).status, 'available');
  assert.match(selected, /claude.exe$/);
});

test('missing prerequisites and failed installs never report available', async () => {
  const absent = createCliLifecycle('dsh', 'dsh', () => {}, { locate: () => null });
  await assert.rejects(absent.install(), /需要 npm/);
  const failed = createCliLifecycle('dsh', 'dsh', () => {}, {
    locate: name => name === 'npm' ? '/npm' : null, exists: () => false,
    run: async (command, args) => {
      if (args[0] === 'prefix') return '/prefix';
      throw new Error('permission denied');
    },
  });
  await assert.rejects(failed.install(), /permission denied/);
  assert.deepEqual((await failed.checkStatus()).installation, { phase: 'failed', reason: 'permission denied' });
  assert.equal((await failed.checkStatus()).installing, undefined);
  assert.equal((await failed.checkStatus()).status, 'missing');
});

test('real process checks collect output and stop commands that time out', async () => {
  assert.equal(await runCommand(process.execPath, ['-e', 'console.log("version")']), 'version');
  await assert.rejects(runCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], 100), /超时/);
});
});

describe('host-probe', () => {
function fixture(t, source) {
  const directory = mkdtempSync(join(tmpdir(), 'probe space-'));
  const file = join(directory, 'fixture.mjs');
  writeFileSync(file, `#!/usr/bin/env node\n${source}`);
  chmodSync(file, 0o700);
  const command = process.platform === 'win32' ? join(directory, 'fixture.cmd') : file;
  if (process.platform === 'win32') writeFileSync(command, `@echo off\r\n"${process.execPath}" "%~dp0fixture.mjs" %*\r\n`);
  t.after(() => { try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ } });
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
  t.after(() => { try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ } });
  const pidFile = join(directory, 'pid');
  const source = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
  await assert.rejects(exchange(process.execPath, ['-e', source], { receive: JSON.parse, timeout: 1500 }), /超时/);
  assert.throws(() => process.kill(Number(readFileSync(pidFile)), 0), { code: 'ESRCH' });
  try { rmSync(pidFile, { force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
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
});
