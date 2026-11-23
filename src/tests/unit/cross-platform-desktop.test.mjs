import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../store.mjs';
import {
  DESKTOP_DEFINITIONS,
  claudeEngineCandidates,
  defaultClaudeConfigDir,
  desktopDetectionContext,
  detectDesktopApplications,
  parseWindowsMsixRegistryOutput,
  readAsarPackageVersion,
  readBundleVersion,
  zcodeDesktopLaunchCommand,
} from '../../desktop/index.mjs';
import { isolatedHomeEnv, resolveZcodeLaunch, zcodeAppPaths } from '../../member/zcode/wake.mjs';
import { launchEnvironment } from '../../launcher.mjs';
import { windowsPrivateAclArgs } from '../../private-permissions.mjs';
import { spawnHost } from '../../host-runtime/subprocess.mjs';

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* ignore */ } });
  return dir;
}

/** 按 Electron ASAR (Chromium Pickle) 格式构造最小合成归档,用于跨平台单测。 */
function buildSyntheticAsar(packageJsonText) {
  const payload = Buffer.from(packageJsonText, 'utf8');
  const headerJson = Buffer.from(JSON.stringify({
    files: { 'package.json': { size: payload.length, offset: '0' } },
  }), 'utf8');
  const paddedJsonLen = Math.ceil(headerJson.length / 4) * 4;
  const headerPicklePayloadSize = 4 + paddedJsonLen;
  const headerPickleTotalSize = 4 + headerPicklePayloadSize;
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(headerPickleTotalSize, 4);
  prefix.writeUInt32LE(headerPicklePayloadSize, 8);
  prefix.writeUInt32LE(headerJson.length, 12);
  const pad = Buffer.alloc(paddedJsonLen - headerJson.length);
  return Buffer.concat([prefix, headerJson, pad, payload]);
}

test('readBundleVersion extracts versions across JSON, ASAR, Info.plist, AppxManifest, plain text, and dir name', async t => {
  const root = tempDir(t, 'bundle-ver-');

  const jsonDir = join(root, 'json-app');
  mkdirSync(join(jsonDir, 'resources', 'app'), { recursive: true });
  writeFileSync(join(jsonDir, 'resources', 'app', 'package.json'), JSON.stringify({ version: '1.2.3' }));
  assert.equal(await readBundleVersion(jsonDir), '1.2.3');

  const asarDir = join(root, 'asar-app');
  mkdirSync(join(asarDir, 'resources'), { recursive: true });
  writeFileSync(join(asarDir, 'resources', 'app.asar'), buildSyntheticAsar(JSON.stringify({ version: '3.18.2' })));
  assert.equal(readAsarPackageVersion(join(asarDir, 'resources', 'app.asar')), '3.18.2');
  assert.equal(await readBundleVersion(asarDir), '3.18.2');

  const plistDir = join(root, 'mac.app');
  mkdirSync(join(plistDir, 'Contents'), { recursive: true });
  writeFileSync(
    join(plistDir, 'Contents', 'Info.plist'),
    '<?xml version="1.0"?><plist><dict><key>CFBundleShortVersionString</key><string>26.1111</string></dict></plist>',
  );
  assert.equal(await readBundleVersion(plistDir), '26.1111');

  const bplistDir = join(root, 'bplist.app');
  mkdirSync(join(bplistDir, 'Contents'), { recursive: true });
  writeFileSync(join(bplistDir, 'Contents', 'Info.plist'), 'bplist00binarydata');
  assert.equal(await readBundleVersion(bplistDir), null);

  const msixDir = join(root, 'msix-app');
  mkdirSync(msixDir, { recursive: true });
  writeFileSync(
    join(msixDir, 'AppxManifest.xml'),
    '<?xml version="1.0"?><Package><Identity Name="OpenAI.Codex" Version="26.1117.4957.0" /></Package>',
  );
  assert.equal(await readBundleVersion(msixDir), '26.1117.4957.0');

  const plainDir = join(root, 'plain-app');
  mkdirSync(plainDir, { recursive: true });
  writeFileSync(join(plainDir, 'version'), '44.7.0\n');
  assert.equal(await readBundleVersion(plainDir), '44.7.0');

  const squirrelDir = join(root, 'app-2.5.1');
  mkdirSync(squirrelDir, { recursive: true });
  assert.equal(await readBundleVersion(squirrelDir), '2.5.1');

  const emptyDir = join(root, 'unknown-app');
  mkdirSync(emptyDir, { recursive: true });
  assert.equal(await readBundleVersion(emptyDir), null);
});

