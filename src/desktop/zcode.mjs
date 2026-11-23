// ZCode Desktop 垂直切片:~/.zcode/cli/config.json 受管条目安装与验证策略。
//
// 会话身份模型:ZCode 桌面 MCP 子进程不注入会话 id(bash 子进程有
// ZCODE_SESSION_ID 兜底),与 DSH 同走 manual 通道——桌面会话经 bind-session
// 显式绑定后才有独立会话连接,未绑定的裸调用回落最近绑定或被拒。
// 主动唤醒走已验证的 app-server 协议(resume + send + turn 事件),所以激活
// 连接声明 session.wake(不同于 Claude 的 Pull-only)。
//
// 桌面 MCP 配置源与成员适配器同一份:~/.zcode/cli/config.json 的
// mcp.servers(stdio 形状一致,2026-11-20 实机核对)。引擎是 bundle 内的
// glm/zcode.cjs,启动与 provider 配置布局由 member/zcode/wake.mjs 的
// resolveZcodeLaunch 兼容(legacy 直启 / modern 复制入口到兼容目录)。
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createExternalIdentity } from '../control-plane.mjs';
import { nodeRunner } from '../runtime.mjs';
import { disableBinding } from '../aggregates/external-control.mjs';
import { restrictPrivateFile } from '../private-permissions.mjs';
import { writeDesktopHostSpec } from './member-hosts.mjs';
import { CONTROL_MCP_NAME, desktopControlMcpSpec } from './mcp-spec.mjs';
import { createZcodeProtocol, headlessInteractionReply } from '../member/zcode/protocol.mjs';
import { isolatedHomeEnv, resolveZcodeLaunch } from '../member/zcode/wake.mjs';
import { trustAgentTeamServer } from '../member/zcode/index.mjs';

/** cliPath 指向 <root>/src/cli.mjs。 */
export function zcodeDesktopCliPath(cliPath = fileURLToPath(new URL('../cli.mjs', import.meta.url))) {
  return cliPath;
}

/** 桌面 bundle 内启动 app-server 的 Electron 二进制;resolveZcodeLaunch 识别后按布局兼容启动。 */
export function zcodeDesktopLaunchCommand(bundlePath, platform = process.platform) {
  if (/\.app$/i.test(bundlePath) || (platform === 'darwin' && existsSync(join(bundlePath, 'Contents')))) {
    return join(bundlePath, 'Contents', 'MacOS', 'ZCode');
  }
  if (platform === 'win32') return join(bundlePath, 'ZCode.exe');
  const lower = join(bundlePath, 'zcode');
  return existsSync(lower) ? lower : join(bundlePath, 'ZCode');
}

/**
 * 桌面内嵌引擎作为成员执行器的宿主规格:command 指向桌面 Electron 二进制,
 * resolveZcodeLaunch 按布局选择启动方式;成员会话与用户可见桌面聊天历史的
 * 隔离由 zcode 适配器的 per-endpoint HOME 机制保证。
 * 由接入安装或面板把它合并进服务宿主配置(hosts.json)。
 */
export function zcodeDesktopMemberHostSpec({ bundlePath, dataDirectory, hostName = 'zcode-desktop' } = {}) {
  if (!bundlePath) throw new Error('桌面引擎成员需要桌面应用 bundle 路径');
  if (!dataDirectory) throw new Error('桌面引擎成员需要框架数据目录');
  return {
    hostName,
    spec: {
      adapter: 'zcode',
      command: zcodeDesktopLaunchCommand(bundlePath),
    },
  };
}

/**
 * 安装 ZCode Desktop 集成:检测应用 → 建激活连接 → 备份并合并写入
 * ~/.zcode/cli/config.json 的 mcp.servers.agent_team(其余键与 server 原样保留)。
 * key 只写入宿主配置(0600),不出现在返回值里。
 */
