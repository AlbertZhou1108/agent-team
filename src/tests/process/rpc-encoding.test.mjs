import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rpc } from '../../rpc.mjs';
import { startServer } from '../../server.mjs';

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
    rmSync(directory, { recursive: true, force: true });
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
    rmSync(directory, { recursive: true, force: true });
  }
});
