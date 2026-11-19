import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveZcodeLaunch, wakeZcodeAppServer, detectZcodeLayout, prepareZcodeEntry, zcodeAppPaths, zcodePersonalProviderConfigPath } from '../../hosts/zcode/wake.mjs';

function fixture(t, source) {
  const directory = mkdtempSync(join(tmpdir(), 'zcode-wake-'));
  const file = join(directory, 'fixture.mjs');
  writeFileSync(file, `#!/usr/bin/env node\n${source}`);
  chmodSync(file, 0o700);
  const command = process.platform === 'win32' ? join(directory, 'fixture.cmd') : file;
  if (process.platform === 'win32') writeFileSync(command, `@echo off\r\n"${process.execPath}" "%~dp0fixture.mjs" %*\r\n`);
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return command;
}

const APP_SERVER_STUB = `
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
const argv = process.argv.slice(2);
assert.deepEqual(argv.slice(0, 2), ['app-server', '--stdio']);
if (argv.includes('--cwd')) assert.equal(argv[argv.indexOf('--cwd') + 1], process.env.STUB_EXPECT_CWD ?? argv[argv.indexOf('--cwd') + 1]);
let acked = false;
console.log(JSON.stringify({ method: 'startup/storagePath', params: { path: '/tmp/stub-db.sqlite' } }));
createInterface({ input: process.stdin }).on('line', line => {
  const row = JSON.parse(line);
  const send = value => console.log(JSON.stringify(value));
  if (row.method === 'startup/storagePathReady') {
    acked = true;
    send({ method: 'startup/storageState', params: { sequence: 1 } });
    return;
  }
  if (row.method?.startsWith('startup/')) return;
  if (row.id && row.method === 'session/requestRuntimePreferences') {
    send({ id: row.id, result: { nativeSearchEnhancementsEnabled: false } });
    return;
  }
  if (!acked) {
    if ('id' in row) send({ id: row.id, error: { message: '启动握手未完成' } });
    return;
  }
  if (row.method === 'session/resume') {
    assert.equal(row.params.sessionId, 'sess-1');
    send({ id: row.id, result: { messages: [] } });
    send({ method: 'session/event', params: { sessionId: 'sess-1', type: 'session.updated', payload: {} } });
  } else if (row.method === 'session/subscribe') {
    assert.equal(row.params.sessionId, 'sess-1');
    send({ id: row.id, result: { eventSeq: 0, events: [] } });
  } else if (row.method === 'session/send') {
    assert.equal(row.params.sessionId, 'sess-1');
    assert.equal(row.params.content, '请领取 Agent Team 事件');
    send({ id: row.id, result: { accepted: true, sessionId: 'sess-1', stateRevision: 1 } });
    send({ method: 'session/event', params: { sessionId: 'sess-1', turnId: 'turn-9', type: 'turn.started', payload: { input: row.params.content } } });
    send({ method: 'session/event', params: { sessionId: 'sess-1', turnId: 'turn-9', type: 'turn.completed', payload: { response: 'ok' } } });
  } else if ('id' in row) send({ id: row.id, error: { message: 'unexpected ' + row.method } });
});
`;

test('ZCode active wake resumes the session, injects content and waits for the turn', async t => {
  const command = fixture(t, APP_SERVER_STUB);
  const result = await wakeZcodeAppServer({
    command,
    sessionId: 'sess-1',
    text: '请领取 Agent Team 事件',
    cwd: process.cwd(),
    mcpConfig: {
      command: process.execPath,
      args: ['/tmp/agent-team.mjs', 'mcp'],
      env: { AGENT_TEAM_CLIENT_KEY: 'redacted' },
    },
  });
  assert.equal(result.supported, true);
  assert.equal(result.state, 'started');
  assert.equal(result.mode, 'zcode');
  assert.equal(result.sessionId, 'sess-1');
  assert.equal(result.turnId, 'turn-9');
  assert.match(result.fingerprint, /^[0-9a-f]{64}$/);
});

test('ZCode active wake surfaces resume failures instead of hanging', async t => {
  const command = fixture(t, `
import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', line => {
  const row = JSON.parse(line);
  const send = value => console.log(JSON.stringify(value));
  if (row.method === 'startup/storagePathReady') { send({ method: 'startup/storageState', params: { sequence: 1 } }); return; }
  if (row.method?.startsWith('startup/')) return;
  if (row.method === 'session/resume') send({ id: row.id, error: { message: 'session not found: sess-404' } });
  else if ('id' in row) send({ id: row.id, result: {} });
});
console.log(JSON.stringify({ method: 'startup/storagePath', params: { path: '/tmp/stub-db.sqlite' } }));
`);
  await assert.rejects(
    () => wakeZcodeAppServer({ command, sessionId: 'sess-404', text: '唤醒' }),
    /session not found/,
  );
});

