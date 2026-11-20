// DSH 桌面验证的凭据契约:headless 禁用凭据服务,key 只能从启动环境注入。
// 回归 2026-11-20 真宿主验收:验证回合没注入 key → MISSING_CREDENTIAL → 可用应用被误判不可用。
// 断言经公共入口(dshDesktopVerification 的 verifyEngine/verifyController)与可观察的 spawn 参数;
// 子进程一律 fake,不消耗模型额度。
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../store.mjs';
import { dshDesktopVerification } from '../../desktop/dsh.mjs';

function tempDir(t, prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  return directory;
}

/** 假子进程:按 runDshHeadlessTurn 的用法发一行 stdout 后以 code 关闭。 */
function fakeChild(output, code = 0) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 424242;
  queueMicrotask(() => {
    if (output) child.stdout.emit('data', Buffer.from(output));
    child.emit('close', code);
  });
  return child;
}

function captureSpawn(output, code = 0) {
  const calls = [];
  const spawnTracked = (command, args, options) => {
    calls.push({ command, args, options });
    return fakeChild(output, code);
  };
  return { calls, spawnTracked };
}

function writeCredentials(t, text) {
  const path = join(tempDir(t, 'dsh-creds-'), '.credentials.yaml');
  writeFileSync(path, text, { mode: 0o600 });
  return path;
}

test('引擎验证回合把凭据文件里的 DEEPSEEK_API_KEY 注入子进程环境', async t => {
  const workspace = tempDir(t, 'dsh-verify-ws-');
  const credentialsPath = writeCredentials(t, 'DEEPSEEK_API_KEY: "test-key-from-file"\n');
  const { calls, spawnTracked } = captureSpawn('{"type":"final","reason":{"kind":"completed"},"text":"OK"}\n');

  const result = await dshDesktopVerification({ credentialsPath, baseEnv: {} }).verifyEngine({
    workspace,
    detection: { enginePath: '/fake/dsh' },
    spawnTracked,
    timeoutMs: 5000,
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.env.DEEPSEEK_API_KEY, 'test-key-from-file');
  assert.equal(calls[0].options.cwd, workspace, '验证回合仍应在私有工作区里跑');
});

test('启动环境已有 DEEPSEEK_API_KEY 时优先沿用,不被凭据文件覆盖', async t => {
  const workspace = tempDir(t, 'dsh-verify-ws-');
  const credentialsPath = writeCredentials(t, 'DEEPSEEK_API_KEY: "from-file"\n');
  const { calls, spawnTracked } = captureSpawn('{"type":"final","reason":{"kind":"completed"},"text":"OK"}\n');

  await dshDesktopVerification({ credentialsPath, baseEnv: { DEEPSEEK_API_KEY: 'from-env', PATH: '/bin' } }).verifyEngine({
    workspace,
    detection: { enginePath: '/fake/dsh' },
    spawnTracked,
    timeoutMs: 5000,
  });

  assert.equal(calls[0].options.env.DEEPSEEK_API_KEY, 'from-env');
});

test('凭据文件缺失时保持原环境,不注入空 key', async t => {
  const workspace = tempDir(t, 'dsh-verify-ws-');
  const credentialsPath = join(tempDir(t, 'dsh-creds-'), 'missing.yaml');
  const { calls, spawnTracked } = captureSpawn('{"type":"final","reason":{"kind":"completed"},"text":"OK"}\n');

  const result = await dshDesktopVerification({ credentialsPath, baseEnv: { PATH: '/bin' } }).verifyEngine({
    workspace,
    detection: { enginePath: '/fake/dsh' },
    spawnTracked,
    timeoutMs: 5000,
  });

  assert.equal(result.ok, true, 'fake 引擎不看凭据,回合本身仍完成');
  assert.equal(calls[0].options.env.DEEPSEEK_API_KEY, undefined);
  assert.equal(calls[0].options.env.PATH, '/bin');
});

test('主控验证回合同样注入凭据', async t => {
  const root = tempDir(t, 'dsh-verify-ctl-');
  const store = new Store(root);
  t.after(() => store.close());
  const workspace = tempDir(t, 'dsh-verify-ws-');
  const credentialsPath = writeCredentials(t, 'DEEPSEEK_API_KEY: "test-key-controller"\n');
  const { calls, spawnTracked } = captureSpawn('{"type":"text","text":"1"}\n');

  const result = await dshDesktopVerification({ credentialsPath, baseEnv: {} }).verifyController({
    store,
    workspace,
    detection: { enginePath: '/fake/dsh' },
    spawnTracked,
    socketPath: join(root, 'bus.sock'),
    timeoutMs: 5000,
  });

  assert.equal(result.ok, true);
  assert.equal(calls[0].options.env.DEEPSEEK_API_KEY, 'test-key-controller');
});
