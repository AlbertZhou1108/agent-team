// ZCode Desktop 接入契约:~/.zcode/cli/config.json 的 mcp.servers.agent_team
// 受管条目 + zcode-desktop 成员宿主 spec。桌面 MCP 配置源与成员适配器同源
// (2026-11-20 实机核对),回归点:其余 mcp server 与顶层键必须原样保留。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../store.mjs';
import { readDesktopHostSpecs } from '../../desktop/member-hosts.mjs';
import { installZcodeDesktopIntegration, zcodeDesktopMemberHostSpec } from '../../desktop/zcode.mjs';

function tempDir(t, prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => { try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* Windows 上文件可能仍被占用 */ } });
  return directory;
}

function detection(overrides = {}) {
  return {
    kind: 'zcode',
    found: true,
    applicationId: 'desktop-zcode-1',
    bundlePath: join('/Applications', 'ZCode.app'),
    enginePath: join('/Applications', 'ZCode.app', 'Contents', 'Resources', 'glm', 'zcode.cjs'),
    engineVersion: '3.18.2',
    ...overrides,
  };
}

function install(store, { zcodeHome, socketPath }) {
  return installZcodeDesktopIntegration(store, {
    detections: [detection()],
    zcodeHome,
    socketPath,
  });
}

test('安装合并写入 config.json 的 agent_team 条目,保留其余 server 与顶层键', async t => {
  const root = tempDir(t, 'zcode-desktop-');
  const store = new Store(join(root, 'store'));
  t.after(() => store.close());
  const zcodeHome = join(root, 'zcode-home');
  const configPath = join(zcodeHome, 'cli', 'config.json');
  mkdirSync(join(zcodeHome, 'cli'), { recursive: true });
  const originalText = `${JSON.stringify({
    plugins: { 'agent-team': { enabled: true } },
    mcp: { servers: { 'webstorm-mcp': { command: 'node', args: ['webstorm.mjs'] } } },
  }, null, 2)}\n`;
  writeFileSync(configPath, originalText);

  const result = await install(store, { zcodeHome, socketPath: join(root, 'bus.sock') });

  const parsed = JSON.parse(readFileSync(result.configPath, 'utf8'));
  assert.equal(parsed.plugins['agent-team'].enabled, true, '顶层键必须保留');
  const entry = parsed.mcp.servers.agent_team;
  assert.ok(entry, 'agent_team 条目必须写入');
  assert.ok(entry.env.AGENT_TEAM_CLIENT_KEY, '激活凭据必须写入宿主配置');
  assert.ok(entry.args.includes('--socket'));
  assert.equal(parsed.mcp.servers['webstorm-mcp'].command, 'node', '其余 mcp server 必须保留');

  // 备份:内容与哈希对应写入前的原文。
  assert.ok(existsSync(result.backupPath), '已有配置必须先备份');
  assert.equal(readFileSync(result.backupPath, 'utf8'), originalText);
  const { createHash } = await import('node:crypto');
  assert.equal(result.backupHash, createHash('sha256').update(originalText).digest('hex'));
  assert.equal(result.binding.bindingKind, 'activation');
  assert.equal(result.binding.host, 'zcode');
  assert.equal(result.memberHost, 'zcode-desktop');
  assert.match(result.nextStep, /bind-session/);
});

test('激活凭据 key 不出现在安装返回值里', async t => {
  const root = tempDir(t, 'zcode-desktop-');
  const store = new Store(join(root, 'store'));
  t.after(() => store.close());
  const result = await install(store, { zcodeHome: join(root, 'zcode-home'), socketPath: join(root, 'bus.sock') });
  const written = JSON.parse(readFileSync(result.configPath, 'utf8'));
  const key = written.mcp.servers.agent_team.env.AGENT_TEAM_CLIENT_KEY;
  assert.ok(key, '宿主配置里必须有 key');
  assert.doesNotMatch(JSON.stringify(result), new RegExp(key), '返回值不得携带 key(面板会展示)');
});

