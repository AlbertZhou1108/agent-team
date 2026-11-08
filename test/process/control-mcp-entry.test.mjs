import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../src/server.mjs';
import { rpc } from '../../src/rpc.mjs';
import { createExternalIdentity } from '../../src/control-plane.mjs';
import { CONTROL_CAPABILITIES } from '../../src/control-capabilities.mjs';
import { fakeHost } from '../support/fixture.mjs';

const cliPath = fileURLToPath(new URL('../../src/cli.mjs', import.meta.url));

function controlExchange({ socketPath, binding, key, directory, env = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, 'mcp', '--socket', socketPath, '--client', binding], {
      env: {
        ...process.env,
        AGENT_TEAM_CLIENT_KEY: key,
        CODEX_THREAD_ID: 'thread-from-host',
        CODEX_SESSION_ID: 'thread-from-host',
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('control MCP exchange timed out'));
    }, 30000);
    let tools;
    child.stdout.on('data', chunk => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const line = buffer.slice(0, buffer.indexOf('\n'));
        buffer = buffer.slice(buffer.indexOf('\n') + 1);
        if (!line.trim()) continue;
        const row = JSON.parse(line);
        if (row.id === 1) {
          tools = row.result.tools;
          child.stdin.write(JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: {
              name: 'team_create',
              arguments: {
                name: 'stdio MCP team',
                workspace: directory,
                members: 'worker=fake',
                policy: 'read-only',
                operationId: 'stdio-create',
              },
            },
          }) + '\n');
        } else if (row.id === 2) {
          clearTimeout(timer);
          child.kill();
          resolve({ tools, created: JSON.parse(row.result.content[0].text), isError: row.result.isError });
        }
      }
    });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) + '\n');
  });
}

test('stable control MCP shim lists and executes cross-team control tools', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-control-mcp-'));
  const host = fakeHost({ profileText: null });
  const server = await startServer({ directory, hosts: new Map([['fake', host]]) });
  t.after(async () => {
    await server.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const identity = createExternalIdentity(server.bus.store, {
    principalName: 'stdio 用户',
    bindingName: 'stdio 主控',
    host: 'codex',
    session: 'thread-stdio',
    declared: {
      capabilities: Object.values(CONTROL_CAPABILITIES),
      workspaceRoots: [directory],
      policies: ['read-only'],
    },
    probed: {
      capabilities: Object.values(CONTROL_CAPABILITIES),
      workspaceRoots: [directory],
      policies: ['read-only'],
    },
  });
  const exchange = await controlExchange({
    socketPath: server.socketPath,
    binding: identity.binding.id,
    key: identity.key,
    directory,
    env: {
      CODEX_THREAD_ID: 'thread-from-host',
      CODEX_SESSION_ID: 'thread-from-host',
    },
  });
  assert.equal(exchange.isError, false);
  assert.ok(exchange.tools.some(tool => tool.name === 'team_create'));
  assert.ok(exchange.tools.some(tool => tool.name === 'control_inbox'));
  assert.equal(exchange.created.controllerId, identity.principal.id);
  assert.equal(exchange.created.team.lead, null);
  assert.equal(
    server.bus.store.get('SELECT session FROM external_client_bindings WHERE id=?', identity.binding.id).session,
    'thread-from-host',
  );
  assert.ok(
    server.bus.store.get('SELECT wake_config FROM external_client_bindings WHERE id=?', identity.binding.id).wake_config,
  );
  assert.equal(
    (await rpc(server.socketPath, {
      op: 'bind_client_session',
      binding: identity.binding.id,
      key: identity.key,
      session: 'thread-from-wrapper',
      protocolVersion: 1,
    })).session,
    'thread-from-wrapper',
  );
});

test('control MCP treats an inherited Codex subagent thread as pull-only', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-control-mcp-subagent-'));
  const server = await startServer({ directory, hosts: new Map([['fake', fakeHost({ profileText: null })]]) });
  t.after(async () => {
    await server.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const identity = createExternalIdentity(server.bus.store, {
    principalName: '子 Agent 用户',
    bindingName: '子 Agent 主控',
    host: 'codex',
    session: 'root-thread',
    declared: {
      capabilities: Object.values(CONTROL_CAPABILITIES),
      workspaceRoots: [directory],
      policies: ['read-only'],
    },
    probed: {
      capabilities: Object.values(CONTROL_CAPABILITIES),
      workspaceRoots: [directory],
      policies: ['read-only'],
    },
  });
  const exchange = await controlExchange({
    socketPath: server.socketPath,
    binding: identity.binding.id,
    key: identity.key,
    directory,
    env: {
      CODEX_THREAD_ID: 'subagent-thread',
      CODEX_SESSION_ID: 'root-thread',
    },
  });
  assert.equal(exchange.isError, false);
  assert.equal(
    server.bus.store.get('SELECT session FROM external_client_bindings WHERE id=?', identity.binding.id).session,
    null,
  );
});
