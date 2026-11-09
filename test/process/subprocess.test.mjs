import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { spawnHost, stopHost } from '../../src/hosts/subprocess.mjs';
import { until } from '../support/wait.mjs';

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
    rmSync(directory, { recursive: true, force: true });
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
