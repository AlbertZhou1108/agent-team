// Codex Desktop 接入安装的内部表示:受管 TOML 块、备份、激活连接与唤醒凭据归属。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../store.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { installCodexDesktopIntegration, applyManagedBlock, codexDesktopMcpBlock, extractCodexProviderConfig, codexDesktopVerification, BLOCK_BEGIN, BLOCK_END } from '../../desktop/codex.mjs';
import { createExternalIdentity, ControlPlane } from '../../control-plane.mjs';

const NOW = '2026-11-20T00:00:00.000Z';

function tempDir(t, prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => { try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ } });
  return directory;
}

function fakeDetections(bundlePath) {
  return [{
    kind: 'codex',
    found: true,
    bundlePath,
    bundleVersion: '26.1111.71704',
    enginePath: join(bundlePath, 'engine'),
    engineVersion: '0.169.1',
    applicationId: 'app-fake-codex',
    fingerprint: 'fp-fake',
  }];
}

test('managed TOML block appends, replaces idempotently, and refuses an incomplete block', () => {
  assert.equal(applyManagedBlock('', 'BLOCK\n'), 'BLOCK\n');
  const managedBlock = `${BLOCK_BEGIN}\n[mcp_servers.agent_team]\ncommand = 'x'\n${BLOCK_END}`;
  const withExisting = `model = "gpt-5"\n\n${BLOCK_BEGIN}\nOLD\n${BLOCK_END}\n`;
  const replaced = applyManagedBlock(withExisting, managedBlock);
  assert.ok(replaced.includes('[mcp_servers.agent_team]'));
  assert.ok(!replaced.includes('OLD'));
  assert.ok(replaced.startsWith('model = "gpt-5"'));
  // 幂等:重复替换不累积块。
  const twice = applyManagedBlock(replaced, managedBlock);
  assert.equal(twice.split(BLOCK_BEGIN).length - 1, 1);
  assert.throws(() => applyManagedBlock(`${BLOCK_BEGIN}\nno end`, 'X'), /不完整的 agent-team 受管块/);
});

test('TOML literals escape single quotes so Windows-style paths survive', () => {
  const block = codexDesktopMcpBlock({ socketPath: '/tmp/bus.sock', bindingId: 'b1', clientKey: 'k1' });
  assert.match(block, /\[mcp_servers\.agent_team\]/);
  assert.match(block, /AGENT_TEAM_CLIENT_KEY/);
  assert.equal(applyManagedBlock('x = 1\n', codexDesktopMcpBlock({
    socketPath: 'C:\\pipe\\bus',
    bindingId: 'b\\1',
    clientKey: "k'1",
  })).includes(`'C:\\pipe\\bus'`), true);
});

test('install registers an activation binding and writes a managed entry with one backup', async t => {
  const store = new Store(tempDir(t, 'desktop-install-'));
  const codexHome = tempDir(t, 'desktop-codex-home-');
  const detections = fakeDetections('/Applications/ChatGPT.app');

  const result = await installCodexDesktopIntegration(store, {
    detections,
    codexHome,
    socketPath: '/tmp/bus.sock',
    now: NOW,
  });
  assert.equal(result.binding.bindingKind, 'activation');
  assert.equal(result.configPath, join(codexHome, 'config.toml'));
  // key 只进宿主配置,不出现在返回值。
  assert.equal(JSON.stringify(result).includes('AGENT_TEAM_CLIENT_KEY'), false);
  const config = readFileSync(result.configPath, 'utf8');
  assert.ok(config.includes('AGENT_TEAM_CLIENT_KEY'), '宿主配置必须携带凭据');
  assert.ok(config.includes(BLOCK_BEGIN) && config.includes(BLOCK_END));
  assert.equal(config.split(BLOCK_BEGIN).length - 1, 1);
  // 备份:首次安装前不存在配置,无备份;哈希留痕。
  assert.equal(result.backupPath, null);

  // 预置一份配置再装:产生备份且哈希对应旧内容。
  const second = await installCodexDesktopIntegration(store, {
    detections,
    codexHome,
    socketPath: '/tmp/bus.sock',
    now: '2026-11-20T01:00:00.000Z',
  });
  assert.ok(second.backupPath);
  assert.ok(second.backupHash);
  const updated = readFileSync(result.configPath, 'utf8');
  assert.equal(updated.split(BLOCK_BEGIN).length - 1, 1, '重复安装只保留一个受管块');

  // 手写的同一条目拒绝安装,保护用户配置。
  const conflictingHome = tempDir(t, 'desktop-codex-home2-');
  mkdirSync(conflictingHome, { recursive: true });
  writeFileSync(join(conflictingHome, 'config.toml'), '[mcp_servers.agent_team]\ncommand = "x"\n');
  await assert.rejects(
    () => installCodexDesktopIntegration(store, { detections, codexHome: conflictingHome, socketPath: '/tmp/bus.sock' }),
    /非受管的 \[mcp_servers\.agent_team\]/,
  );
  assert.equal(existsSync(join(conflictingHome, 'config.toml')), true);
  store.close();
});

