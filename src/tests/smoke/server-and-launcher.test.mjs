import test, { describe } from 'node:test';
import { version } from '../../version.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { socketFor, startServer } from '../../server.mjs';
import { rpc } from '../../rpc.mjs';
import net from 'node:net';
import { applicationData, launch, discover, stopService } from '../../launcher.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Store } from '../../store.mjs';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

describe('server-startup', () => {
function rawRequest(target, path, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: target.hostname, port: target.port, path, method, headers },
      response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    request.on('error', reject);
    request.end();
  });
}

test('server IPC starts, answers requests and can restart with the same data directory', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-startup-'));
  let server;
  try {
    const address = socketFor(directory);
    assert.equal(socketFor(join(directory, '.')), address);
    assert.notEqual(socketFor(join(directory, 'other')), address);
    if (process.platform === 'win32') assert.ok(address.startsWith('\\\\.\\pipe\\'));
    for (let attempt = 0; attempt < 2; attempt++) {
      server = await startServer({ directory, hosts: new Map() });
      assert.deepEqual(await rpc(address, { op: 'ping' }), { version });
      const response = await fetch(new URL('/api/model-policy', server.url));
      assert.equal(response.status, 200);
      await response.text();
      await server.close();
      server = null;
    }
  } finally {
    await server?.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  }
});

