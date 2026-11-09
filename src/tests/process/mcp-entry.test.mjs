// 起真实子进程的用例:框架自己的 CLI 作为 MCP server,通过本地 socket 回连总线。
// 这类用例要启动 node、连 socket、完成 MCP 握手,对并发负载敏感;
// 单独成层并给足预算,不和纯内存的契约测试抢同一份 CPU。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../server.mjs';
import { rpc } from '../../rpc.mjs';
import { CONTEXT_SCHEMA_VERSION } from '../../information.mjs';

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
    rmSync(directory, { recursive: true, force: true });
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
