#!/usr/bin/env node
/**
 * ZCode 双角色真宿主验收：外部主控（主动唤醒）+ 成员宿主（回合执行）。
 * 会真实调用 ZCode 与 Claude Code 并消耗模型额度；仅手动执行，不进 CI。
 * 全程使用隔离临时目录：agent-team 数据与 ZCode HOME 都不触碰真实运行数据。
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.mjs';
import { rpc } from '../src/rpc.mjs';
import { createExternalIdentity } from '../src/control-plane.mjs';
import { CONTROL_CAPABILITIES, CONTROL_PROTOCOL_VERSION } from '../src/control-capabilities.mjs';
import { createZcodeProtocol, headlessInteractionReply } from '../src/member/zcode/protocol.mjs';

// 若验收脚本跑在注入了文件访问 shim 的外围宿主环境里，NODE_OPTIONS 会随
// process.env 透传给 zcode/包装子进程，导致读真实配置被拦截。验收需要读本机
// ZCode 配置，这里清掉注入项（仅影响本脚本派生的子进程，不改外围环境）。
if (process.env.NODE_OPTIONS?.includes('sandbox-center-runtime-kit')) delete process.env.NODE_OPTIONS;

const repo = fileURLToPath(new URL('..', import.meta.url));
const cli = join(repo, 'src/cli.mjs');
const root = mkdtempSync(join(tmpdir(), 'agent-team-zcode-verify-'));
const workspace = join(root, 'workspace');
const data = join(root, 'data');
const hostsFile = join(root, 'hosts.json');
const zcodeHome = join(root, 'zcode-home');
const claudeConfigDirectory = join(homedir(), '.claude');
const zcodeAppEntry = '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';
const zcodeAppProvider = '/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json';
const zcodeRealV2 = join(homedir(), '.zcode', 'v2');
const zcodeLaunchRoot = join(root, 'zcode-launch');
// 复制入口到隔离目录，并把新版 app 的 provider 配置迁回 cjs 期望的 <入口>/provider/ 布局。
const zcodeEntry = join(zcodeLaunchRoot, 'glm', 'zcode.cjs');
// 包装脚本：以系统 node 直接跑复制的入口，绕开 Electron 对 ELECTRON_RUN_AS_NODE 的限制。
const zcodeLauncher = join(root, 'zcode-app-server');
const marker = `ACK_${Date.now()}`;
const reportFile = join(root, 'report.json');
const timeoutMs = 8 * 60 * 1000;

mkdirSync(workspace, { recursive: true, mode: 0o700 });
mkdirSync(join(zcodeHome, '.zcode', 'cli'), { recursive: true, mode: 0o700 });
writeFileSync(join(workspace, 'README.md'), [
  '# ZCode 双角色验收',
  '',
  `验收标记：${marker}`,
  '',
  '这是隔离验收工作区，请只读取，不要修改。',
].join('\n'));
writeFileSync(hostsFile, JSON.stringify({
  hosts: {
    claude: { adapter: 'claude', configDirectory: claudeConfigDirectory },
    zcode: { adapter: 'zcode' },
  },
}, null, 2));

/**
 * 构造本机可运行的 app-server 启动环境。本机 ZCode.app 升级后有两处不兼容，
 * 均在隔离临时目录内解决，不改动真实安装：
 * 1. Electron 二进制拒绝 ELECTRON_RUN_AS_NODE=1（"invoked by other apps"）——
 *    改用系统 node 直接执行复制的 zcode.cjs。
 * 2. cjs 仍按旧布局找 <入口>/provider/zcode-builtin.json，新版 app 已移到
 *    Contents/Resources/config/provider/ —— 把配置复制到入口旁旧路径。
 * 返回 { command, args, env }，供主控会话使用；同时通过 AGENT_TEAM_ZCODE_COMMAND
 * 让成员宿主与主动唤醒驱动走同一启动出口（resolveZcodeLaunch 读取该覆盖）。
 */
