#!/usr/bin/env node
/**
 * 双宿主无头控制面验收。会真实调用 Codex 与 Claude Code 并消耗模型额度。
 * 仅手动执行，不进 CI。默认使用系统临时目录；--live 复用当前真实服务与 work/dev 数据。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import which from 'which';
import { startServer, socketFor } from '../src/server.mjs';
import { discover } from '../src/launcher.mjs';
import { rpc } from '../src/rpc.mjs';
import { createExternalIdentity } from '../src/control-plane.mjs';
import { CONTROL_CAPABILITIES, CONTROL_PROTOCOL_VERSION } from '../src/control-capabilities.mjs';
import { Store } from '../src/store.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const cli = join(repo, 'src/cli.mjs');
const live = process.argv.includes('--live');
const root = live ? repo : mkdtempSync(join(tmpdir(), 'agent-team-headless-real-'));
const workspace = join(root, 'workspace');
const liveWorkspace = live ? repo : workspace;
const data = live ? join(repo, 'work', 'dev') : join(root, 'data');
const hostsFile = live ? null : join(root, 'hosts.json');
const marker = `ACK_${Date.now()}`;
const lastMessageFile = join(root, live ? 'docs' : '', `headless-control-${live ? 'live-' : ''}${marker}-last-message.txt`);
const reportFile = join(root, live ? 'docs' : '', `headless-control-${live ? 'live-' : ''}${marker}.json`);
if (live) {
  const instance = await discover(data);
  if (!instance) throw new Error(`真实开发服务未运行：${data}`);
  console.log(`[acceptance] live runtime: ${instance.url} · ${data}`);
} else {
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  mkdirSync(data, { recursive: true, mode: 0o700 });
  writeFileSync(join(workspace, 'README.md'), [
    '# 双宿主验收',
    '',
    `验收标记：${marker}`,
    '',
    '这是隔离验收工作区，请只读取，不要修改。',
  ].join('\n'));
  writeFileSync(hostsFile, JSON.stringify({
    hosts: { claude: { adapter: 'claude' } },
  }, null, 2));
}

const timeoutMs = 8 * 60 * 1000;
const result = {
  mode: live ? 'live' : 'isolated',
  startedAt: new Date().toISOString(),
  marker,
  root,
  workspace: liveWorkspace,
  data,
  steps: {},
  ok: false,
};
let server;
let store;
let bindingId = null;

function writeReport() {
  result.endedAt = new Date().toISOString();
  writeFileSync(reportFile, JSON.stringify(result, null, 2));
}

function update(step, value) {
  result.steps[step] = value;
  console.log(`[acceptance] ${step}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

function inlineTomlTable(value) {
  return `{ ${Object.entries(value).map(([key, item]) => `${key} = ${JSON.stringify(item)}`).join(', ')} }`;
}

function runCodexExec(externalIdentity) {
  const command = which.sync('codex', { nothrow: true });
  if (!command) throw new Error('未找到 codex 命令');
  const node = process.execPath;
  const mcpArgs = [
    '--disable-warning=ExperimentalWarning',
    cli,
    'mcp',
    '--socket', server.socketPath,
    '--client', bindingId,
  ];
  const prompt = [
    '你正在执行 Agent Team 双宿主验收。只能使用 agent_team MCP 工具，不要使用 shell。',
    '先调用 control_protocol。',
    `然后调用 team_create：name="${live ? '真实环境' : '双宿主真实'}验收 ${marker}"，workspace=${JSON.stringify(liveWorkspace)}，members="Claude审阅=claude"，policy="read-only"，operationId="create-${marker}"。`,
    `再调用 team_send：向 "Claude审阅" 发送 "请读取 README.md，然后通过 send 工具向主 Agent 回复 ${marker}。不要修改文件。"，expectsReply=false。`,
    `成功后回复 TEAM_READY:<teamId>；失败时回复 TEST_ERROR:<错误内容>。`,
    '稍后如果 Agent Team 唤醒你并要求 control_inbox：先领取所有事件；如果看到 Claude 的验收标记，立即调用 team_tasks_set。tasks 参数必须传对象数组：[{"id":"acceptance-ack","text":"CODEX_WAKE_OK","state":"done"}]；不要把对象编码成字符串。写入后简短结束。',
  ].join('\n');
  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '--sandbox', 'danger-full-access',
    '--output-last-message', lastMessageFile,
    '-C', liveWorkspace,
    '-c', `mcp_servers.agent_team.command=${JSON.stringify(node)}`,
    '-c', `mcp_servers.agent_team.args=${JSON.stringify(mcpArgs)}`,
    '-c', `mcp_servers.agent_team.env=${inlineTomlTable({
      AGENT_TEAM_CLIENT_KEY: externalIdentity.key,
      AGENT_TEAM_CONTROL_PROTOCOL: String(CONTROL_PROTOCOL_VERSION),
    })}`,
    '-c', 'mcp_servers.agent_team.startup_timeout_sec=120',
    prompt,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: liveWorkspace,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buffer = '';
    let stderr = '';
    let threadId = null;
    child.stdout.on('data', chunk => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const line = buffer.slice(0, buffer.indexOf('\n')).trim();
        buffer = buffer.slice(buffer.indexOf('\n') + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line);
          threadId ??= event.thread_id ?? event.threadId ?? event.thread?.id ?? null;
          console.log(`[codex] ${event.type ?? 'event'}`);
        } catch {
          // JSONL malformed output is surfaced through the process exit/result.
        }
      }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12000); });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`codex exec 退出 ${code}: ${stderr.trim()}`));
      resolve({ threadId });
    });
  });
}

async function waitFor(predicate, label, budget = timeoutMs) {
  const end = Date.now() + budget;
  while (Date.now() < end) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`等待超时: ${label}`);
}

let identity;
try {
  if (live) {
    const instance = await discover(data);
    if (!instance) throw new Error(`真实开发服务未运行：${data}`);
    server = { url: instance.url, socketPath: socketFor(data), close: async () => {} };
    store = new Store(data);
  } else {
    server = await startServer({ directory: data, configFile: hostsFile });
    store = server.bus.store;
  }
  identity = createExternalIdentity(store, {
    principalName: `验收用户-${marker}`,
    bindingName: `${live ? 'live-' : ''}codex-${marker}`,
    host: 'codex',
    command: which.sync('codex', { nothrow: true }) ?? 'codex',
    declared: {
      capabilities: Object.values(CONTROL_CAPABILITIES),
      workspaceRoots: [liveWorkspace],
      policies: ['communication', 'read-only'],
    },
    probed: {
      capabilities: Object.values(CONTROL_CAPABILITIES),
      workspaceRoots: [liveWorkspace],
      policies: ['communication', 'read-only'],
    },
  });
  bindingId = identity.binding.id;
  update('server', { mode: result.mode, url: server.url, socket: server.socketPath });
  update('binding', { id: bindingId, principalId: identity.principal.id });

  const codexRun = await runCodexExec(identity);
  const firstMessage = readFileSync(lastMessageFile, 'utf8').trim();
  update('codexFirstMessage', firstMessage);
  if (!firstMessage.includes('TEAM_READY:')) throw new Error('Codex 未返回 TEAM_READY');

  const team = await waitFor(
    () => store.get(
      "SELECT * FROM team_lead_controllers WHERE controller_kind='external_agent' AND controller_id=? ORDER BY updated DESC LIMIT 1",
      identity.principal.id,
    ),
    '外部主控团队未创建',
    30000,
  );
  result.teamId = team.group_id;
  update('teamCreated', team.group_id);
  if (!codexRun.threadId) throw new Error('codex exec 未报告 thread ID');
  await rpc(server.socketPath, {
    op: 'bind_client_session',
    binding: bindingId,
    key: identity.key,
    session: codexRun.threadId,
    protocolVersion: CONTROL_PROTOCOL_VERSION,
  });
  const currentBinding = store.get('SELECT session FROM external_client_bindings WHERE id=?', bindingId);
  if (!currentBinding?.session) throw new Error('MCP 未自动发现 Codex thread');
  result.codexSession = currentBinding.session;
  update('codexSessionDiscovered', currentBinding.session);

  const delivery = await waitFor(
    () => store.get(
      "SELECT * FROM external_deliveries WHERE principal_id=? AND group_id=? AND state='pending' ORDER BY created LIMIT 1",
      identity.principal.id,
      team.group_id,
    ),
    'Claude 回复未进入外部收件箱',
  );
  update('deliveryQueued', { id: delivery.id, messageId: delivery.message_id });
  await waitFor(
    () => store.get('SELECT wake_state,wake_error FROM external_deliveries WHERE id=?', delivery.id)?.wake_state === 'sent',
    'Codex 主动唤醒未发送',
    5 * 60 * 1000,
  );
  update('wakeSent', true);
  await waitFor(
    () => store.get('SELECT state FROM external_deliveries WHERE id=?', delivery.id)?.state === 'delivered',
    'Codex 未通过 control_inbox 领取回复',
  );
  update('deliveryClaimed', true);
  await waitFor(
    () => store.get(
      "SELECT 1 FROM agent_tasks WHERE owner_id=? AND group_id=? AND tasks LIKE ?",
      identity.principal.id,
      team.group_id,
      '%CODEX_WAKE_OK%',
    ),
    'Codex 唤醒后未写入验收任务',
  );
  update('codexWakeTask', true);
  result.ok = true;
} catch (error) {
  result.error = error.message;
  console.error(`[acceptance] FAILED: ${error.stack ?? error.message}`);
  process.exitCode = 1;
} finally {
  writeReport();
  if (!live) try { await server?.close(); } catch { /* diagnostics already captured */ }
  else try { store?.close(); } catch { /* diagnostics already captured */ }
  console.log(`[acceptance] report: ${reportFile}`);
  if (result.ok) console.log('[acceptance] PASS');
}
