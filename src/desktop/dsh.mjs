// DSH Desktop 垂直切片:激活连接 + 手动 Profile 桥接凭据 + 验证策略。
// 实测事实(交接文档):DSH Desktop 的 Desktop Profile 能桥接 stdio MCP,但
// 配置存在应用私有存储里(非明文文件),安装只能给出凭据由用户在 Profile UI
// 里粘贴;MCP 子进程拿不到 DSH_SESSION_ID,会话身份须 bind_client_session 显式
// 绑定;Desktop `standard` preset 的 one-shot headless resume 无法唤醒——
// Desktop 专属唤醒桥是真宿主验收的未知项, wake 能力保持已声明、验证说话。
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createExternalIdentity } from '../control-plane.mjs';
import { nodeRunner } from '../runtime.mjs';
import { disableBinding } from '../aggregates/external-control.mjs';
import { dshProcessEnv } from '../hosts/dsh/credentials.mjs';

const CONTROL_MCP_NAME = 'agent_team';

/** DSH Desktop Profile 桥接的 stdio MCP 配置:用户粘贴进 Profile UI。 */
export function dshDesktopMcpConfig({ socketPath, bindingId, clientKey, runner = nodeRunner(), cliPath = fileURLToPath(new URL('../cli.mjs', import.meta.url)) }) {
  return {
    serverName: CONTROL_MCP_NAME,
    transport: 'stdio',
    command: runner.command,
    args: ['--disable-warning=ExperimentalWarning', cliPath, 'mcp', '--socket', socketPath, '--client', bindingId],
    env: { AGENT_TEAM_CLIENT_KEY: clientKey, AGENT_TEAM_CONTROL_PROTOCOL: '1' },
  };
}

/**
 * 安装 DSH Desktop 集成。Profile 存储不是明文文件,框架不代写:创建激活连接
 * 并返回要粘贴进 Desktop Profile 的 MCP 配置(含凭据,用户自己的机器)。
 */
export async function installDshDesktopIntegration(store, {
  principalName = '本机用户',
  detections,
  socketPath,
  runner = nodeRunner(),
  cliPath = fileURLToPath(new URL('../cli.mjs', import.meta.url)),
} = {}) {
  if (!socketPath) throw new Error('桌面接入安装需要总线 socket 路径');
  const detected = detections?.find?.(item => item.kind === 'dsh' && item.found);
  if (!detected) throw new Error('未检测到 DSH Desktop 安装;请先安装桌面应用再接入');

  const identity = createExternalIdentity(store, {
    principalName,
    bindingName: 'DSH Desktop 接入',
    host: 'dsh',
    session: null,
    declared: {
      capabilities: ['session.deliver', 'turn.observe', 'session.wake', 'user.elicit', 'user.notify'],
      workspaceRoots: [homedir()],
      policies: ['communication', 'read-only', 'workspace-write'],
    },
    surface: 'desktop',
    appId: detected.applicationId,
    bindingKind: 'activation',
  });
  return {
    applicationId: detected.applicationId,
    binding: {
      id: identity.binding.id,
      name: identity.binding.name,
      bindingKind: 'activation',
      surface: 'desktop',
      host: identity.binding.host,
    },
    socketPath,
    manual: true,
    mcpConfig: dshDesktopMcpConfig({ socketPath, bindingId: identity.binding.id, clientKey: identity.key, runner, cliPath }),
    enginePath: detected.enginePath,
    engineVersion: detected.engineVersion,
    limitations: [
      'Desktop Profile 的 MCP 配置存在应用私有存储,需要把返回的 mcpConfig 手动粘贴到 Profile UI。',
      'MCP 子进程不带会话身份:每个桌面会话要用 bind-session 显式绑定后才能执行工具。',
      'Desktop standard preset 的主动唤醒桥未验证;唤醒能力以 control_wake_test 的真实结果为准。',
    ],
    nextStep: '把 mcpConfig 粘贴进 DSH Desktop Profile 的 MCP 设置;在桌面会话内调用 Agent Team Skill 并用 bind-session 绑定会话。',
  };
}

// --- 验证策略(真实运行消耗模型额度;由额度确认门保护) -----------------------

const CONTROLLER_CHECK_PROMPT = '你是 Agent Team 桌面接入验证会话。调用一次 control_protocol 工具,把返回 JSON 里的 version 数字原样写在最终回复里,不要做其他事情。';
const ENGINE_CHECK_PROMPT = '只回复两个字符:OK';

