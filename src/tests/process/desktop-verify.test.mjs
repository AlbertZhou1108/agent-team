// 桌面验证框架的过程测试:fake .app bundle + fake 引擎(node 子进程)。
// 覆盖:检测同步与指纹、重验证翻转、卸载语义、全有全无、额度确认门、超时与清理。
// 所有宿主进程一律 fake;真实 bundle 只在真宿主验收里探测。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../store.mjs';
import { DESKTOP_DEFINITIONS, detectDesktopApplications, desktopDetectionContext, verifyDesktopApplication, zcodeDesktopVerification } from '../../desktop/index.mjs';
import * as externalAgg from '../../aggregates/external-control.mjs';

function tempDir(t, prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => { try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ } });
  return directory;
}

/**
 * 一棵 fake bundle 树:<root>/FakeChat.app/Contents/{Info.plist,MacOS/FakeChat} + fake 引擎脚本。
 * 引擎是 node 脚本,经 process.execPath 启动,三平台中性;bundle 版本经注入的
 * readBundleVersion 提供,不依赖 plutil;引擎版本探测会执行 bundle 内的 stub(无输出,得 null)。
 */
function fakeBundle(t) {
  const root = tempDir(t, 'desktop-detect-');
  const supportRoot = join(root, 'support');
  mkdirSync(join(root, 'FakeChat.app', 'Contents', 'MacOS'), { recursive: true });
  mkdirSync(supportRoot, { recursive: true });
  writeFileSync(join(root, 'FakeChat.app', 'Contents', 'Info.plist'), '<plist><dict/></plist>');
  writeFileSync(join(root, 'FakeChat.app', 'Contents', 'MacOS', 'FakeChat'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const engineScript = join(root, 'fake-engine.mjs');
  writeFileSync(engineScript, `import { writeFileSync } from 'node:fs';
const [mode, marker, payload] = process.argv.slice(2);
if (mode === 'ok') { writeFileSync(marker, payload ?? 'done'); console.log('fake engine ok'); process.exit(0); }
if (mode === 'fail') { console.error('engine broken'); process.exit(3); }
if (mode === 'hang') { writeFileSync(marker, 'started'); setTimeout(() => process.exit(0), 30000); }
else process.exit(9);
`);
  return { root, supportRoot, engineScript };
}

function fakeDefinitions() {
  return new Map([
    ['codex', {
      label: 'Codex',
      bundleCandidates: ({ applicationsRoot }) => [join(applicationsRoot, 'FakeChat.app')],
      engineCandidates: ({ bundlePath }) => [{ path: join(bundlePath, 'Contents', 'MacOS', 'FakeChat') }],
      async verifyController({ workspace }) {
        writeFileSync(join(workspace, 'controller-check.txt'), 'ok');
        return { ok: true, detail: 'control_protocol 可调用', wake: { available: false } };
      },
    }],
  ]);
}

function detectOptions({ root, supportRoot }) {
  return {
    context: desktopDetectionContext({ platform: 'darwin', applicationsRoot: root, supportRoot }),
    readBundleVersion: async () => '26.1111.71704',
  };
}

test('detection registers a fake bundle with fingerprint and keeps it stable across rescans', async t => {
  const bundle = fakeBundle(t);
  const store = new Store(tempDir(t, 'desktop-store-'));
  const results = await detectDesktopApplications(store, {
    definitions: fakeDefinitions(),
    ...detectOptions(bundle),
  });
  const codex = results.find(item => item.kind === 'codex');
  assert.equal(codex.found, true);
  assert.equal(codex.bundlePath, join(bundle.root, 'FakeChat.app'));
  assert.equal(codex.bundleVersion, '26.1111.71704');
  assert.equal(codex.enginePath, join(bundle.root, 'FakeChat.app', 'Contents', 'MacOS', 'FakeChat'));
  const row = externalAgg.applicationForKind(store, 'codex');
  assert.equal(row.install_path, codex.bundlePath);
  assert.equal(row.bundle_version, '26.1111.71704');
  assert.equal(row.readiness, 'unavailable');
  assert.equal(row.fingerprint, codex.fingerprint);

  // 重复检测幂等:同一行,指纹不变,结论不翻。
  const again = await detectDesktopApplications(store, {
    definitions: fakeDefinitions(),
    ...detectOptions(bundle),
  });
  assert.equal(externalAgg.applicationForKind(store, 'codex').id, row.id);
  assert.equal(again.find(item => item.kind === 'codex').fingerprint, codex.fingerprint);
  assert.equal(externalAgg.applicationForKind(store, 'codex').readiness, 'unavailable');
  store.close();
});

test('an available application flips to unavailable when the installation fingerprint changes', async t => {
  const bundle = fakeBundle(t);
  const store = new Store(tempDir(t, 'desktop-store-'));
  const options = { definitions: fakeDefinitions(), ...detectOptions(bundle) };
  await detectDesktopApplications(store, options);
  const row = externalAgg.applicationForKind(store, 'codex');
  externalAgg.setApplicationVerification(store, row.id, {
    readiness: 'available',
    diagnostics: { summary: '主控与引擎检查均通过' },
    fingerprint: row.fingerprint,
    verifiedAt: new Date().toISOString(),
  });

  // bundle 版本变化 → 指纹变化 → 重验证。
  const changed = await detectDesktopApplications(store, {
    definitions: fakeDefinitions(),
    context: detectOptions(bundle).context,
    readBundleVersion: async () => '27.0000.00000',
  });
  const flipped = externalAgg.application(store, row.id);
  assert.equal(flipped.readiness, 'unavailable');
  assert.match(JSON.parse(flipped.diagnostics).summary, /指纹已变化/);
  assert.equal(changed.find(item => item.kind === 'codex').revalidated, true);
  store.close();
});

test('a missing engine or an uninstalled application stops new work but keeps records', async t => {
  const bundle = fakeBundle(t);
  const store = new Store(tempDir(t, 'desktop-store-'));
  const base = fakeDefinitions().get('codex');
  const options = { definitions: fakeDefinitions(), ...detectOptions(bundle) };
  await detectDesktopApplications(store, options);
  const row = externalAgg.applicationForKind(store, 'codex');
  externalAgg.setApplicationVerification(store, row.id, { readiness: 'available', fingerprint: row.fingerprint, verifiedAt: new Date().toISOString() });

  // 引擎消失:行保留,available → unavailable。
  await detectDesktopApplications(store, {
    definitions: new Map([['codex', { ...base, engineCandidates: () => [] }]]),
    ...detectOptions(bundle),
  });
  assert.equal(externalAgg.application(store, row.id).readiness, 'unavailable');
  assert.match(JSON.parse(externalAgg.application(store, row.id).diagnostics).summary, /引擎不再存在/);

  // 整个应用卸载:行保留,当前原因更新为「未检测到」。
  await detectDesktopApplications(store, {
    definitions: new Map([['codex', { ...base, bundleCandidates: () => [] }]]),
    ...detectOptions(bundle),
  });
  const after = externalAgg.application(store, row.id);
  assert.ok(after, '卸载后注册行必须保留');
  assert.equal(after.readiness, 'unavailable');
  assert.match(JSON.parse(after.diagnostics).summary, /未检测到/);
  store.close();
});

test('verification runs both checks, is all-or-nothing, and cleans the private workspace', async t => {
  const bundle = fakeBundle(t);
  const store = new Store(tempDir(t, 'desktop-store-'));
  const detectOpts = detectOptions(bundle);
  const definitions = fakeDefinitions();
  await detectDesktopApplications(store, { definitions, ...detectOpts });
  const definition = definitions.get('codex');

  definition.verifyEngine = async ({ workspace, spawnTracked }) => {
    const marker = join(workspace, 'engine-marker.txt');
    await new Promise((resolve, reject) => {
      const child = spawnTracked(process.execPath, [bundle.engineScript, 'ok', marker, 'engine-ok']);
      child.on('close', code => (code === 0 ? resolve() : reject(new Error(`引擎退出 (${code})`))));
      child.on('error', reject);
    });
    return { ok: true, detail: '引擎完成短任务' };
  };

  // 额度确认门:未确认不执行检查,结论不变。
  const gated = await verifyDesktopApplication(store, 'codex', { ...detectOpts, definitions, confirmed: false });
  assert.equal(gated.needsConfirmation, true);
  assert.match(gated.cost, /模型额度/);
  assert.equal(externalAgg.applicationForKind(store, 'codex').readiness, 'unavailable');

  // 确认后:两项检查通过 → available;wake 不可用 → pull-only。
  const result = await verifyDesktopApplication(store, 'codex', { ...detectOpts, definitions, confirmed: true });
  assert.equal(result.verified, true);
  const row = externalAgg.applicationForKind(store, 'codex');
  assert.equal(row.readiness, 'available');
  assert.equal(row.pull_only, 1);
  assert.equal(row.verified_at !== null, true);
  // 临时工作区(含引擎产物)已清理。
  assert.equal(existsSync(join(store.directory, 'desktop-verify')), false, 'desktop-verify 目录应已清空');

  // 全有全无:引擎失败 → unavailable,两项诊断都保留。
  definition.verifyEngine = async ({ workspace, spawnTracked }) => {
    await new Promise((resolve, reject) => {
      const child = spawnTracked(process.execPath, [bundle.engineScript, 'fail', join(workspace, 'unused.txt')]);
      child.on('close', code => reject(new Error(`引擎退出 (${code})`)));
      child.on('error', reject);
    });
    return { ok: true };
  };
  const failed = await verifyDesktopApplication(store, 'codex', { ...detectOpts, definitions, confirmed: true });
  assert.equal(failed.verified, false);
  const failedRow = externalAgg.applicationForKind(store, 'codex');
  assert.equal(failedRow.readiness, 'unavailable');
  const diagnostics = JSON.parse(failedRow.diagnostics);
  assert.equal(diagnostics.controller.ok, true);
  assert.equal(diagnostics.engine.ok, false);
  assert.equal(existsSync(join(store.directory, 'desktop-verify')), false);
  store.close();
});

test('a hung engine check times out, is killed, and the private workspace is removed', async t => {
  const bundle = fakeBundle(t);
  const store = new Store(tempDir(t, 'desktop-store-'));
  await detectDesktopApplications(store, { definitions: fakeDefinitions(), ...detectOptions(bundle) });
  const definitions = fakeDefinitions();
  definitions.get('codex').verifyEngine = async ({ workspace, spawnTracked }) => {
    const marker = join(workspace, 'engine-marker.txt');
    await new Promise(resolve => {
      const child = spawnTracked(process.execPath, [bundle.engineScript, 'hang', marker]);
      child.on('close', () => resolve());
      child.on('error', resolve);
    });
    return { ok: true };
  };
  const result = await verifyDesktopApplication(store, 'codex', {
    definitions,
    ...detectOptions(bundle),
    confirmed: true,
    timeoutMs: 500,
  });
  assert.equal(result.verified, false);
  const row = externalAgg.applicationForKind(store, 'codex');
  assert.equal(row.readiness, 'unavailable');
  assert.equal(JSON.parse(row.diagnostics).timedOut, true);
  assert.equal(existsSync(join(store.directory, 'desktop-verify')), false);
  store.close();
});

test('a disabled application refuses verification until explicitly enabled again', async t => {
  const bundle = fakeBundle(t);
  const store = new Store(tempDir(t, 'desktop-store-'));
  await detectDesktopApplications(store, { definitions: fakeDefinitions(), ...detectOptions(bundle) });
  const row = externalAgg.applicationForKind(store, 'codex');
  externalAgg.setApplicationDisabled(store, row.id, { reason: '测试停用' });

  const refused = await verifyDesktopApplication(store, 'codex', {
    definitions: fakeDefinitions(),
    ...detectOptions(bundle),
    confirmed: true,
  });
  assert.equal(refused.refused, true);
  assert.match(refused.reason, /停用/);
  assert.equal(externalAgg.application(store, row.id).readiness, 'unavailable');

  externalAgg.clearApplicationDisabled(store, row.id);
  assert.equal(externalAgg.application(store, row.id).verified_at, null);
  store.close();
});

test('the real desktop definitions carry top-level verification strategies for every kind', () => {
  // 回归:验证执行器读定义表顶层的 verifyController/verifyEngine;挂载点一旦
  // 断掉,面板的「验证」会退化成「验证策略尚未提供」而不是真实检查。
  for (const [kind, definition] of DESKTOP_DEFINITIONS) {
    assert.equal(typeof definition.verifyController, 'function', `${kind} 缺少 verifyController`);
    assert.equal(typeof definition.verifyEngine, 'function', `${kind} 缺少 verifyEngine`);
  }
});

// --- ZCode Desktop:fake app-server 走真实验证策略代码路径 --------------------

/**
 * fake ZCode app-server(node 子进程,三平台中性):完成启动握手 → session/create
 * 时把隔离 HOME 的 config.json 拷进 marker(断言 MCP 条目确实落进引擎可见的
 * 隔离配置)→ 应答授信协商 → session/send 后发 turn.started/turn.completed。
 * behavior=exit 在 send 后退出进程(报真实退出原因);hang 永不完成(超时路径)。
 */
function fakeZcodeServerScript() {
  return `import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [, , markerPath, responseText, behavior] = process.argv;
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
// app-server 是握手主动方:先发 storagePath 请求,客户端应答 storagePathReady
// 后补发 storageState 通知,客户端才视为就绪(与真实 app-server 行为一致)。
send({ method: 'startup/storagePath', params: { path: '/tmp/fake-zcode-stub.sqlite' } });
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (row.method === 'startup/storagePathReady') {
      send({ method: 'startup/storageState', params: { sequence: 1 } });
      continue;
    }
    if (row.id == null || row.method == null) continue;
    switch (row.method) {
      case 'session/create': {
        try { writeFileSync(markerPath, readFileSync(join(process.env.HOME, '.zcode', 'cli', 'config.json'), 'utf8')); }
        catch (error) { writeFileSync(markerPath, 'read-failed: ' + error.message); }
        send({ id: row.id, result: { session: { sessionId: 'verify-session' } } });
        break;
      }
      case 'mcp/list':
        send({ id: row.id, result: { statuses: { agent_team: { workspaceTrust: { declarationDigest: 'digest-1' } } } } });
        break;
      case 'workspace/mcp/trust':
        send({ id: row.id, result: { accepted: true } });
        break;
      case 'session/send': {
        send({ id: row.id, result: { accepted: true } });
        if (behavior === 'exit') process.exit(3);
        if (behavior === 'hang') break;
        send({ method: 'session/event', params: { sessionId: 'verify-session', type: 'turn.started', turnId: 't1' } });
        send({ method: 'session/event', params: { sessionId: 'verify-session', type: 'turn.completed', payload: { response: responseText } } });
        break;
      }
      default:
        send({ id: row.id, result: {} });
    }
  }
});
`;
}

function zcodeBundle(t) {
  const root = tempDir(t, 'desktop-zcode-');
  mkdirSync(join(root, 'FakeZcode.app', 'Contents', 'MacOS'), { recursive: true });
  mkdirSync(join(root, 'FakeZcode.app', 'Contents', 'Resources', 'glm'), { recursive: true });
  writeFileSync(join(root, 'FakeZcode.app', 'Contents', 'Info.plist'), '<plist><dict/></plist>');
  writeFileSync(join(root, 'FakeZcode.app', 'Contents', 'MacOS', 'ZCode'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(root, 'FakeZcode.app', 'Contents', 'Resources', 'glm', 'zcode.cjs'), '// fake 引擎占位:引擎路径只参与 existsSync 探测\n');
  const serverScript = join(root, 'fake-app-server.mjs');
  writeFileSync(serverScript, fakeZcodeServerScript());
  return { root, serverScript };
}

function zcodeDefinitions({ root, serverScript }, { response = 'OK: control_protocol version 1', behavior = null, verifyController, verifyEngine } = {}) {
  // 每次检查(先主控后引擎)各产生一份 captured-N.json:fake app-server 把
  // 引擎侧 HOME 的 config.json 拷到 marker,证明隔离配置确实被引擎读到。
  // marker 放在 bundle 临时根目录,避开验证编排器会清理的 workspace。
  let callIndex = 0;
  const real = zcodeDesktopVerification({
    resolveLaunch: () => {
      callIndex += 1;
      return {
        command: process.execPath,
        args: [serverScript, join(root, `captured-${callIndex}.json`), response, behavior],
        env: {},
      };
    },
  });
  return new Map([['zcode', {
    label: 'ZCode',
    bundleCandidates: ({ applicationsRoot }) => [join(applicationsRoot, 'FakeZcode.app')],
    engineCandidates: ({ bundlePath }) => [{ path: join(bundlePath, 'Contents', 'Resources', 'glm', 'zcode.cjs') }],
    engineVersionArgs: null,
    verifyController: verifyController ?? real.verifyController,
    verifyEngine: verifyEngine ?? real.verifyEngine,
  }]]);
}

test('zcode verification: isolated home carries the MCP entry and both checks pass (not pull-only)', async t => {
  const bundle = zcodeBundle(t);
  const store = new Store(tempDir(t, 'desktop-store-'));
  const detectOpts = detectOptions(bundle);
  const definitions = zcodeDefinitions(bundle);
  await detectDesktopApplications(store, { definitions, ...detectOpts });
  const socketPath = join(store.directory, 'bus.sock');

  const result = await verifyDesktopApplication(store, 'zcode', { ...detectOpts, definitions, confirmed: true, socketPath });
  assert.equal(result.verified, true);
  const row = externalAgg.applicationForKind(store, 'zcode');
  assert.equal(row.readiness, 'available', 'zcode 唤醒驱动可用,不是 pull-only');
  assert.equal(row.pull_only, 0);
  assert.equal(JSON.parse(row.diagnostics).controller.ok, true);
  assert.equal(JSON.parse(row.diagnostics).engine.ok, true);

  // 主控检查的隔离 HOME:agent_team 条目带着总线 socket 与激活凭据。
  const controllerConfig = JSON.parse(readFileSync(join(bundle.root, 'captured-1.json'), 'utf8'));
  const entry = controllerConfig.mcp.servers.agent_team;
  assert.ok(entry.env.AGENT_TEAM_CLIENT_KEY, '一次性验证连接的凭据必须写进引擎可见的隔离配置');
  assert.ok(entry.args.includes('--socket'));
  assert.ok(entry.args.includes(socketPath));
  // 引擎检查跑空配置,不残留 MCP 条目。
  const engineConfig = JSON.parse(readFileSync(join(bundle.root, 'captured-2.json'), 'utf8'));
  assert.equal(engineConfig.mcp, undefined);
  assert.equal(existsSync(join(store.directory, 'desktop-verify')), false, 'workspace 统一清理');
  store.close();
});

test('zcode verification: a wrong reply fails the controller check with an honest reason', async t => {
  const bundle = zcodeBundle(t);
  const store = new Store(tempDir(t, 'desktop-store-'));
  const detectOpts = detectOptions(bundle);
  const definitions = zcodeDefinitions(bundle, { response: '没有调用任何工具' });
  await detectDesktopApplications(store, { definitions, ...detectOpts });

  const result = await verifyDesktopApplication(store, 'zcode', {
    ...detectOpts, definitions, confirmed: true, socketPath: join(store.directory, 'bus.sock'),
  });
  assert.equal(result.verified, false);
  const diagnostics = JSON.parse(externalAgg.applicationForKind(store, 'zcode').diagnostics);
  assert.equal(diagnostics.controller.ok, false);
  assert.match(diagnostics.controller.detail, /版本/, '失败结论必须如实说没确认到版本');
  store.close();
});

test('zcode verification: engine exiting mid-turn surfaces the real exit reason', async t => {
  const bundle = zcodeBundle(t);
  const store = new Store(tempDir(t, 'desktop-store-'));
  const detectOpts = detectOptions(bundle);
  const definitions = zcodeDefinitions(bundle, { behavior: 'exit', verifyController: async () => ({ ok: true, detail: '占位通过' }) });
  await detectDesktopApplications(store, { definitions, ...detectOpts });

  const result = await verifyDesktopApplication(store, 'zcode', {
    ...detectOpts, definitions, confirmed: true, socketPath: join(store.directory, 'bus.sock'),
  });
  assert.equal(result.verified, false);
  const diagnostics = JSON.parse(externalAgg.applicationForKind(store, 'zcode').diagnostics);
  assert.equal(diagnostics.engine.ok, false);
  assert.match(diagnostics.engine.reason, /内嵌引擎提前退出|验证回合超时/);
  assert.equal(existsSync(join(store.directory, 'desktop-verify')), false, 'workspace 统一清理');
  store.close();
});