function prepareZcodeLaunch() {
  if (!existsSync(zcodeAppEntry)) throw new Error(`未找到 ZCode 入口: ${zcodeAppEntry}`);
  const entryDir = dirname(zcodeEntry);
  mkdirSync(join(entryDir, 'provider'), { recursive: true, mode: 0o700 });
  copyFileSync(zcodeAppEntry, zcodeEntry);
  if (!existsSync(zcodeAppProvider)) throw new Error(`未找到 ZCode provider 配置: ${zcodeAppProvider}`);
  copyFileSync(zcodeAppProvider, join(entryDir, 'provider', 'zcode-builtin.json'));
  // cjs 依赖同目录 node-runtime（内置 npm 等）；指向真实安装即可，避免整个复制。
  const runtime = join(dirname(zcodeAppEntry), 'node-runtime');
  if (existsSync(runtime)) {
    try { symlinkSync(runtime, join(entryDir, 'node-runtime'), 'dir'); } catch { /* 已存在 */ }
  }
  // 包装脚本收到 ['app-server','--stdio',...]，转成系统 node 执行复制入口。
  // 它还负责给隔离 HOME 补齐最小配置层（provider/凭据/默认模型选择），否则
  // session 模型不在 Provider Registry。补齐下沉到启动出口，主控会话、成员
  // endpoint、唤醒三条路径（各自 HOME 不同）都能覆盖。真实 v2 路径硬编码写入，
  // 因为隔离 HOME 下 homedir() 会指向临时目录。
  writeFileSync(zcodeLauncher, [
    '#!/usr/bin/env node',
    `import { spawn } from 'node:child_process';`,
    `import { copyFileSync, existsSync, mkdirSync } from 'node:fs';`,
    `import { join } from 'node:path';`,
    `const realV2 = ${JSON.stringify(zcodeRealV2)};`,
    `const home = process.env.HOME;`,
    `if (home && home !== ${JSON.stringify(homedir())}) {`,
    '  const isoV2 = join(home, \'.zcode\', \'v2\');',
    '  if (!existsSync(join(isoV2, \'provider_config.json\')) && existsSync(realV2)) {',
    '    mkdirSync(isoV2, { recursive: true, mode: 0o700 });',
    `    for (const name of ['provider_config.json', 'credentials.json', 'credential-source', 'setting.json', 'config.json', 'onboarding-record.json']) {`,
    '      const src = join(realV2, name);',
    '      if (existsSync(src)) copyFileSync(src, join(isoV2, name));',
    '    }',
    '  }',
    '}',
    `const child = spawn(process.execPath, [${JSON.stringify(zcodeEntry)}, ...process.argv.slice(2)], {`,
    "  stdio: 'inherit',",
    '  env: process.env,',
    '});',
    `child.on('error', error => { console.error(error); process.exit(1); });`,
    `child.on('exit', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exit(code ?? 0); });`,
  ].join('\n'), { mode: 0o700 });
  // 成员宿主与唤醒驱动经 resolveZcodeLaunch 读取该覆盖，统一走系统 node 启动。
  process.env.AGENT_TEAM_ZCODE_COMMAND = zcodeLauncher;
  update('zcodeLauncher', { launcher: zcodeLauncher, entry: zcodeEntry });
  return { command: zcodeLauncher, args: [], env: {} };
}

const result = {
  startedAt: new Date().toISOString(),
  marker,
  root,
  workspace,
  zcodeHome,
  steps: {},
  ok: false,
};
let server;
let store;

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