export async function installZcodeDesktopIntegration(store, {
  principalName = '本机用户',
  detections,
  zcodeHome = join(homedir(), '.zcode'),
  socketPath,
  runner = nodeRunner(),
  cliPath = zcodeDesktopCliPath(),
  now = new Date().toISOString(),
} = {}) {
  if (!socketPath) throw new Error('桌面接入安装需要总线 socket 路径');
  const detected = detections?.find?.(item => item.kind === 'zcode' && item.found);
  if (!detected) throw new Error('未检测到 ZCode Desktop 安装;请先安装桌面应用再接入');
  if (!detected.enginePath) throw new Error('ZCode Desktop 未提供内嵌执行引擎;无法完成桌面接入');

  // 激活连接的声明能力:桌面会话可收发、可观察、可唤醒、可询问用户。
  // workspaceRoots 以用户主目录为上界;真实工作目录由会话 cwd 跟随(ADR 0012)。
  const identity = createExternalIdentity(store, {
    principalName,
    bindingName: 'ZCode Desktop 接入',
    host: 'zcode',
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

  const configDir = join(zcodeHome, 'cli');
  const configPath = join(configDir, 'config.json');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const configText = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  let parsed = {};
  if (configText.trim()) {
    try {
      parsed = JSON.parse(configText);
    } catch {
      throw new Error('ZCode 用户配置 config.json 不是合法 JSON;请手动修复后重试');
    }
  }
  parsed.mcp ??= {};
  parsed.mcp.servers ??= {};
  const replacedUserEntry = Boolean(parsed.mcp.servers[CONTROL_MCP_NAME]);
  parsed.mcp.servers[CONTROL_MCP_NAME] = desktopControlMcpSpec({
    socketPath,
    bindingId: identity.binding.id,
    clientKey: identity.key,
    runner,
    cliPath,
  });
  let backupPath = null;
  let backupHash = null;
  if (configText) {
    backupPath = `${configPath}.agent-team-backup-${now.replace(/[:.]/g, '-')}`;
    copyFileSync(configPath, backupPath);
    restrictPrivateFile(backupPath);
    backupHash = createHash('sha256').update(configText).digest('hex');
  }
  writeFileSync(configPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });

  // 成员宿主:内嵌引擎在框架私有目录跑成员回合,不写用户可见聊天历史。
  const member = zcodeDesktopMemberHostSpec({ bundlePath: detected.bundlePath, dataDirectory: store.directory });
  writeDesktopHostSpec(store.directory, member.hostName, member.spec);

  return {
    applicationId: detected.applicationId,
    binding: {
      id: identity.binding.id,
      name: identity.binding.name,
      bindingKind: 'activation',
      surface: 'desktop',
      host: identity.binding.host,
    },
    configPath,
    memberHost: member.hostName,
    socketPath,
    backupPath,
    backupHash,
    replacedUserEntry,
    enginePath: detected.enginePath,
    engineVersion: detected.engineVersion,
    limitations: [
      '桌面 MCP 子进程没有会话身份通道:桌面会话经 Skill 自行 bind-session 绑定;并发桌面会话共享最近绑定(后绑定者赢)。',
      '账号套餐模型(如 account:* 命名空间,鉴权依赖应用登录态)在无头唤醒进程无法物化,主动唤醒将如实降级为手动拉取;API-key 模型(个人 provider 配置)可完整唤醒。',
    ],
    nextStep: '重启 ZCode Desktop 加载 MCP 配置;在桌面会话内调用 Agent Team Skill——模型可用 shell 中的 $ZCODE_SESSION_ID 自行 bind-session 激活主控。',
  };
}

// --- 验证策略(真实运行消耗模型额度;由额度确认门保护) -----------------------

const CONTROLLER_CHECK_PROMPT = '你是 Agent Team 桌面接入验证会话。调用一次 control_protocol 工具,把返回 JSON 里的 version 数字原样写在最终回复里,不要做其他事情。';
const ENGINE_CHECK_PROMPT = '只回复两个字符:OK';

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

/**
 * 在隔离 HOME 里驱动一个引擎回合并返回最终文本。会话存储落在隔离 HOME
 * (验证产物只进编排器的框架私有 workspace,结束路径统一清理);provider 凭据
 * 经 resolveZcodeLaunch 注入的 ZCODE_PERSONAL_PROVIDER_CONFIG_FILE 引用真实
 * 用户配置(同 DSH 凭据通道思路)。spawnTracked 由验证编排器提供,引擎进程
 * 纳入看门狗进程树清理;stdin 必须保持可写(协议走 stdio),覆盖编排器
 * 默认的 stdin-ignore。resolveLaunch 可注入(测试用 fake app-server)。
 */
async function runZcodeVerifyTurn({
  workspace, bundlePath, spawnTracked, timeoutMs, home, mcpSpec, prompt,
  resolveLaunch = resolveZcodeLaunch,
}) {
  mkdirSync(join(home, '.zcode', 'cli'), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, '.zcode', 'cli', 'config.json'), JSON.stringify(
    mcpSpec ? { mcp: { servers: { [CONTROL_MCP_NAME]: mcpSpec } } } : {},
  ), { mode: 0o600 });
  let sessionId = null;
  let completedResolve = null;
  const completed = new Promise(resolve => { completedResolve = resolve; });
  completed.catch(() => {});
  const launch = resolveLaunch({ command: zcodeDesktopLaunchCommand(bundlePath), cwd: workspace });
  const protocol = createZcodeProtocol({
    command: launch.command,
    args: launch.args,
    env: isolatedHomeEnv(launch.env, home),
    spawn: spawnTracked,
    onRequest: headlessInteractionReply,
    onNotification(row) {
      if (row.method !== 'session/event' || row.params?.sessionId !== sessionId) return;
      if (row.params.type === 'turn.completed') completedResolve(row.params.payload ?? {});
    },
  });
  try {
    await protocol.ready;
    const created = await protocol.request('session/create', {
      workspace: { workspacePath: workspace, workspaceKey: workspace },
      persistence: 'immediate',
    }, { timeout: 60000 });
    sessionId = created?.session?.sessionId;
    if (!sessionId) throw new Error('验证会话创建未返回 sessionId');
    if (mcpSpec) await trustAgentTeamServer(protocol, { workspacePath: workspace, workspaceKey: workspace });
    await protocol.request('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous' }, { timeout: 30000 });
    const accepted = await protocol.request('session/send', { sessionId, content: prompt }, { timeout: 60000 });
    if (accepted?.accepted === false) throw new Error('ZCode 验证会话拒绝回合输入');
    // 引擎中途退出时立刻报真实退出原因,不等超时;回合正常完成后该 promise
    // 的迟到拒绝由空 catch 吸收,避免 unhandledRejection。
    const exited = new Promise((resolve, reject) => {
      protocol.child.once('exit', code => reject(new Error(`内嵌引擎提前退出 (${code ?? 'signal'})`)));
    });
    exited.catch(() => {});
    const turn = await Promise.race([
      withTimeout(completed, timeoutMs, '验证回合超时'),
      exited,
    ]);
    const final = typeof turn?.response === 'string' ? turn.response : '';
    if (!final.trim()) throw new Error('验证回合未返回可确认的结果');
    return final;
  } finally {
    await protocol.stop();
  }
}

