import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createCliLifecycle, installationPlan, runCommand } from '../../hosts/lifecycle.mjs';

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