/** 打开主控会话客户端：隔离 HOME 下的 app-server，创建会话、授信、订阅，保持连接。 */
async function openControllerSession() {
  const state = { sessionId: null, text: '', resolveTurn: null };
  state.turnDone = new Promise(resolve => { state.resolveTurn = resolve; });
  const protocol = createZcodeProtocol({
    command: zcodeLauncher,
    // 包装脚本补上复制入口后用系统 node 执行；绕开 Electron 的 ELECTRON_RUN_AS_NODE 限制。
    args: ['app-server', '--stdio', '--cwd', workspace],
    env: { HOME: zcodeHome },
    onRequest: headlessInteractionReply,
    onNotification(row) {
      if (row.method !== 'session/event' || row.params?.sessionId !== state.sessionId) return;
      if (row.params.type === 'turn.completed') {
        if (typeof row.params.payload?.response === 'string') state.text = row.params.payload.response;
        state.resolveTurn(row.params.payload ?? {});
      }
    },
  });
  await protocol.ready;
  const created = await protocol.request('session/create', {
    workspace: { workspacePath: workspace, workspaceKey: workspace },
    persistence: 'immediate',
  }, { timeout: 60000 });
  state.sessionId = created?.session?.sessionId;
  if (!state.sessionId) throw new Error('主控会话创建未返回 sessionId');
  await protocol.request('session/setThoughtLevel', { sessionId: state.sessionId, thoughtLevel: 'low' }, { timeout: 30000 });
  // 无头协议会话里没有审批界面：对 agent_team MCP server 做 workspace 授信。
  const workspaceRef = { workspacePath: workspace, workspaceKey: workspace };
  const listed = await protocol.request('mcp/list', { workspace: workspaceRef }, { timeout: 30000 });
  const agentServer = listed?.statuses?.agent_team;
  const trust = agentServer?.workspaceTrust;
  if (agentServer && trust?.declarationDigest && trust.trusted !== true) {
    const granted = await protocol.request('workspace/mcp/trust', {
      workspace: workspaceRef,
      serverName: 'agent_team',
      declarationDigest: trust.declarationDigest,
      trusted: true,
    }, { timeout: 30000 });
    update('mcpTrusted', granted ?? { accepted: 'missing' });
  } else {
    update('mcpTrusted', { skipped: !agentServer ? 'server-missing' : 'already-trusted' });
  }
  await protocol.request('session/subscribe', { sessionId: state.sessionId, deliveryKind: 'desktop-continuous' }, { timeout: 30000 });
  return {
    sessionId: state.sessionId,
    async sendTurn(prompt, { expect = null, budget = timeoutMs } = {}) {
      state.text = '';
      state.resolveTurn = null;
      const turnDone = new Promise(resolve => { state.resolveTurn = resolve; });
      const accepted = await protocol.request('session/send', { sessionId: state.sessionId, content: prompt }, { timeout: 60000 });
      if (accepted?.accepted === false) throw new Error('主控会话拒绝回合输入');
      await Promise.race([
        turnDone,
        new Promise((_, reject) => setTimeout(() => reject(new Error('主控回合超时')), budget)),
      ]);
      update('controllerTurn', { sessionId: state.sessionId, text: state.text.slice(0, 400) });
      if (expect && !state.text.includes(expect)) {
        throw new Error(`主控最终文本缺少 ${expect}：${state.text.slice(0, 400)}`);
      }
      return state.text;
    },
    async close() {
      await protocol.stop();
    },
  };
}

