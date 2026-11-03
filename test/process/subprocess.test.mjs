import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawnHost, stopHost } from '../../src/hosts/subprocess.mjs';

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

test('stopping a host also terminates its child process', { timeout: 12000 }, async () => {
  const script = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(child.pid); setInterval(()=>{},1000);`;
  const child = spawnHost(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let descendant;
  try {
    const [data] = await once(child.stdout, 'data');
    descendant = Number(data.toString().trim());
    assert.ok(descendant > 0);
    await stopHost(child);
    assert.throws(() => process.kill(descendant, 0), { code: 'ESRCH' });
    await stopHost(child);
  } finally {
    await stopHost(child);
    if (descendant) { try { process.kill(descendant, 'SIGKILL'); } catch { /* 后代进程可能已自行退出 */ } }
  }
});
