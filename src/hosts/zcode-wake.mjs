import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createZcodeProtocol } from './zcode-protocol.mjs';

/**
 * ZCode 主动唤醒驱动：通过 `zcode.cjs app-server --stdio` 的 ZCode Protocol
 * 向既有会话注入一条消息并等待回合完成。与 codex 的 thread/queue/add 对应，
 * 这里用 session/resume + session/send + turn.started/turn.completed 事件。
 * 启动握手（storagePath → storagePathReady → storageState）完成前不发业务请求，
 * 否则会被服务端启动状态机拒绝。
 */

export function zcodeWakeFingerprint({ command, threadId, mcpConfig, home = process.env.HOME }) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify({
    command,
    threadId,
    mcp: {
      command: mcpConfig?.command ?? null,
      args: mcpConfig?.args ?? [],
      envKeys: Object.keys(mcpConfig?.env ?? {}).sort(),
    },
  }));
  const config = join(home ?? homedir(), '.zcode', 'cli', 'config.json');
  try {
    hash.update(readFileSync(config));
    hash.update(String(statSync(config).size));
  } catch {
    hash.update('config-unavailable');
  }
  return hash.digest('hex');
}

/**
 * 解析 ZCode 启动命令，返回 { command, args, env }：
 * - AGENT_TEAM_ZCODE_COMMAND / ZCODE_AGENT_SERVER_COMMAND 显式覆盖（后者是 ZCode 官方通道）；
 * - binding.command 指向真实可执行文件时直接使用；
 * - 最后按平台探测桌面 app 安装位置；找不到则抛错并说明可用出口。
 */
export function resolveZcodeLaunch({ command, cwd } = {}) {
  const protocol = cwd ? ['app-server', '--stdio', '--cwd', cwd] : ['app-server', '--stdio'];
  const override = process.env.AGENT_TEAM_ZCODE_COMMAND?.trim() || process.env.ZCODE_AGENT_SERVER_COMMAND?.trim();
  if (override) return { command: override, args: protocol, env: {} };
  if (command && command !== 'zcode' && existsSync(command)) {
    return { command, args: protocol, env: {} };
  }
  if (process.platform === 'darwin') {
    const electron = '/Applications/ZCode.app/Contents/MacOS/ZCode';
    const entry = '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';
    if (existsSync(electron) && existsSync(entry)) {
      return { command: electron, args: [entry, ...protocol], env: { ELECTRON_RUN_AS_NODE: '1' } };
    }
  }
  throw new Error(
    '未找到 ZCode 桌面安装；请用 agent-team connect --command 指定 ZCode 可执行文件，'
    + '或设置 AGENT_TEAM_ZCODE_COMMAND 环境变量',
  );
}

function zcodeLaunchArgs(cwd) {
  return cwd ? ['app-server', '--stdio', '--cwd', cwd] : ['app-server', '--stdio'];
}

export async function wakeZcodeAppServer({
  command,
  args,
  env,
  sessionId,
  text,
  cwd,
  mcpConfig,
  timeout = 8 * 60 * 1000,
}) {
  if (!sessionId) return { supported: false, reason: '缺少 controller session' };
  if (!text?.trim()) throw new Error('主动唤醒正文为空');
  let wakeTurnId = null;
  let started;
  let completed;
  const startedPromise = new Promise((resolve, reject) => { started = { resolve, reject }; });
  const completedPromise = new Promise((resolve, reject) => { completed = { resolve, reject }; });
  // 提前失败（如 resume 报错）后另一侧 promise 不再有人消费，挂空 catch 避免 unhandledRejection。
  startedPromise.catch(() => {});
  completedPromise.catch(() => {});
  const protocol = createZcodeProtocol({
    command,
    args: args ?? zcodeLaunchArgs(cwd),
    env,
    onRequest: () => ({ nativeSearchEnhancementsEnabled: false }),
    onNotification(row) {
      if (row.method !== 'session/event' || row.params?.sessionId !== sessionId) return;
      if (row.params.type === 'turn.started' && wakeTurnId == null) {
        wakeTurnId = row.params.turnId ?? null;
        started.resolve(wakeTurnId);
      }
      if (row.params.type === 'turn.completed'
        && wakeTurnId !== null
        && (row.params.turnId == null || row.params.turnId === wakeTurnId)) {
        completed.resolve(row.params.turnId ?? wakeTurnId);
      }
    },
  });
  const timer = setTimeout(() => {
    const error = new Error('ZCode 主动唤醒超时');
    started.reject(error);
    completed.reject(error);
  }, timeout);
  const fingerprint = zcodeWakeFingerprint({ command, threadId: sessionId, mcpConfig });
  try {
    await protocol.ready;
    await protocol.request('session/resume', { sessionId });
    await protocol.request('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous' });
    const accepted = await protocol.request('session/send', { sessionId, content: text });
    if (accepted?.accepted === false) {
      return {
        supported: true,
        state: 'failed',
        mode: 'zcode',
        reason: 'ZCode 会话拒绝注入',
        fingerprint,
        sessionId,
      };
    }
    const turnId = await startedPromise;
    await completedPromise;
    return {
      supported: true,
      state: 'started',
      mode: 'zcode',
      fingerprint,
      sessionId,
      turnId: turnId ?? null,
    };
  } finally {
    clearTimeout(timer);
    await protocol.stop();
  }
}