test('parseWindowsMsixRegistryOutput parses packages and sorts newest version first', () => {
  const sample = [
    '',
    'HKEY_CURRENT_USER\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages\\OpenAI.Codex_26.1000.1.0_x64__abc',
    '    PackageRootFolder    REG_SZ    C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1000.1.0_x64__abc',
    '',
    'HKEY_CURRENT_USER\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages\\OpenAI.Codex_26.1117.4957.0_x64__abc',
    '    PackageRootFolder    REG_SZ    C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1117.4957.0_x64__abc',
    '',
    'HKEY_CURRENT_USER\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages\\Claude_4.29.0.0_x64__xyz',
    '    PackageRootFolder    REG_SZ    C:\\Program Files\\WindowsApps\\Claude_4.29.0.0_x64__xyz',
  ].join('\r\n');
  const parsed = parseWindowsMsixRegistryOutput(sample);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].name, 'OpenAI.Codex_26.1117.4957.0_x64__abc');
  assert.equal(parsed[0].root, 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1117.4957.0_x64__abc');
});

test('detectDesktopApplications registers all four Windows desktop installations and skips stale leftovers', async t => {
  const root = tempDir(t, 'win-desktop-');
  const localPrograms = join(root, 'LocalPrograms');
  const programFiles = join(root, 'ProgramFiles');
  const localAppData = join(root, 'LocalAppData');
  const store = new Store(tempDir(t, 'win-store-'));

  // Codex MSIX
  const codexRoot = join(root, 'WindowsApps', 'OpenAI.Codex_26.1117.4957.0_x64__abc');
  mkdirSync(join(codexRoot, 'app', 'resources'), { recursive: true });
  writeFileSync(join(codexRoot, 'AppxManifest.xml'), '<Package><Identity Name="OpenAI.Codex" Version="26.1117.4957.0" /></Package>');
  writeFileSync(join(codexRoot, 'app', 'resources', 'codex.exe'), '');

  // Claude MSIX + downloaded claude.exe
  const claudeRoot = join(root, 'WindowsApps', 'Claude_4.29.0.0_x64__xyz');
  mkdirSync(join(claudeRoot, 'app'), { recursive: true });
  writeFileSync(join(claudeRoot, 'AppxManifest.xml'), '<Package><Identity Name="Claude" Version="4.29.0.0" /></Package>');
  const claudeEngineDir = join(localAppData, 'Claude-3p', 'claude-code', '2.1.309', 'abc123');
  mkdirSync(claudeEngineDir, { recursive: true });
  writeFileSync(join(claudeEngineDir, 'claude.exe'), '');

  // DSH in LocalPrograms
  const dshRoot = join(localPrograms, 'DeepSeek Harness');
  mkdirSync(join(dshRoot, 'resources', 'runtime', 'cli', 'bin'), { recursive: true });
  writeFileSync(join(dshRoot, 'DeepSeek Harness.exe'), '');
  writeFileSync(join(dshRoot, 'version'), '44.7.0\n');
  writeFileSync(join(dshRoot, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'), '@echo off\r\n');

  // ZCode: stale empty leftover in LocalPrograms + real install in ProgramFiles
  mkdirSync(join(localPrograms, 'ZCode', 'resources', 'glm'), { recursive: true });
  const zcodeReal = join(programFiles, 'ZCode');
  mkdirSync(join(zcodeReal, 'resources', 'glm'), { recursive: true });
  writeFileSync(join(zcodeReal, 'ZCode.exe'), '');
  writeFileSync(join(zcodeReal, 'resources', 'app.asar'), buildSyntheticAsar(JSON.stringify({ version: '3.20.0' })));
  writeFileSync(join(zcodeReal, 'resources', 'glm', 'zcode.cjs'), 'module.exports = {};');

  const context = desktopDetectionContext({
    platform: 'win32',
    applicationsRoots: [localPrograms, programFiles],
    supportRoots: [localAppData],
    msixPackages: [
      { name: 'OpenAI.Codex_26.1117.4957.0_x64__abc', version: '26.1117.4957.0', root: codexRoot },
      { name: 'Claude_4.29.0.0_x64__xyz', version: '4.29.0.0', root: claudeRoot },
    ],
  });
  const results = await detectDesktopApplications(store, { definitions: DESKTOP_DEFINITIONS, context });
  const byKind = new Map(results.map(item => [item.kind, item]));

  assert.equal(byKind.get('codex').registered, true);
  assert.equal(byKind.get('codex').bundleVersion, '26.1117.4957.0');
  assert.equal(byKind.get('codex').enginePath, join(codexRoot, 'app', 'resources', 'codex.exe'));

  assert.equal(byKind.get('claude').registered, true);
  assert.equal(byKind.get('claude').bundleVersion, '4.29.0.0');
  assert.equal(byKind.get('claude').enginePath, join(claudeEngineDir, 'claude.exe'));
  assert.equal(byKind.get('claude').engineVersion, '2.1.309');

  assert.equal(byKind.get('dsh').registered, true);
  assert.equal(byKind.get('dsh').bundleVersion, '44.7.0');
  assert.equal(byKind.get('dsh').enginePath, join(dshRoot, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'));

  assert.equal(byKind.get('zcode').registered, true);
  assert.equal(byKind.get('zcode').bundlePath, zcodeReal, '必须跳过残留空目录,命中真实安装目录');
  assert.equal(byKind.get('zcode').bundleVersion, '3.20.0');
  assert.equal(byKind.get('zcode').enginePath, join(zcodeReal, 'resources', 'glm', 'zcode.cjs'));
  store.close();
});

test('claudeEngineCandidates handles macOS, Windows, and Linux engine layouts sorted numerically', t => {
  const root = tempDir(t, 'claude-engines-');
  mkdirSync(join(root, '2.1.99', 'h1'), { recursive: true });
  writeFileSync(join(root, '2.1.99', 'h1', 'claude.exe'), '');
  mkdirSync(join(root, '2.1.309', 'h2'), { recursive: true });
  writeFileSync(join(root, '2.1.309', 'h2', 'claude.exe'), '');
  const found = claudeEngineCandidates(root);
  assert.equal(found.length, 2);
  assert.equal(found[0].version, '2.1.309');
  assert.equal(found[1].version, '2.1.99');
});

test('defaultClaudeConfigDir resolves platform-appropriate Claude Desktop config directories', t => {
  const root = tempDir(t, 'claude-cfg-');
  const local = join(root, 'Local');
  const roaming = join(root, 'Roaming');
  assert.equal(defaultClaudeConfigDir({ platform: 'darwin', home: root, env: {} }), join(root, 'Library', 'Application Support', 'Claude'));
  assert.equal(defaultClaudeConfigDir({ platform: 'linux', home: root, env: { XDG_CONFIG_HOME: join(root, 'xdg') } }), join(root, 'xdg', 'Claude'));
  // Windows 无现存配置时默认 Roaming\Claude
  assert.equal(
    defaultClaudeConfigDir({ platform: 'win32', home: root, env: { LOCALAPPDATA: local, APPDATA: roaming } }),
    join(roaming, 'Claude'),
  );
  // Windows 存在 Claude-3p 配置时优先命中它
  mkdirSync(join(local, 'Claude-3p'), { recursive: true });
  writeFileSync(join(local, 'Claude-3p', 'claude_desktop_config.json'), '{}');
  assert.equal(
    defaultClaudeConfigDir({ platform: 'win32', home: root, env: { LOCALAPPDATA: local, APPDATA: roaming } }),
    join(local, 'Claude-3p'),
  );
});

test('zcode cross-platform helpers cover isolatedHomeEnv, Windows desktop paths, and PATH lookup', t => {
  assert.deepEqual(isolatedHomeEnv({ A: '1' }, '/iso', 'darwin'), { A: '1', HOME: '/iso' });
  assert.deepEqual(isolatedHomeEnv({ A: '1' }, 'C:\\iso', 'win32'), { A: '1', HOME: 'C:\\iso', USERPROFILE: 'C:\\iso' });
  assert.equal(zcodeDesktopLaunchCommand('/Applications/ZCode.app', 'darwin'), join('/Applications/ZCode.app', 'Contents', 'MacOS', 'ZCode'));
  assert.equal(zcodeDesktopLaunchCommand('C:\\Program Files\\ZCode', 'win32'), join('C:\\Program Files\\ZCode', 'ZCode.exe'));

  const root = tempDir(t, 'zcode-win-');
  const app = join(root, 'ZCode');
  const paths = zcodeAppPaths(app, 'win32');
  mkdirSync(join(paths.entry, '..'), { recursive: true });
  mkdirSync(join(paths.modernProvider, '..'), { recursive: true });
  writeFileSync(paths.electron, '');
  writeFileSync(paths.entry, 'module.exports = {};');
  writeFileSync(paths.modernProvider, '{}');

  const compat = tempDir(t, 'zcode-win-compat-');
  process.env.AGENT_TEAM_ZCODE_COMPAT_DIR = compat;
  t.after(() => { delete process.env.AGENT_TEAM_ZCODE_COMPAT_DIR; });

  const winLaunch = resolveZcodeLaunch({
    command: 'zcode',
    platform: 'win32',
    home: root,
    env: { ProgramFiles: root, LOCALAPPDATA: join(root, 'none') },
    locate: () => null,
  });
  assert.equal(winLaunch.command, process.execPath);
  assert.ok(winLaunch.args[0].startsWith(compat));

  const pathFallback = resolveZcodeLaunch({
    command: 'zcode',
    platform: 'linux',
    home: root,
    env: {},
    locate: name => (name === 'zcode' ? '/usr/local/bin/zcode' : null),
  });
  assert.equal(pathFallback.command, '/usr/local/bin/zcode');
});

test('launchEnvironment adds platform-appropriate PATH directories and windowsPrivateAclArgs builds icacls args', () => {
  const winEnv = launchEnvironment({
    platform: 'win32',
    home: 'C:\\Users\\demo',
    env: { Path: 'C:\\Windows\\System32', APPDATA: 'C:\\Users\\demo\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\demo\\AppData\\Local' },
  });
  assert.ok(winEnv.Path.includes(join('C:\\Users\\demo\\AppData\\Roaming', 'npm')));
  assert.equal(winEnv.Path.includes('/opt/homebrew/bin'), false);

  const macEnv = launchEnvironment({ platform: 'darwin', home: '/Users/demo', env: { PATH: '/usr/bin' } });
  assert.ok(macEnv.PATH.includes('/opt/homebrew/bin'));

  const aclArgs = windowsPrivateAclArgs('C:\\data', { USERNAME: 'alice', USERDOMAIN: 'WORK' });
  assert.deepEqual(aclArgs, [
    'C:\\data',
    '/inheritance:r',
    '/grant:r', 'WORK\\alice:(OI)(CI)F',
    '/grant:r', '*S-1-5-18:(OI)(CI)F',
  ]);
  assert.equal(windowsPrivateAclArgs('C:\\data', {}), null);
});

test('spawnHost refuses shebang-less .cjs files on Windows instead of triggering Open With dialog', { skip: process.platform !== 'win32' }, t => {
  const dir = tempDir(t, 'no-openwith-');
  const script = join(dir, 'zcode.cjs');
  writeFileSync(script, '// plain module without shebang\nmodule.exports = {};\n');
  assert.throws(() => spawnHost(script, ['--version']), /不能直接执行无 shebang 的脚本文件/);
});
