// 桌面引擎成员宿主的注册通道契约:安装时把动态 spec 落到数据目录,服务启动时
// 与内置宿主合并;运行期安装/移除经热同步立即更新 bus.hosts 而不重启服务。
// 文件缺失/损坏不得影响既有启动路径。隐藏会话的隔离性由 spec 的
// CODEX_HOME 指向框架私有目录保证。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../store.mjs';
import { installCodexDesktopIntegration } from '../../desktop/codex.mjs';
import { detectDesktopApplications, installDesktopIntegration } from '../../desktop/index.mjs';
import { DESKTOP_HOSTS_FILE, readDesktopHostSpecs, removeDesktopHostSpec, writeDesktopHostSpec } from '../../desktop/member-hosts.mjs';
import { handleRpc, loadHosts } from '../../server.mjs';
import { fakeHost, serverScenario } from '../support/fixture.mjs';

function tempDir(t, prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => { try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ } });
  return directory;
}

test('安装 Codex 后注册桌面成员宿主,引擎走隔离 CODEX_HOME', async t => {
  const root = tempDir(t, 'desktop-member-');
  const store = new Store(join(root, 'store'));
  t.after(() => store.close());

  const result = await installCodexDesktopIntegration(store, {
    detections: [{ kind: 'codex', found: true, applicationId: 'app-1', enginePath: '/fake/codex', engineVersion: '1.0.0' }],
    codexHome: join(root, 'codex-home'),
    socketPath: join(root, 'bus.sock'),
  });

  assert.equal(result.memberHost, 'codex-desktop');
  const spec = readDesktopHostSpecs(store.directory)['codex-desktop'];
  assert.ok(spec, '成员宿主 spec 应已持久化');
  assert.equal(spec.adapter, 'codex');
  assert.equal(spec.command, '/fake/codex', '成员执行必须用桌面内嵌引擎');
  assert.equal(spec.env.CODEX_HOME, join(store.directory, 'desktop-engines', 'codex'), '必须指向框架私有目录');
  assert.equal(existsSync(spec.env.CODEX_HOME), true, '隔离 CODEX_HOME 必须真实存在,否则引擎直接退出');
});

test('服务启动时合并动态桌面宿主,且不影响内置宿主', async t => {
  const root = tempDir(t, 'desktop-member-');
  writeDesktopHostSpec(root, 'codex-desktop', { adapter: 'codex', command: '/fake/codex', env: { CODEX_HOME: join(root, 'engines') } });

  const hosts = await loadHosts({ directory: root, socketPath: join(root, 'bus.sock') });
  assert.equal(hosts.has('codex-desktop'), true);
  assert.equal(hosts.has('codex'), true, '内置 codex 宿主仍在');
  assert.equal(hosts.has('claude'), true);

  const empty = tempDir(t, 'desktop-member-');
  const base = await loadHosts({ directory: empty, socketPath: join(empty, 'bus.sock') });
  assert.equal(base.has('codex-desktop'), false, '未接入时不应出现动态宿主');
});

test('动态宿主文件损坏时按空表处理,不阻塞启动', async t => {
  const root = tempDir(t, 'desktop-member-');
  writeFileSync(join(root, DESKTOP_HOSTS_FILE), '{ not json');

  assert.deepEqual(readDesktopHostSpecs(root), {});
  const hosts = await loadHosts({ directory: root, socketPath: join(root, 'bus.sock') });
  assert.equal(hosts.has('codex-desktop'), false);
  assert.equal(hosts.has('codex'), true);
});

test('移除动态宿主是幂等空操作', async t => {
  const root = tempDir(t, 'desktop-member-');
  writeDesktopHostSpec(root, 'codex-desktop', { adapter: 'codex' });
  removeDesktopHostSpec(root, 'codex-desktop');
  assert.deepEqual(readDesktopHostSpecs(root), {});
  assert.deepEqual(removeDesktopHostSpec(root, 'missing'), {}, '不存在的宿主不应报错');
});

// --- 运行期热同步:安装/移除后 bus.hosts 立即可派单,无需重启服务 ----------------

// 用临时假 bundle 走真实检测入口:既注册桌面应用行(移除的前置事实),
// 又产出安装所需的 detections,三平台结果一致。
async function detectFakeZcode(store, root) {
  const bundlePath = join(root, 'ZCode.app');
  const enginePath = join(bundlePath, 'Contents', 'Resources', 'glm', 'zcode.cjs');
  mkdirSync(join(bundlePath, 'Contents', 'Resources', 'glm'), { recursive: true });
  writeFileSync(enginePath, '');
  const definitions = new Map([['zcode', {
    label: 'ZCode',
    bundleCandidates: ({ applicationsRoot }) => [join(applicationsRoot, 'ZCode.app')],
    engineCandidates: () => [{ path: enginePath, version: '1.0.0' }],
  }]]);
  return detectDesktopApplications(store, {
    definitions,
    context: { platform: 'darwin', applicationsRoot: root, supportRoot: root },
    readBundleVersion: async () => '1.0.0',
  });
}

