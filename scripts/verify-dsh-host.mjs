#!/usr/bin/env node
/**
 * DSH 双角色真宿主验收：外部主控（headless resume 唤醒）+ 成员宿主。
 * 会真实调用 DSH 与 Claude Code 并消耗模型额度；仅手动执行，不进 CI。
 * agent-team 数据与成员会话全部隔离在临时目录；主控会话因认证绑定真实
 * ~/.dsh（headless 走 credentials/环境体系），会在真实 DSH 会话列表留下
 * 一个明确命名的验收会话。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import which from 'which';
import { startServer } from '../src/server.mjs';
import { rpc } from '../src/rpc.mjs';
import { createExternalIdentity } from '../src/control-plane.mjs';
import { CONTROL_CAPABILITIES, CONTROL_PROTOCOL_VERSION } from '../src/control-capabilities.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const cli = join(repo, 'src/cli.mjs');
const root = mkdtempSync(join(tmpdir(), 'agent-team-dsh-verify-'));
const workspace = join(root, 'workspace');
const data = join(root, 'data');
const hostsFile = join(root, 'hosts.json');
const claudeConfigDirectory = join(homedir(), '.claude');
const dshCommand = which.sync('dsh', { nothrow: true }) ?? 'dsh';
const marker = `ACK_${Date.now()}`;
const reportFile = join(root, 'report.json');
const timeoutMs = 8 * 60 * 1000;

mkdirSync(workspace, { recursive: true, mode: 0o700 });
writeFileSync(join(workspace, 'README.md'), [
  '# DSH 双角色验收',
  '',
  `验收标记：${marker}`,
  '',
  '这是隔离验收工作区，请只读取，不要修改。',
].join('\n'));
writeFileSync(hostsFile, JSON.stringify({
  hosts: {
    claude: { adapter: 'claude', configDirectory: claudeConfigDirectory },
    dsh: { adapter: 'dsh' },
  },
}, null, 2));

const result = {
  startedAt: new Date().toISOString(),
  marker,
  root,
  workspace,
  steps: {},
  ok: false,
};
let server;
let store;
let controllerOverlay;

function writeReport() {
  result.endedAt = new Date().toISOString();
  writeFileSync(reportFile, JSON.stringify(result, null, 2));
}
function update(step, value) {
  result.steps[step] = value;
  console.log(`[verify] ${step}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
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

/** 主控回合：headless 一次性进程，--session-id 恢复续聊；进程退出即回合结束。 */
async function runDshTurn({ prompt, sessionId = null, expect = null }) {
  const args = ['--profile', 'headless', '--patch', controllerOverlay, '--json', '--approval-policy', 'never'];
  if (sessionId) args.push('--session-id', sessionId);
  args.push(prompt);
  const child = spawn(dshCommand, args, {
    cwd: workspace,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.on('error', () => {});
  let stderr = '';
  let sid = sessionId;
  let text = '';
  let endReason;
  let failure;
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8000); });
  createInterface({ input: child.stdout }).on('line', line => {
    let row;
    try { row = JSON.parse(line); } catch { return; }
    if (row.type === 'session' && row.sessionId) sid = row.sessionId;
    if (row.type === 'final' && typeof row.text === 'string') text = row.text;
    if (row.type === 'status' && row.phase === 'turn_end') endReason = row.reason?.kind;
    if (row.type === 'error') failure ??= new Error(row.message ?? row.error ?? 'DSH 回合失败');
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => resolve(code));
  });
  if (failure) throw failure;
  if (exitCode !== 0 || endReason !== 'completed') {
    throw new Error(stderr.trim() || (endReason ? `DSH 回合结束原因：${endReason}` : `DSH 退出 (${exitCode ?? 'unknown'})`));
  }
  update('dshTurn', { sessionId: sid, text: text.slice(0, 400) });
  if (expect && !text.includes(expect)) {
    throw new Error(`主控最终文本缺少 ${expect}：${text.slice(0, 400)}`);
  }
  return { sessionId: sid, text };
}

