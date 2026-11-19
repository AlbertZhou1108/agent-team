// DSH 与 Claude 桌面切片的安装内部表示:JSON 受管键、手动桥接凭据、身份通道差异。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../store.mjs';
import { installClaudeDesktopIntegration } from '../../desktop/claude.mjs';
import { installDshDesktopIntegration } from '../../desktop/dsh.mjs';

const NOW = '2026-11-20T00:00:00.000Z';

function tempDir(t, prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return directory;
}

function detectionsFor(kind) {
  return [{
    kind,
    found: true,
    bundlePath: `/Applications/${kind}.app`,
    bundleVersion: '1.0',
    enginePath: `/Applications/${kind}.app/Contents/engine`,
    engineVersion: '2.0',
    applicationId: `app-fake-${kind}`,
    fingerprint: `fp-${kind}`,
  }];
}

test('claude install owns only the agent_team key, preserves the rest, and records replacement', async t => {
  const store = new Store(tempDir(t, 'desktop-claude-'));
  const configDir = tempDir(t, 'desktop-claude-home-');
  writeFileSync(join(configDir, 'claude_desktop_config.json'), JSON.stringify({
    mcpServers: { other_connector: { command: 'x' } },
    someSetting: true,
  }));
  const result = await installClaudeDesktopIntegration(store, {
    detections: detectionsFor('claude'),
    claudeConfigDir: configDir,
    socketPath: '/tmp/bus.sock',
    now: NOW,
  });
  assert.equal(result.binding.bindingKind, 'activation');
  assert.equal(result.replacedUserEntry, false);
  const parsed = JSON.parse(readFileSync(result.configPath, 'utf8'));
  assert.equal(parsed.someSetting, true, '用户既有键必须保留');
  assert.equal(parsed.mcpServers.other_connector.command, 'x');
  assert.ok(parsed.mcpServers.agent_team.env.AGENT_TEAM_CLIENT_KEY);
  assert.ok(result.backupPath);
  // 重复安装:agent_team 键替换,备份产生;其他键仍保留。
  const second = await installClaudeDesktopIntegration(store, {
    detections: detectionsFor('claude'),
    claudeConfigDir: configDir,
    socketPath: '/tmp/bus.sock',
    now: '2026-11-20T01:00:00.000Z',
  });
  assert.equal(second.replacedUserEntry, true);
  const reparsed = JSON.parse(readFileSync(result.configPath, 'utf8'));
  assert.equal(reparsed.someSetting, true);
  assert.equal(reparsed.mcpServers.other_connector.command, 'x');
  // 诚实限制:应用级单连接 + Pull-only。
  assert.ok(result.limitations.some(item => item.includes('Pull-only')));
  assert.ok(result.limitations.some(item => item.includes('应用级')));
  store.close();
});

test('dsh install returns a manual bridge payload and creates the activation binding', async t => {
  const store = new Store(tempDir(t, 'desktop-dsh-'));
  const result = await installDshDesktopIntegration(store, {
    detections: detectionsFor('dsh'),
    socketPath: '/tmp/bus.sock',
  });
  assert.equal(result.manual, true);
  assert.equal(result.mcpConfig.serverName, 'agent_team');
  assert.equal(result.mcpConfig.transport, 'stdio');
  assert.ok(result.mcpConfig.env.AGENT_TEAM_CLIENT_KEY, '手动桥接必须把凭据交给用户粘贴');
  assert.ok(result.limitations.some(item => item.includes('bind-session')));
  assert.ok(result.limitations.some(item => item.includes('唤醒桥')));
  // 激活连接已登记。
  const row = store.get('SELECT binding_kind,surface FROM external_client_bindings WHERE id=?', result.binding.id);
  assert.equal(row.binding_kind, 'activation');
  assert.equal(row.surface, 'desktop');
  store.close();
});