/**
 * ZCode Desktop 验证策略。主控检查:隔离 HOME + 一次性验证连接,让内嵌引擎
 * 的模型看见并调用 control_protocol;引擎检查:内嵌引擎在隔离 HOME 完成
 * 一个短任务。临时 HOME 与临时连接都在结束路径清理;真实额度消耗由额度
 * 确认门保护。resolveLaunch 可注入供测试替换启动命令。
 */
export function zcodeDesktopVerification({ resolveLaunch = resolveZcodeLaunch } = {}) {
  return {
    async verifyController({ store, workspace, detection, spawnTracked, socketPath, timeoutMs }) {
      if (!socketPath) return { ok: false, reason: '总线 socket 不可用,无法配置验证 MCP' };
      const temp = createExternalIdentity(store, {
        principalName: 'Agent Team 验证',
        bindingName: `zcode-desktop-verify-${randomUUID().slice(0, 8)}`,
        host: 'zcode',
        declared: {
          capabilities: ['session.deliver', 'turn.observe'],
          workspaceRoots: [homedir()],
          policies: ['read-only'],
        },
        surface: 'desktop',
      });
      try {
        const output = await runZcodeVerifyTurn({
          workspace,
          bundlePath: detection.bundlePath,
          spawnTracked,
          timeoutMs,
          home: join(workspace, 'zcode-verify-home'),
          mcpSpec: desktopControlMcpSpec({
            socketPath,
            bindingId: temp.binding.id,
            clientKey: temp.key,
            runner: nodeRunner(),
            cliPath: zcodeDesktopCliPath(),
          }),
          prompt: CONTROLLER_CHECK_PROMPT,
          resolveLaunch,
        });
        const ok = /version|1/.test(output);
        return {
          ok,
          // 失败时必须如实说「没确认到版本」,不能固定写「可调用」——否则诊断会掩盖真实原因。
          detail: ok ? '主控工具可调用' : '回合未返回可确认的 control_protocol 版本',
        };
      } finally {
        disableBinding(store, temp.binding.id);
      }
    },
    async verifyEngine({ workspace, detection, spawnTracked, timeoutMs }) {
      const output = await runZcodeVerifyTurn({
        workspace,
        bundlePath: detection.bundlePath,
        spawnTracked,
        timeoutMs,
        home: join(workspace, 'zcode-verify-engine-home'),
        mcpSpec: null,
        prompt: ENGINE_CHECK_PROMPT,
        resolveLaunch,
      });
      return { ok: /ok/i.test(output), detail: '内嵌引擎完成短任务' };
    },
  };
}