test('ZCode launch resolution prefers the env override and existing commands', t => {
  const directory = mkdtempSync(join(tmpdir(), 'zcode-launch-'));
  t.after(() => {
    delete process.env.AGENT_TEAM_ZCODE_COMMAND;
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const entry = join(directory, 'zcode-entry.mjs');
  writeFileSync(entry, 'process.exit(0);\n');
  process.env.AGENT_TEAM_ZCODE_COMMAND = entry;
  const override = resolveZcodeLaunch({ command: 'zcode', cwd: directory });
  assert.equal(override.command, entry);
  assert.deepEqual(override.args, ['app-server', '--stdio', '--cwd', directory]);
  // provider 配置路径随机器而异（CI 上可能不存在）；断言注入值与探测约定一致。
  assert.equal(override.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, zcodePersonalProviderConfigPath());
  delete process.env.AGENT_TEAM_ZCODE_COMMAND;
  const direct = resolveZcodeLaunch({ command: entry, cwd: directory });
  assert.equal(direct.command, entry);
  assert.deepEqual(direct.args, ['app-server', '--stdio', '--cwd', directory]);
});

/** 构造假 app 目录：entry 用可执行 stub，provider 配置按布局放到 legacy 或 modern 位置。 */
function fakeApp(t, layout) {
  const root = mkdtempSync(join(tmpdir(), 'zcode-app-'));
  const app = join(root, 'ZCode.app');
  const paths = zcodeAppPaths(app);
  mkdirSync(join(paths.entry, '..'), { recursive: true });
  mkdirSync(join(paths.electron, '..'), { recursive: true });
  writeFileSync(paths.electron, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  writeFileSync(paths.entry, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({method:"startup/storagePath",params:{path:"/tmp/x"}})+"\\n");\n', { mode: 0o700 });
  const provider = layout === 'modern' ? paths.modernProvider : paths.legacyProvider;
  mkdirSync(join(provider, '..'), { recursive: true });
  writeFileSync(provider, '{}');
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return app;
}

test('ZCode detects legacy and modern provider layouts', t => {
  assert.equal(detectZcodeLayout(fakeApp(t, 'legacy')), 'legacy');
  assert.equal(detectZcodeLayout(fakeApp(t, 'modern')), 'modern');
  const empty = mkdtempSync(join(tmpdir(), 'zcode-empty-'));
  t.after(() => rmSync(empty, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  assert.equal(detectZcodeLayout(empty), null);
});

test('ZCode legacy layout keeps the Electron launch unchanged', t => {
  const app = fakeApp(t, 'legacy');
  delete process.env.AGENT_TEAM_ZCODE_COMMAND;
  delete process.env.ZCODE_AGENT_SERVER_COMMAND;
  t.after(() => { delete process.env.AGENT_TEAM_ZCODE_COMMAND; });
  const launch = resolveZcodeLaunch({ command: join(app, 'Contents', 'MacOS', 'ZCode'), cwd: process.cwd() });
  assert.equal(launch.command, join(app, 'Contents', 'MacOS', 'ZCode'));
  assert.deepEqual(launch.args, [zcodeAppPaths(app).entry, 'app-server', '--stdio', '--cwd', process.cwd()]);
  assert.equal(launch.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(launch.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, zcodePersonalProviderConfigPath());
});

test('ZCode launch injects the personal provider config path for headless spawns', t => {
  // 新版 app-server 靠该变量定位 provider 配置；桌面外无头启动必须自行注入，否则不报模型目录。
  const directory = mkdtempSync(join(tmpdir(), 'zcode-launch-'));
  const entry = join(directory, 'zcode-entry.mjs');
  writeFileSync(entry, 'process.exit(0);\n');
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  delete process.env.AGENT_TEAM_ZCODE_COMMAND;
  const direct = resolveZcodeLaunch({ command: entry, cwd: directory });
  const expected = zcodePersonalProviderConfigPath();
  assert.equal(direct.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE ?? null, expected);
});

test('ZCode modern layout uses a prepared copy launched by system node', t => {
  const app = fakeApp(t, 'modern');
  delete process.env.AGENT_TEAM_ZCODE_COMMAND;
  delete process.env.ZCODE_AGENT_SERVER_COMMAND;
  const compat = mkdtempSync(join(tmpdir(), 'zcode-compat-'));
  process.env.AGENT_TEAM_ZCODE_COMPAT_DIR = compat;
  t.after(() => {
    delete process.env.AGENT_TEAM_ZCODE_COMMAND;
    delete process.env.ZCODE_AGENT_SERVER_COMMAND;
    delete process.env.AGENT_TEAM_ZCODE_COMPAT_DIR;
    rmSync(compat, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const launch = resolveZcodeLaunch({ command: join(app, 'Contents', 'MacOS', 'ZCode') });
  assert.equal(launch.command, process.execPath);
  assert.deepEqual(launch.args.slice(1), ['app-server', '--stdio']);
  const copiedEntry = launch.args[0];
  assert.ok(copiedEntry.startsWith(compat));
  assert.ok(existsSync(copiedEntry));
  assert.ok(existsSync(join(compat, 'glm', 'provider', 'zcode-builtin.json')));
  // 幂等：再次解析复用同一入口，不重复复制。
  assert.equal(resolveZcodeLaunch({ command: join(app, 'Contents', 'MacOS', 'ZCode') }).args[0], copiedEntry);
});

test('prepareZcodeEntry is idempotent and migrates provider config', t => {
  const app = fakeApp(t, 'modern');
  const compat = mkdtempSync(join(tmpdir(), 'zcode-compat-'));
  process.env.AGENT_TEAM_ZCODE_COMPAT_DIR = compat;
  t.after(() => {
    delete process.env.AGENT_TEAM_ZCODE_COMPAT_DIR;
    rmSync(compat, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const first = prepareZcodeEntry(app);
  const config = join(compat, 'glm', 'provider', 'zcode-builtin.json');
  assert.ok(existsSync(first));
  assert.deepEqual(JSON.parse(readFileSync(config, 'utf8')), {});
  assert.equal(prepareZcodeEntry(app), first);
});