test('重复安装幂等:同一激活连接轮换凭据,其余内容保留', async t => {
  const root = tempDir(t, 'zcode-desktop-');
  const store = new Store(join(root, 'store'));
  t.after(() => store.close());
  const zcodeHome = join(root, 'zcode-home');
  const socketPath = join(root, 'bus.sock');

  const first = await install(store, { zcodeHome, socketPath });
  const keyBefore = JSON.parse(readFileSync(first.configPath, 'utf8')).mcp.servers.agent_team.env.AGENT_TEAM_CLIENT_KEY;
  const second = await install(store, { zcodeHome, socketPath });

  assert.equal(second.binding.id, first.binding.id, '重装按名称复用同一激活连接');
  assert.ok(second.backupPath, '重装同样先备份');
  const latest = JSON.parse(readFileSync(second.configPath, 'utf8'));
  assert.ok(
    latest.mcp.servers.agent_team.args.includes(second.binding.id),
    'agent_team 条目指向该激活连接',
  );
  const keyAfter = latest.mcp.servers.agent_team.env.AGENT_TEAM_CLIENT_KEY;
  assert.notEqual(keyAfter, keyBefore, '重装轮换凭据');
  assert.equal(
    JSON.parse(readFileSync(second.backupPath, 'utf8')).mcp.servers.agent_team.env.AGENT_TEAM_CLIENT_KEY,
    keyBefore,
    '第二次安装的备份是重装前的内容',
  );
});

test('成员宿主 spec 落库为 zcode-desktop,不覆盖内置 zcode 适配器', async t => {
  const root = tempDir(t, 'zcode-desktop-');
  const store = new Store(join(root, 'store'));
  t.after(() => store.close());
  await install(store, { zcodeHome: join(root, 'zcode-home'), socketPath: join(root, 'bus.sock') });
  const specs = readDesktopHostSpecs(store.directory);
  assert.equal(specs['zcode-desktop'].adapter, 'zcode');
  assert.equal(specs['zcode-desktop'].command, join('/Applications', 'ZCode.app', 'Contents', 'MacOS', 'ZCode'));
  assert.equal('zcode' in specs, false, '动态 spec 键不得与内置 CLI 宿主同名');
});

test('缺检测或缺引擎时报错且不写配置', async t => {
  const root = tempDir(t, 'zcode-desktop-');
  const store = new Store(join(root, 'store'));
  t.after(() => store.close());
  const zcodeHome = join(root, 'zcode-home');
  await assert.rejects(
    () => installZcodeDesktopIntegration(store, { detections: [], zcodeHome, socketPath: 'sock' }),
    /未检测到 ZCode Desktop 安装/,
  );
  await assert.rejects(
    () => installZcodeDesktopIntegration(store, {
      detections: [detection({ enginePath: null })],
      zcodeHome,
      socketPath: 'sock',
    }),
    /未提供内嵌执行引擎/,
  );
  assert.equal(existsSync(join(zcodeHome, 'cli', 'config.json')), false, '失败路径不得写配置');
});

test('已有配置不是合法 JSON 时报错要求手工修复', async t => {
  const root = tempDir(t, 'zcode-desktop-');
  const store = new Store(join(root, 'store'));
  t.after(() => store.close());
  const zcodeHome = join(root, 'zcode-home');
  mkdirSync(join(zcodeHome, 'cli'), { recursive: true });
  writeFileSync(join(zcodeHome, 'cli', 'config.json'), '{ not json');
  await assert.rejects(
    () => install(store, { zcodeHome, socketPath: join(root, 'bus.sock') }),
    /不是合法 JSON/,
  );
});

test('成员宿主规格要求 bundle 与数据目录', () => {
  assert.throws(() => zcodeDesktopMemberHostSpec({ dataDirectory: 'data' }), /bundle 路径/);
  assert.throws(() => zcodeDesktopMemberHostSpec({ bundlePath: '/Applications/ZCode.app' }), /数据目录/);
});