test('cross-site page navigation is allowed while API and write requests stay blocked', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-csrf-'));
  let server;
  try {
    server = await startServer({ directory, hosts: new Map() });
    const target = new URL(server.url);

    // 粘贴深链接：GET + text/html 导航头 → 放行，返回 SPA 外壳。
    const navigation = await rawRequest(target, '/groups/any-team', {
      headers: { accept: 'text/html', 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(navigation.status, 200);

    // 跨站读接口：仍拒绝（挡住 CSRF）。
    const api = await rawRequest(target, '/api/model-policy', {
      headers: { accept: 'application/json', 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(api.status, 403);
    assert.match(api.body, /Cross-site request rejected/);

    // 跨站写请求：即便伪装成导航也不能放行。
    const write = await rawRequest(target, '/api/model-policy', {
      method: 'POST',
      headers: { accept: 'text/html', 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(write.status, 403);
  } finally {
    await server?.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  }
});
});

describe('launcher', () => {
test('application data is stable and separate from the current directory', () => {
  assert.equal(applicationData({ platform: 'darwin', home: '/user', env: {} }), join('/user', 'Library', 'Application Support', 'Agent Team'));
  assert.equal(applicationData({ platform: 'linux', home: '/user', env: { XDG_DATA_HOME: '/data' } }), join('/data', 'agent-team'));
  assert.equal(applicationData({ platform: 'win32', home: '/user', env: { LOCALAPPDATA: '/local' } }), join('/local', 'Agent Team'));
});

test('concurrent launchers discover and reuse one service; stop preserves data', { timeout: 30000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'launcher 中文 space-'));
  const configFile = join(directory, 'hosts.json');
  writeFileSync(configFile, JSON.stringify({ hosts: {} }));
  t.after(async () => { await stopService(directory); rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
  const [first, second] = await Promise.all([launch({ directory, configFile }), launch({ directory, configFile })]);
  assert.equal(first.pid, second.pid);
  assert.equal(first.instanceId, second.instanceId);
  assert.equal((await launch({ directory, configFile })).reused, true);
  assert.equal((await discover(directory)).url, first.url);
  await assert.rejects(rpc(socketFor(directory), { op: 'service_stop', instanceId: 'stale-instance' }), /实例已变更/);
  assert.equal(await stopService(directory), true);
  assert.equal(existsSync(join(directory, 'owner.json')), false);
  assert.equal(existsSync(join(directory, 'groups.sqlite')), true);
  assert.equal(await discover(directory), null);
  const next = await launch({ directory, configFile });
  assert.notEqual(next.instanceId, first.instanceId);
  assert.equal(next.url, first.url);
});


test('discovery treats a resetting socket as not running', { timeout: 15000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'launcher-reset-'));
  const resetting = net.createServer(socket => socket.destroy());
  t.after(async () => {
    await new Promise(resolve => resetting.close(resolve));
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  });
  await new Promise((resolve, reject) => {
    resetting.once('error', reject);
    resetting.listen(socketFor(directory), resolve);
  });
  // 服务停止/重启瞬间 socket 还在但连接被重置:必须当作未运行,而不是抛 ECONNRESET。
  assert.equal(await discover(directory), null);
});

test('an occupied remembered port falls back without stopping its owner', { timeout: 30000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'launcher-port-'));
  const configFile = join(directory, 'hosts.json'); writeFileSync(configFile, JSON.stringify({ hosts: {} }));
  const occupied = net.createServer();
  t.after(async () => {
    await stopService(directory);
    if (occupied.listening) await new Promise(resolve => occupied.close(resolve));
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  });
  const first = await launch({ directory, configFile });
  await stopService(directory);
  await new Promise((resolve, reject) => { occupied.once('error', reject); occupied.listen(Number(new URL(first.url).port), '127.0.0.1', resolve); });
  const next = await launch({ directory, configFile });
  assert.notEqual(next.url, first.url);
  assert.equal(occupied.listening, true);
});
});

describe('connect-cli', () => {
const run = promisify(execFile);
const cli = fileURLToPath(new URL('../../cli.mjs', import.meta.url));

test('connect installs the Skill, prints MCP config and rotates the same binding on repeat', async t => {
  const root = mkdtempSync(join(tmpdir(), 'agent-team-connect-cli-'));
  t.after(() => { try { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ } });
  const data = join(root, 'data');
  const skill = join(root, 'skill');
  const args = [
    cli,
    'connect',
    '--data', data,
    '--host', 'codex',
    '--client', 'main',
    '--principal', 'user',
    '--workspace', root,
    '--skill-root', skill,
  ];
  const first = JSON.parse((await run(process.execPath, args)).stdout);
  assert.equal(first.binding.name, 'main');
  assert.ok(first.capabilities.capabilities.includes('session.wake'));
  assert.equal(first.mcp.agent_team.env.AGENT_TEAM_CONTROL_PROTOCOL, '1');
  assert.equal(first.skill.current, true);
  assert.equal(readFileSync(join(skill, 'SKILL.md'), 'utf8').startsWith('---'), true);

  const second = JSON.parse((await run(process.execPath, args)).stdout);
  assert.equal(second.binding.id, first.binding.id);
  assert.notEqual(second.mcp.agent_team.env.AGENT_TEAM_CLIENT_KEY, first.mcp.agent_team.env.AGENT_TEAM_CLIENT_KEY);
  assert.equal(second.skill.changed, false);
  const store = new Store(data);
  try {
    assert.equal(store.get("SELECT count(*) AS n FROM external_client_bindings WHERE name='main'").n, 1);
  } finally {
    store.close();
  }
});

test('connect for zcode declares session.wake and reuses the shared skill directory', async t => {
  const root = mkdtempSync(join(tmpdir(), 'agent-team-connect-zcode-'));
  t.after(() => { try { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ } });
  const data = join(root, 'data');
  const output = JSON.parse((await run(process.execPath, [
    cli,
    'connect',
    '--data', data,
    '--host', 'zcode',
    '--client', 'main',
    '--principal', 'user',
    '--workspace', root,
  ])).stdout);
  assert.ok(output.capabilities.capabilities.includes('session.wake'));
  assert.equal(output.skill.targetDir, join(homedir(), '.agents', 'skills', 'agent-team'));
  assert.notEqual(output.skill.changed, true, 'shared skill directory must never be replaced by an install copy');
  assert.equal(output.mcp.agent_team.env.AGENT_TEAM_CONTROL_PROTOCOL, '1');
  const store = new Store(data);
  try {
    assert.equal(store.get("SELECT host FROM external_client_bindings WHERE name='main'").host, 'zcode');
  } finally {
    store.close();
  }
});

test('connect for dsh declares session.wake and reuses the shared skill directory', async t => {
  const root = mkdtempSync(join(tmpdir(), 'agent-team-connect-dsh-'));
  t.after(() => { try { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ } });
  const data = join(root, 'data');
  const output = JSON.parse((await run(process.execPath, [
    cli,
    'connect',
    '--data', data,
    '--host', 'dsh',
    '--client', 'main',
    '--principal', 'user',
    '--workspace', root,
  ])).stdout);
  assert.ok(output.capabilities.capabilities.includes('session.wake'));
  assert.equal(output.skill.targetDir, join(homedir(), '.agents', 'skills', 'agent-team'));
  assert.notEqual(output.skill.changed, true, 'shared skill directory must never be replaced by an install copy');
  assert.equal(output.mcp.agent_team.env.AGENT_TEAM_CONTROL_PROTOCOL, '1');
  const store = new Store(data);
  try {
    assert.equal(store.get("SELECT host FROM external_client_bindings WHERE name='main'").host, 'dsh');
  } finally {
    store.close();
  }
});
});

describe('rpc-encoding', () => {
async function fragmented(socket, value) {
  const bytes = Buffer.from(JSON.stringify(value) + '\n');
  for (const byte of bytes) {
    socket.write(Buffer.from([byte]));
    await delay(2);
  }
}
test('RPC response preserves byte-fragmented Chinese and emoji', async () => {
  const server = net.createServer(socket => {
    socket.once('data', () => { void fragmented(socket, { result: '中文😀' }); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    assert.equal(await rpc({ port: server.address().port, host: '127.0.0.1' }, { op: 'ping' }, 2000), '中文😀');
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('RPC request preserves byte-fragmented Chinese and emoji', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-utf8-'));
  let server, socket;
  try {
    server = await startServer({ directory, hosts: new Map() });
    server.bus.endpointTools = endpoint => endpoint;
    socket = net.createConnection(server.socketPath);
    socket.setEncoding('utf8');
    await once(socket, 'connect');
    const received = once(socket, 'data');
    await fragmented(socket, { op: 'tools', endpoint: '中文😀' });
    assert.equal(JSON.parse((await received)[0]).result, '中文😀');
  } finally {
    socket?.destroy();
    await server?.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  }
});

for (const scenario of ['oversize', 'timeout', 'disconnect']) {
  test(`RPC rejects ${scenario} responses`, async () => {
    const server = net.createServer(socket => {
      socket.on('error', () => {});
      socket.once('data', () => {
        if (scenario === 'oversize') socket.end('中'.repeat(1500000));
        if (scenario === 'disconnect') socket.end();
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      await assert.rejects(rpc({ port: server.address().port, host: '127.0.0.1' }, { op: 'ping' }, scenario === 'timeout' ? 50 : 3000), scenario === 'oversize' ? /响应过大/ : scenario === 'timeout' ? /超时/ : /断开连接/);
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
}

test('RPC server closes requests exceeding one MiB in UTF-8 bytes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-limit-'));
  let server, socket;
  try {
    server = await startServer({ directory, hosts: new Map() });
    socket = net.createConnection(server.socketPath);
    socket.on('error', () => {});
    await once(socket, 'connect');
    const closed = new Promise(resolve => socket.once('close', resolve));
    socket.write('中'.repeat(400000));
    await closed;
  } finally {
    socket?.destroy();
    await server?.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  }
});
});