async function installRuntimeZcode(server, root) {
  const detections = await detectFakeZcode(server.bus.store, root);
  return installDesktopIntegration(server.bus.store, 'zcode', {
    detections,
    socketPath: server.socketPath,
    zcodeHome: join(root, 'zcode-home'),
  });
}

test('统一安装入口按 kind 分发四家桌面集成,未知类型标记 400', async t => {
  const { bus, directory } = await serverScenario(t, {});
  await assert.rejects(installDesktopIntegration(bus.store, 'wechat', { detections: [] }), error => {
    assert.equal(error.message, '暂不支持安装桌面集成: wechat');
    assert.equal(error.status, 400);
    return true;
  });
  for (const kind of ['codex', 'dsh', 'claude', 'zcode']) {
    await assert.rejects(
      installDesktopIntegration(bus.store, kind, { detections: [], socketPath: join(directory, 'bus.sock') }),
      /未检测到/,
      `${kind} 必须已接入真实安装函数`,
    );
  }
});

test('运行期安装桌面集成后热同步成员宿主,注入宿主不被接管', async t => {
  const injected = fakeHost();
  const { server, bus, directory } = await serverScenario(t, { hosts: new Map([['injected', injected]]) });
  assert.equal(bus.hosts.has('zcode-desktop'), false, '未安装时不应出现动态宿主');

  const result = await installRuntimeZcode(server, directory);
  assert.equal(result.memberHost, 'zcode-desktop');
  assert.equal(bus.hosts.has('zcode-desktop'), false, '安装只落盘 spec,宿主由热同步注册');

  await bus.syncDesktopHosts();
  assert.equal(bus.hosts.has('zcode-desktop'), true, '运行期同步后成员宿主应可派单,无需重启');
  assert.equal(bus.hosts.get('injected'), injected, '调用方注入的宿主不得被替换');
});

test('动态宿主 spec 更新或 RPC 移除经热同步替换并关闭旧实例', async t => {
  const injected = fakeHost();
  const { server, bus, directory } = await serverScenario(t, { hosts: new Map([['injected', injected]]) });
  await installRuntimeZcode(server, directory);
  await bus.syncDesktopHosts();
  const first = bus.hosts.get('zcode-desktop');
  let firstClosed = false;
  const firstClose = first.close;
  first.close = async () => { firstClosed = true; await firstClose?.call(first); };

  writeDesktopHostSpec(directory, 'zcode-desktop', { adapter: 'zcode', command: join('/fake/ZCode2.app', 'Contents', 'MacOS', 'ZCode') });
  await bus.syncDesktopHosts();
  const second = bus.hosts.get('zcode-desktop');
  assert.notEqual(second, first, 'spec 更新应实例化新宿主');
  assert.equal(firstClosed, true, '旧宿主必须关闭');
  assert.equal(bus.hosts.get('injected'), injected, '注入宿主在更新时保留');

  let secondClosed = false;
  const secondClose = second.close;
  second.close = async () => { secondClosed = true; await secondClose?.call(second); };
  await handleRpc(bus, { op: 'desktop_remove', kind: 'zcode' });
  assert.equal(bus.hosts.has('zcode-desktop'), false, 'RPC 移除后动态宿主立即摘除');
  assert.equal(secondClosed, true, 'RPC 移除必须关闭宿主');
  assert.equal(bus.hosts.get('injected'), injected, '注入宿主在移除时保留');
});

test('HTTP 移除桌面应用后热同步关闭并摘除动态宿主', async t => {
  const injected = fakeHost();
  const { server, bus, directory, url } = await serverScenario(t, { hosts: new Map([['injected', injected]]) });
  await installRuntimeZcode(server, directory);
  await bus.syncDesktopHosts();
  const host = bus.hosts.get('zcode-desktop');
  let closed = false;
  const originalClose = host.close;
  host.close = async () => { closed = true; await originalClose?.call(host); };

  const response = await fetch(new URL('/api/desktop/remove', url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: url.slice(0, -1) },
    body: JSON.stringify({ kind: 'zcode' }),
  });
  assert.equal(response.status, 200);
  assert.equal(bus.hosts.has('zcode-desktop'), false, 'HTTP 移除后动态宿主立即摘除');
  assert.equal(closed, true, 'HTTP 移除必须关闭宿主');
  assert.equal(bus.hosts.get('injected'), injected, '注入宿主在 HTTP 移除时保留');
});
