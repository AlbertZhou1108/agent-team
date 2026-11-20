// Codex Desktop 插件安装契约:桌面聊天宿主读插件机制(.mcp.json + plugins 行),
// 不读 config.toml 的 [mcp_servers.*]。回归 2026-11-20 验收:插件目录曾是手工放置,
// 全新安装后桌面聊天看不到 Agent Team 工具。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../store.mjs';
import { PLUGIN_NAME, applyPluginEnabled, codexDesktopPluginMcp, installCodexDesktopIntegration } from '../../desktop/codex.mjs';

function tempDir(t, prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => { try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* Windows 上文件可能仍被占用 */ } });
  return directory;
}

function detection() {
  return { kind: 'codex', found: true, applicationId: 'app-1', enginePath: '/fake/codex', engineVersion: '0.1.0' };
}

function install(store, { codexHome, socketPath, pluginVersion = '9.9.9' }) {
  return installCodexDesktopIntegration(store, {
    detections: [detection()],
    codexHome,
    socketPath,
    pluginVersion,
  });
}

test('安装写入桌面插件目录、.mcp.json 与 config.toml 的 plugins 行', async t => {
  const root = tempDir(t, 'codex-plugin-');
  const store = new Store(join(root, 'store'));
  t.after(() => store.close());
  const codexHome = join(root, 'codex-home');

  const result = await install(store, { codexHome, socketPath: join(root, 'bus.sock') });

  assert.equal(result.pluginVersion, '9.9.9');
  assert.ok(existsSync(result.pluginPath), '插件目录应已创建');
  const mcpPath = join(result.pluginPath, '.mcp.json');
  const mcp = JSON.parse(readFileSync(mcpPath, 'utf8'));
  assert.equal(mcp.mcpServers.agent_team.enabled, true);
  assert.equal(mcp.mcpServers.agent_team.default_tools_approval_mode, 'never');
  assert.ok(mcp.mcpServers.agent_team.env.AGENT_TEAM_CLIENT_KEY, '插件凭据必须写入');
  assert.ok(mcp.mcpServers.agent_team.args.includes('--socket'));
  assert.ok(mcp.mcpServers.agent_team.args.includes(join(root, 'bus.sock')));
  assert.ok(existsSync(join(result.pluginPath, '.codex-marketplace-install.json')));

  const config = readFileSync(join(codexHome, 'config.toml'), 'utf8');
  assert.match(config, /agent-team managed block:begin/, 'CLI 侧的受管块仍要保留');
  assert.match(config, new RegExp(`\\[plugins\\."${PLUGIN_NAME}"\\]`));
  assert.match(config, /enabled = true/);
});

test('重复安装幂等:插件表只出现一次,已有配置保留', async t => {
  const root = tempDir(t, 'codex-plugin-');
  const store = new Store(join(root, 'store'));
  t.after(() => store.close());
  const codexHome = join(root, 'codex-home');
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(
    join(codexHome, 'config.toml'),
    '[features]\njs_repl = false\n\n[plugins."agent-team@agent-team"]\nenabled = false\n',
  );

  await install(store, { codexHome, socketPath: join(root, 'bus.sock') });
  await install(store, { codexHome, socketPath: join(root, 'bus.sock') });

  const config = readFileSync(join(codexHome, 'config.toml'), 'utf8');
  assert.equal((config.match(/\[plugins\."agent-team@agent-team"\]/g) ?? []).length, 1, '插件表不得重复');
  assert.match(config, /js_repl = false/, '用户已有配置必须保留');
  assert.doesNotMatch(config, /enabled = false/, '重复安装应把插件翻回 enabled=true');
});

test('applyPluginEnabled 追加缺失的表,并只改 enabled 键', () => {
  const appended = applyPluginEnabled('[features]\njs_repl = false\n');
  assert.match(appended, /\[plugins\."agent-team@agent-team"\]\nenabled = true/);
  assert.match(appended, /js_repl = false/);

  const flipped = applyPluginEnabled('[plugins."agent-team@agent-team"]\nsource = "local"\nenabled = false\n[other]\nx = 1\n');
  assert.match(flipped, /enabled = true/);
  assert.match(flipped, /source = "local"/, '同表其他键保留');
  assert.match(flipped, /\[other\]\nx = 1/, '后续表不受影响');

  // 已 enabled=true 时不得改动任何字节(换行都不能少),否则会把后续表整体上移。
  const already = '[plugins."agent-team@agent-team"]\nenabled = true\n\n[features]\njs_repl = false\n';
  assert.equal(applyPluginEnabled(already), already);
  // 二次应用幂等。
  const once = applyPluginEnabled('[features]\nx = 1\n');
  assert.equal(applyPluginEnabled(once), once);
});

test('codexDesktopPluginMcp 与受管块使用同一组命令与凭据键', () => {
  const config = codexDesktopPluginMcp({ socketPath: '/tmp/bus.sock', bindingId: 'b1', clientKey: 'k1', runner: { command: 'node' }, cliPath: '/repo/src/cli.mjs' });
  const server = config.mcpServers.agent_team;
  assert.equal(server.command, 'node');
  assert.deepEqual(server.args, ['--disable-warning=ExperimentalWarning', '/repo/src/cli.mjs', 'mcp', '--socket', '/tmp/bus.sock', '--client', 'b1']);
  assert.deepEqual(server.env, { AGENT_TEAM_CLIENT_KEY: 'k1', AGENT_TEAM_CONTROL_PROTOCOL: '1' });
});