try {
  // 验收脚本可能跑在某宿主的 bash 子进程里：清掉宿主会话注入，避免 MCP shim
  // 把绑定会话覆盖成外层会话（DSH 自身只擦 DSH_*，其它宿主变量会透传）。
  for (const key of ['ZCODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'DSH_SESSION_ID']) {
    delete process.env[key];
  }
  // headless 一次性回合禁用 credentials 服务，密钥须从启动环境注入；
  // 这里从本机 credentials 存储读取（与凭据服务同源，只在本机使用、不打印）。
  try {
    const credentials = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8');
    const apiKey = /^\s*DEEPSEEK_API_KEY:\s*"?([^"\s]+)"?/m.exec(credentials)?.[1];
    if (apiKey) process.env.DEEPSEEK_API_KEY = apiKey;
    else update('dshApiKey', 'credentials 存储中没有 DEEPSEEK_API_KEY 记录');
  } catch (error) {
    update('dshApiKey', `读取失败: ${error.message}`);
  }
  server = await startServer({ directory: data, configFile: hostsFile });
  store = server.bus.store;
  update('server', { url: server.url, socket: server.socketPath });

  const identity = createExternalIdentity(store, {
    principalName: `验收用户-${marker}`,
    bindingName: `dsh-${marker}`,
    host: 'dsh',
    command: dshCommand,
    declared: {
      capabilities: Object.values(CONTROL_CAPABILITIES),
      workspaceRoots: [workspace],
      policies: ['communication', 'read-only'],
    },
    probed: {
      capabilities: Object.values(CONTROL_CAPABILITIES),
      workspaceRoots: [workspace],
      policies: ['communication', 'read-only'],
    },
  });
  update('binding', { id: identity.binding.id, principalId: identity.principal.id });

  // 主控 overlay：agent_team MCP server 指向本验收服务的控制面。
  controllerOverlay = join(root, 'controller.patch.json');
  writeFileSync(controllerOverlay, JSON.stringify([
    { insert: [{
      id: 'agent-team-mcp',
      name: '@deepseek-ai/dsh-mcp-client',
      config: {
        serverName: 'agent_team',
        transport: 'stdio',
        command: process.execPath,
        args: ['--disable-warning=ExperimentalWarning', cli, 'mcp', '--socket', server.socketPath, '--client', identity.binding.id],
        env: {
          AGENT_TEAM_CLIENT_KEY: identity.key,
          AGENT_TEAM_CONTROL_PROTOCOL: String(CONTROL_PROTOCOL_VERSION),
        },
        failOnStartupError: true,
        reconnect: { enabled: false },
      },
    }] },
  ]), { mode: 0o600 });

  const createPrompt = [
    '你正在执行 Agent Team 双宿主验收。只能使用 agent_team MCP 工具，不要使用 shell。',
    '先调用 control_protocol。',
    `然后调用 team_create：name="DSH 真实验收 ${marker}"，workspace=${JSON.stringify(workspace)}，members="Claude审阅=claude"，policy="read-only"，operationId="create-${marker}"。`,
    '不要调用 team_send。',
    '成功后回复 TEAM_READY:<teamId>；失败时回复 TEST_ERROR:<错误内容>。',
  ].join('\n');
  const created = await runDshTurn({ prompt: createPrompt, expect: 'TEAM_READY:' });
  update('controllerSession', created.sessionId);

  await rpc(server.socketPath, {
    op: 'bind_client_session',
    binding: identity.binding.id,
    key: identity.key,
    session: created.sessionId,
    protocolVersion: CONTROL_PROTOCOL_VERSION,
  });
  const bound = store.get('SELECT session FROM external_client_bindings WHERE id=?', identity.binding.id);
  if (!bound?.session) throw new Error('主控会话未绑定');
  update('controllerSessionBound', bound.session);

  await waitFor(
    () => store.get(
      "SELECT * FROM team_lead_controllers WHERE controller_kind='external_agent' AND controller_id=? ORDER BY updated DESC LIMIT 1",
      identity.principal.id,
    ),
    '外部主控团队未创建',
    30000,
  ).then(team => {
    result.teamId = team.group_id;
    update('teamCreated', team.group_id);
  });

  // 脚本直接验证主动唤醒：唤醒正文经 headless resume 注入空闲的主控会话。
  const wakeTest = await server.bus.controlTool(identity.binding.id, identity.key, 'control_wake_test', {});
  update('wakeTest', wakeTest?.wake ?? wakeTest);
  if (wakeTest?.wake?.state !== 'ready') throw new Error(`主动唤醒验证未就绪: ${JSON.stringify(wakeTest?.wake ?? wakeTest)}`);

  const sendPrompt = [
    `现在调用 team_send：向 "Claude审阅" 发送 "请读取 README.md，然后通过 send 工具向主 Agent 回复 ${marker}。不要修改文件。"，expectsReply=false。`,
    '成功后回复 SEND_OK:<messageId>；失败时回复 TEST_ERROR:<错误内容>。',
    `之后如果 Agent Team 再次唤醒你并要求 control_inbox：先领取所有事件；如果看到 Claude 的验收标记（${marker}），立即对该团队调用 team_tasks_set，tasks 参数必须传对象数组：[{"id":"acceptance-ack","text":"DSH_WAKE_OK","state":"done"}]；不要把对象编码成字符串。写入后简短结束。`,
  ].join('\n');
  await runDshTurn({ prompt: sendPrompt, sessionId: created.sessionId, expect: 'SEND_OK:' });

  const delivery = await waitFor(
    () => store.get(
      "SELECT * FROM external_deliveries WHERE principal_id=? AND group_id=? AND state='pending' ORDER BY created LIMIT 1",
      identity.principal.id,
      result.teamId,
    ),
    'Claude 回复未进入外部收件箱',
  );
  update('deliveryQueued', { id: delivery.id, messageId: delivery.message_id });

  await waitFor(
    () => store.get('SELECT wake_state FROM external_deliveries WHERE id=?', delivery.id)?.wake_state === 'sent',
    'DSH 主动唤醒未发送',
  );
  update('wakeSent', true);
  await waitFor(
    () => store.get('SELECT state FROM external_deliveries WHERE id=?', delivery.id)?.state === 'delivered',
    'DSH 主控未通过 control_inbox 领取回复',
  );
  update('deliveryClaimed', true);

  await waitFor(
    () => store.get(
      'SELECT 1 FROM agent_tasks WHERE owner_id=? AND group_id=? AND tasks LIKE ?',
      identity.principal.id,
      result.teamId,
      '%DSH_WAKE_OK%',
    ),
    'DSH 主控唤醒后未写入验收任务',
  );
  update('controllerWakeTask', true);
  result.scenario1 = 'pass';

  // ── 场景 2：DSH 作为成员宿主执行回合 ──
  const group = await server.bus.createGroup({
    name: `DSH 成员验收 ${marker}`,
    workspace,
    charter: '验收 DSH 成员宿主的回合执行。',
    policy: 'read-only',
    lead: { name: '主 Agent', host: 'claude' },
    members: [{ name: '执行者', host: 'dsh' }],
  });
  update('memberTeamCreated', group.id);
  const member = server.bus.members(group.id).find(row => row.name === '执行者');
  await rpc(server.socketPath, {
    op: 'directive',
    group: group.id,
    text: `请在团队里通过 send 工具向主 Agent 回复一句话：DSH_MEMBER_OK ${marker}。不要修改文件。`,
  });
  const memberDone = await waitFor(() => {
    const markerRow = store.get(
      "SELECT id FROM messages WHERE group_id=? AND sender=? AND kind='send' AND text LIKE ?",
      group.id,
      member.id,
      `%DSH_MEMBER_OK ${marker}%`,
    );
    if (!markerRow) return null;
    return store.get(
      "SELECT state FROM turns WHERE group_id=? AND executor_kind='member' AND executor_id=? AND state='completed' ORDER BY created DESC LIMIT 1",
      group.id,
      member.id,
    );
  }, 'DSH 成员未回复验收标记或回合未完成');
  update('memberReplied', { turnState: memberDone.state });
  result.scenario2 = 'pass';
  result.ok = true;
} catch (error) {
  result.error = error.message;
  console.error(`[verify] FAILED: ${error.stack ?? error.message}`);
  process.exitCode = 1;
} finally {
  writeReport();
  try { await server?.close(); } catch { /* diagnostics captured */ }
  try { store?.close(); } catch { /* diagnostics captured */ }
  console.log(`[verify] report: ${reportFile}`);
  if (result.ok) console.log('[verify] PASS');
}
