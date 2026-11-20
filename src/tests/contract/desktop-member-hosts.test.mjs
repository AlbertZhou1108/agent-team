// 桌面引擎成员宿主的注册通道契约:安装时把动态 spec 落到数据目录,服务启动时
// 与内置宿主合并;文件缺失/损坏不得影响既有启动路径。隐藏会话的隔离性由
// spec 的 CODEX_HOME 指向框架私有目录保证。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../store.mjs';
import { installCodexDesktopIntegration } from '../../desktop/codex.mjs';
import { DESKTOP_HOSTS_FILE, readDesktopHostSpecs, removeDesktopHostSpec, writeDesktopHostSpec } from '../../desktop/member-hosts.mjs';
import { loadHosts } from '../../server.mjs';

function tempDir(t, prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
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
