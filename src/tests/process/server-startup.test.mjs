import { version } from '../../version.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { socketFor, startServer } from '../../server.mjs';
import { rpc } from '../../rpc.mjs';

// 原生 http 请求才能自定义 sec-fetch-site（fetch 视其为 forbidden header）。
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