try {
  // 唤醒实例的 ZCode 数据目录走专用重定向；不再劫持脚本全局 HOME（claude 等宿主依赖真实 HOME）。
  process.env.AGENT_TEAM_ZCODE_HOME = zcodeHome;
  // 验收脚本可能跑在某宿主的 bash 子进程里：清掉宿主会话注入，模拟独立用户环境。
  for (const key of ['ZCODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID']) {
    delete process.env[key];
  }
  prepareZcodeLaunch();
  server = await startServer({ directory: data, configFile: hostsFile });
  store = server.bus.store;
  update('server', { url: server.url, socket: server.socketPath });

  const identity = createExternalIdentity(store, {
    principalName: `验收用户-${marker}`,
    bindingName: `zcode-${marker}`,
    host: 'zcode',
    command: zcodeLauncher,
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

  // 隔离 ZCode 配置：agent_team MCP server 指向本验收服务的控制面。
  writeFileSync(join(zcodeHome, '.zcode', 'cli', 'config.json'), JSON.stringify({
    mcp: {
      servers: {
        agent_team: {
          command: process.execPath,
          args: ['--disable-warning=ExperimentalWarning', cli, 'mcp', '--socket', server.socketPath, '--client', identity.binding.id],
          env: {
            AGENT_TEAM_CLIENT_KEY: identity.key,
            AGENT_TEAM_CONTROL_PROTOCOL: String(CONTROL_PROTOCOL_VERSION),
          },
        },
      },
    },
  }, null, 2), { mode: 0o600 });

  // 主控流程拆成三段：先建会话并绑定（binding.session 必须在派发前就绪），
  // 脚本直接跑 control_wake_test（会话空闲，无回合内自唤醒死锁），再驱动 team_send。
  const controller = await openControllerSession();
  update('controllerSession', controller.sessionId);

  await rpc(server.socketPath, {
    op: 'bind_client_session',
    binding: identity.binding.id,
    key: identity.key,
    session: controller.sessionId,
    protocolVersion: CONTROL_PROTOCOL_VERSION,
  });
  const bound = store.get('SELECT session FROM external_client_bindings WHERE id=?', identity.binding.id);
  if (!bound?.session) throw new Error('主控会话未绑定');
  update('controllerSessionBound', bound.session);

  const createPrompt = [
    '你正在执行 Agent Team 双宿主验收。只能使用 agent_team MCP 工具，不要使用 shell。',
    '先调用 control_protocol。',
    `然后调用 team_create：name="ZCode 真实验收 ${marker}"，workspace=${JSON.stringify(workspace)}，members="Claude审阅=claude"，policy="read-only"，operationId="create-${marker}"。`,
    '不要调用 team_send。',
    '成功后回复 TEAM_READY:<teamId>；失败时回复 TEST_ERROR:<错误内容>。',
  ].join('\n');
  await controller.sendTurn(createPrompt, { expect: 'TEAM_READY:' });
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

  // 脚本直接验证主动唤醒：唤醒正文注入空闲的主控会话，等真实回合跑完。
  const wakeTest = await server.bus.controlTool(identity.binding.id, identity.key, 'control_wake_test', {});
  update('wakeTest', wakeTest?.wake ?? wakeTest);
  if (wakeTest?.wake?.state !== 'ready') throw new Error(`主动唤醒验证未就绪: ${JSON.stringify(wakeTest?.wake ?? wakeTest)}`);

  const sendPrompt = [
    `现在调用 team_send：向 "Claude审阅" 发送 "请读取 README.md，然后通过 send 工具向主 Agent 回复 ${marker}。不要修改文件。"，expectsReply=false。`,
    '成功后回复 SEND_OK:<messageId>；失败时回复 TEST_ERROR:<错误内容>。',
    `之后如果 Agent Team 再次唤醒你并要求 control_inbox：先领取所有事件；如果看到 Claude 的验收标记（${marker}），立即对该团队调用 team_tasks_set，tasks 参数必须传对象数组：[{"id":"acceptance-ack","text":"ZCODE_WAKE_OK","state":"done"}]；不要把对象编码成字符串。写入后简短结束。`,
  ].join('\n');
  await controller.sendTurn(sendPrompt, { expect: 'SEND_OK:' });
  await controller.close();

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
    'ZCode 主动唤醒未发送',
  );
  update('wakeSent', true);
  await waitFor(
    () => store.get('SELECT state FROM external_deliveries WHERE id=?', delivery.id)?.state === 'delivered',
    'ZCode 主控未通过 control_inbox 领取回复',
  );
  update('deliveryClaimed', true);

  await waitFor(
    () => store.get(
      'SELECT 1 FROM agent_tasks WHERE owner_id=? AND group_id=? AND tasks LIKE ?',
      identity.principal.id,
      result.teamId,
      '%ZCODE_WAKE_OK%',
    ),
    'ZCode 主控唤醒后未写入验收任务',
  );
  update('controllerWakeTask', true);
  result.scenario1 = 'pass';

  // ── 场景 2：ZCode 作为成员宿主执行回合 ──
  const group = await server.bus.createGroup({
    name: `ZCode 成员验收 ${marker}`,
    workspace,
    charter: '验收 ZCode 成员宿主的回合执行。',
    policy: 'read-only',
    lead: { name: '主 Agent', host: 'claude' },
    members: [{ name: '执行者', host: 'zcode' }],
  });
  update('memberTeamCreated', group.id);
  const member = server.bus.members(group.id).find(row => row.name === '执行者');
  try {
    const catalog = await server.bus.modelCatalog({ refresh: true });
    const zcodeCatalog = catalog.hosts.find(item => item.host === 'zcode' && item.ok && item.catalog);
    const deepseek = zcodeCatalog?.catalog.models.find(item => item.id === 'deepseek-v4-flash');
    if (deepseek) {
      await server.bus.setMemberModel(group.id, member.id, {
        model: deepseek.id,
        model_provider: deepseek.provider ?? null,
        reasoning_effort: 'low',
      });
      update('memberModelPinned', { model: deepseek.id, effort: 'low' });
    }
  } catch (error) {
    update('memberModelPinned', `skipped: ${error.message}`);
  }
  await rpc(server.socketPath, {
    op: 'directive',
    group: group.id,
    text: `请在团队里通过 send 工具向主 Agent 回复一句话：ZCODE_MEMBER_OK ${marker}。不要修改文件。`,
  });
  // 回合与消息无直接外键：标记消息可见且成员存在已完成回合，即视为一次完整执行。
  const memberDone = await waitFor(() => {
    const markerRow = store.get(
      "SELECT id FROM messages WHERE group_id=? AND sender=? AND kind='send' AND text LIKE ?",
      group.id,
      member.id,
      `%ZCODE_MEMBER_OK ${marker}%`,
    );
    if (!markerRow) return null;
    return store.get(
      "SELECT state FROM turns WHERE group_id=? AND executor_kind='member' AND executor_id=? AND state='completed' ORDER BY created DESC LIMIT 1",
      group.id,
      member.id,
    );
  }, 'ZCode 成员未回复验收标记或回合未完成');
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
