// 桌面验证框架的过程测试:fake .app bundle + fake 引擎(node 子进程)。
// 覆盖:检测同步与指纹、重验证翻转、卸载语义、全有全无、额度确认门、超时与清理。
// 所有宿主进程一律 fake;真实 bundle 只在真宿主验收里探测。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../store.mjs';
import { DESKTOP_DEFINITIONS, detectDesktopApplications, desktopDetectionContext, verifyDesktopApplication } from '../../desktop/index.mjs';
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
