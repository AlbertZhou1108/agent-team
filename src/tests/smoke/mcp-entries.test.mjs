import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../server.mjs';
import { rpc } from '../../rpc.mjs';
import { CONTEXT_SCHEMA_VERSION } from '../../information.mjs';
import { createExternalIdentity } from '../../control-plane.mjs';
import { CONTROL_CAPABILITIES } from '../../control-capabilities.mjs';
import { fakeHost } from '../support/fixture.mjs';

describe('mcp-entry', () => {
const cliPath = fileURLToPath(new URL('../../cli.mjs', import.meta.url));

async function until(fn, message = 'condition timed out', budgetMs = 30000) {
  const end = Date.now() + budgetMs;
  while (!fn()) {
    if (Date.now() > end) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function mcpExchange({ socketPath, endpoint, key, turnId }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, 'mcp', '--socket', socketPath, '--endpoint', endpoint], {
      env: {
        ...process.env,
        AGENT_TEAM_KEY: key,
        ...(turnId ? { AGENT_TEAM_TURN: turnId } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const answers = new Map();
    let buffer = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('MCP exchange timed out'));
    }, 30000);
    const finish = () => {
      if (!answers.has('tools') || !answers.has('call')) return;
      clearTimeout(timer);
      child.kill();
      resolve({ tools: answers.get('tools'), call: answers.get('call') });
    };
    child.stdout.on('data', chunk => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const line = buffer.slice(0, buffer.indexOf('\n'));
        buffer = buffer.slice(buffer.indexOf('\n') + 1);
        if (!line.trim()) continue;
        const row = JSON.parse(line);
        if (row.id === 1) {
          answers.set('tools', row);
          child.stdin.write(JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'read', arguments: { limit: 5 } },
          }) + '\n');
        } else if (row.id === 2) {
          answers.set('call', row);
        }
        finish();
      }
    });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) + '\n');
  });
}

test('real RPC/MCP entry returns the same bounded projection and keeps authentication', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-info-mcp-'));
  let server;
  const captures = {};
  const host = {
    async run(context) {
      context.onSession(context.endpoint.session ?? `native-${context.endpoint.id}`);
      if (context.endpoint.context === 'profile') {
        context.onAccepted();
        return 'profile';
      }
      if (context.endpoint.context.startsWith('pair:') && !captures.done) {
        const direct = await server.bus.tool(
          context.endpoint.id,
          context.endpoint.key,
          'read',
          { limit: 5 },
          { turnId: context.turnId },
        );
        const exchange = await mcpExchange({
          socketPath: server.socketPath,
          endpoint: context.endpoint.id,
          key: context.endpoint.key,
          turnId: context.turnId,
        });
        captures.direct = direct;
        captures.exchange = exchange;
        captures.call = JSON.parse(exchange.call.result.content[0].text);
        captures.done = true;
      }
      context.onAccepted();
      return 'done';
    },
  };
  server = await startServer({ directory, hosts: new Map([['fake', host]]) });
  t.after(async () => {
    await server.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  });
  const group = await rpc(server.socketPath, {
    op: 'new',
    args: {
      name: 'mcp team',
      workspace: directory,
      lead: { name: 'lead', host: 'fake' },
      members: [{ name: 'one', host: 'fake' }],
    },
  });
  await until(() => server.bus.running.size === 0);
  const [lead, one] = server.bus.members(group.id);
  const snapshot = server.bus.store.endpoint(lead.id, 'coordination');
  await server.bus.tool(snapshot.id, snapshot.key, 'send', { to: one.id, text: 'MCP projection 🧪' });
  await until(() => captures.done, 'MCP capture timed out');
  assert.equal(captures.exchange.call.result.isError, false);
  assert.deepEqual(captures.call, captures.direct);
  assert.equal(captures.call.schema, CONTEXT_SCHEMA_VERSION);
  assert.equal(captures.call.view, 'bounded');
  assert.ok(captures.call.messages.some(message => message.preview.includes('MCP projection')));
  assert.ok(captures.call.messages.every(message => !Object.hasOwn(message, 'text')));
  const listed = captures.exchange.tools.result.tools.find(tool => tool.name === 'read');
  assert.ok(listed.inputSchema.properties.messageId);
  assert.ok(listed.inputSchema.properties.bodyLimit);
  assert.equal(listed.inputSchema.properties.offset.minimum, 0);
  await assert.rejects(
    rpc(server.socketPath, { op: 'tool', endpoint: snapshot.id, key: 'wrong-key', name: 'read', args: {} }),
    /来源无效/,
  );
});
});

describe('control-mcp-entry', () => {
const cliPath = fileURLToPath(new URL('../../cli.mjs', import.meta.url));

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
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
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
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
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
});