/** 最小 DSH 补丁:会话与存储落框架私有目录,沙箱只读,审批关闭。 */
function dshVerificationPatch({ workspace, mcp = null } = {}) {
  const overlay = [
    { id: 'session-persistence-jsonl', config: { root: join(workspace, 'host-sessions') } },
    { id: 'storage-json', config: { root: join(workspace, 'host-storage') } },
    { id: 'sandbox-policy', config: { mode: 'workspace-write', workspaceRoot: workspace } },
    { id: 'approval', config: { policy: 'never' } },
    { id: 'permission', config: { presets: { team: { sandbox: 'workspace-write', approval: 'never' } }, defaultPreset: 'team' } },
  ];
  if (mcp) {
    overlay.push({
      insert: [{
        id: `${CONTROL_MCP_NAME}-mcp`,
        name: '@deepseek-ai/dsh-mcp-client',
        config: { ...mcp, failOnStartupError: true, reconnect: { enabled: false } },
      }],
    });
  }
  return overlay;
}

async function runDshHeadlessTurn({ enginePath, workspace, spawnTracked, timeoutMs, patch, prompt, env }) {
  const patchFile = join(workspace, `dsh-verify-${randomUUID().slice(0, 8)}.json`);
  writeFileSync(patchFile, JSON.stringify(patch), { mode: 0o600 });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('验证回合超时')), timeoutMs);
      const child = spawnTracked(enginePath, ['headless', '--patch', patchFile, '--json', prompt], { cwd: workspace, env });
      let output = '';
      child.stdout?.on('data', chunk => { output = (output + chunk).slice(-4000); });
      child.stderr?.on('data', chunk => { output = (output + chunk).slice(-4000); });
      child.on('close', code => {
        clearTimeout(timer);
        if (code === 0) return resolve(output);
        // --json 流的错误结论(final/exit 原因)是验证失败的真实原因,必须透传。
        const failure = extractDshFailure(output);
        reject(new Error(failure ?? `内嵌引擎退出 (${code})`));
      });
      child.on('error', error => {
        clearTimeout(timer);
        reject(new Error(`无法启动内嵌引擎: ${error.message}`));
      });
    });
  } finally {
    rmSync(patchFile, { force: true, maxRetries: 3, retryDelay: 50 });
  }
}

/** 从 --json 流/错误输出里提取引擎的失败原因(如 MISSING_CREDENTIAL)。 */
function extractDshFailure(output) {
  if (!output) return null;
  for (const line of output.split('\n').reverse()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      const reason = row?.reason ?? row?.error;
      const message = typeof reason === 'object' ? reason?.error?.message ?? reason?.message : reason;
      if (message) return String(message).slice(0, 400);
    } catch {
      if (trimmed.startsWith('dsh:')) return trimmed.slice(0, 400);
    }
  }
  return null;
}

export function dshDesktopVerification({ credentialsPath, baseEnv = process.env } = {}) {
  // DSH headless 禁用凭据服务,key 只能从启动环境注入。与宿主适配器同源:
  // 优先沿用当前环境,否则从 ~/.dsh/.credentials.yaml 补齐。缺了这一步,
  // 验证回合会以 MISSING_CREDENTIAL 失败,把可用的应用误判为不可用。
  const engineEnv = () => dshProcessEnv(baseEnv, credentialsPath);
  return {
    async verifyEngine({ workspace, detection, spawnTracked, timeoutMs }) {
      const output = await runDshHeadlessTurn({
        enginePath: detection.enginePath,
        workspace,
        spawnTracked,
        timeoutMs,
        patch: dshVerificationPatch({ workspace }),
        prompt: ENGINE_CHECK_PROMPT,
        env: engineEnv(),
      });
      return { ok: /ok/i.test(output), detail: '内嵌引擎完成短任务' };
    },
    async verifyController({ store, workspace, detection, spawnTracked, socketPath, timeoutMs }) {
      if (!socketPath) return { ok: false, reason: '总线 socket 不可用,无法配置验证 MCP' };
      const temp = createExternalIdentity(store, {
        principalName: 'Agent Team 验证',
        bindingName: `dsh-desktop-verify-${randomUUID().slice(0, 8)}`,
        host: 'dsh',
        declared: {
          capabilities: ['session.deliver', 'turn.observe'],
          workspaceRoots: [homedir()],
          policies: ['read-only'],
        },
        surface: 'desktop',
      });
      try {
        const output = await runDshHeadlessTurn({
          enginePath: detection.enginePath,
          workspace,
          spawnTracked,
          timeoutMs,
          patch: dshVerificationPatch({
            workspace,
            mcp: dshDesktopMcpConfig({ socketPath, bindingId: temp.binding.id, clientKey: temp.key }),
          }),
          prompt: CONTROLLER_CHECK_PROMPT,
          env: engineEnv(),
        });
        return { ok: /version|1/.test(output), detail: '主控工具可调用' };
      } finally {
        disableBinding(store, temp.binding.id);
      }
    },
  };
}