test('a conversation binding woken from the desktop config carries the activation credential', t => {
  const store = new Store(tempDir(t, 'desktop-wakecfg-'));
  // 模拟安装:激活连接。
  const activation = createExternalIdentity(store, {
    principalName: '本机用户',
    bindingName: 'Codex Desktop 接入',
    host: 'codex',
    declared: {
      capabilities: ['session.deliver', 'turn.observe', 'session.wake'],
      workspaceRoots: ['/tmp'],
      policies: ['read-only'],
    },
    surface: 'desktop',
    bindingKind: 'activation',
  });
  // 控制面按线程解析出会话连接;唤醒配置随会话连接落库。
  const plane = Object.create(ControlPlane.prototype);
  plane.bus = { store };
  const activationRow = store.get('SELECT * FROM external_client_bindings WHERE id=?', activation.binding.id);
  const resolved = plane.resolveActivationBinding(activationRow, 'thread-xyz');

  // 会话连接的身份与归属。
  assert.equal(resolved.binding_kind, 'conversation');
  assert.equal(resolved.session, 'thread-xyz');
  assert.equal(resolved.principal_id, activation.principal.id);
  assert.equal(resolved.app_id, activation.binding.app_id);
  // 同一线程再解析得到同一行。
  const again = plane.resolveActivationBinding(activationRow, 'thread-xyz');
  assert.equal(again.id, resolved.id);
  // 另一个线程得到独立连接;激活连接永不变成会话。
  const other = plane.resolveActivationBinding(activationRow, 'thread-other');
  assert.notEqual(other.id, resolved.id);
  // 无线程身份的调用回落到最近绑定的会话连接(thread-other 后绑定,updated 更晚)。
  const fallback = plane.resolveActivationBinding(activationRow, null);
  assert.equal(fallback.id, other.id);
  store.close();
});

test('extractCodexProviderConfig preserves custom model providers, resolves relative catalog, and strips user MCP/plugins', async t => {
  const sourceHome = tempDir(t, 'codex-provider-src-');
  const raw = [
    'model_provider = "custom"',
    'model = "deepseek-flash"',
    'model_catalog_json = "cc-switch-model-catalog.json"',
    '',
    '[model_providers.custom]',
    'base_url = "http://127.0.0.1:15721/v1"',
    'wire_api = "responses"',
    '',
    '[mcp_servers.private_tool]',
    'command = "secret"',
    '',
    '[plugins."foo@bar"]',
    'enabled = true',
    '',
    '[windows]',
    'sandbox = "elevated"',
  ].join('\n');
  const extracted = extractCodexProviderConfig(raw, sourceHome);
  assert.ok(extracted.includes('model_provider = "custom"'));
  assert.ok(extracted.includes('model = "deepseek-flash"'));
  assert.ok(extracted.includes(join(sourceHome, 'cc-switch-model-catalog.json')));
  assert.ok(extracted.includes('[model_providers.custom]'));
  assert.ok(extracted.includes('base_url = "http://127.0.0.1:15721/v1"'));
  assert.equal(extracted.includes('private_tool'), false);
  assert.equal(extracted.includes('[plugins.'), false);
  assert.equal(extracted.includes('[windows]'), false);

  // 安装桌面集成时,隔离成员目录也写入提取后的 provider 配置。
  const store = new Store(tempDir(t, 'desktop-provider-store-'));
  writeFileSync(join(sourceHome, 'config.toml'), raw);
  await installCodexDesktopIntegration(store, {
    detections: fakeDetections('/Applications/ChatGPT.app'),
    codexHome: sourceHome,
    socketPath: '/tmp/bus.sock',
    now: NOW,
  });
  const memberConfig = readFileSync(join(store.directory, 'desktop-engines', 'codex', 'config.toml'), 'utf8');
  assert.ok(memberConfig.includes('[model_providers.custom]'));
  assert.equal(memberConfig.includes('private_tool'), false);
  store.close();
});

test('codexDesktopVerification settles promptly after exit even if stdout pipe stays open', async t => {
  const workspace = tempDir(t, 'codex-verify-exit-');
  const strategy = codexDesktopVerification();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const fakeChild = Object.assign(new EventEmitter(), { stdout, stderr });
  const started = Date.now();
  const result = await strategy.verifyEngine({
    workspace,
    detection: { enginePath: 'fake-codex' },
    timeoutMs: 10_000,
    spawnTracked: () => {
      setTimeout(() => {
        stdout.write('OK\n');
        // 模拟 Windows 后台子进程继承 stdout 管道:只触发 exit,永不触发 close。
        fakeChild.emit('exit', 0);
      }, 20);
      return fakeChild;
    },
  });
  assert.equal(result.ok, true);
  assert.ok(Date.now() - started < 3000, 'exit 后应快速结算,不得卡死等 close');
  assert.equal(stdout.destroyed, true);
});
