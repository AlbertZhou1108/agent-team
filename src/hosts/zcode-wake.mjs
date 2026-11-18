import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createZcodeProtocol, headlessInteractionReply } from './zcode-protocol.mjs';

/**
 * ZCode 主动唤醒驱动：通过 `zcode.cjs app-server --stdio` 的 ZCode Protocol
 * 向既有会话注入一条消息并等待回合完成。与 codex 的 thread/queue/add 对应，
 * 这里用 session/resume + session/send + turn.started/turn.completed 事件。
 * 启动握手（storagePath → storagePathReady → storageState）完成前不发业务请求，
 * 否则会被服务端启动状态机拒绝。
 */

export function zcodeWakeFingerprint({ command, threadId, mcpConfig, home = process.env.AGENT_TEAM_ZCODE_HOME ?? process.env.HOME }) {
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

/** 桌面 app 内的固定相对路径。抽出来便于布局探测与测试。 */
export function zcodeAppPaths(appRoot) {
  return {
    electron: join(appRoot, 'Contents', 'MacOS', 'ZCode'),
    entry: join(appRoot, 'Contents', 'Resources', 'glm', 'zcode.cjs'),
    runtime: join(appRoot, 'Contents', 'Resources', 'glm', 'node-runtime'),
    legacyProvider: join(appRoot, 'Contents', 'Resources', 'glm', 'provider', 'zcode-builtin.json'),
    modernProvider: join(appRoot, 'Contents', 'Resources', 'config', 'provider', 'zcode-builtin.json'),
  };
}

/**
 * 探测桌面 app 的 provider 配置布局，兼容 ZCode 版本升级导致的目录迁移：
 * - legacy：配置在入口旁 `glm/provider/`，Electron 方式可直接启动；
 * - modern：配置迁到 `Resources/config/provider/`，Electron 以 ELECTRON_RUN_AS_NODE
 *   方式启动时 cjs 按旧路径找不到配置，需复制入口+配置到兼容目录后用系统 node 启动。
 * 返回 'legacy' | 'modern' | null（入口不存在）。
 */
export function detectZcodeLayout(appRoot) {
  const paths = zcodeAppPaths(appRoot);
  if (!existsSync(paths.entry)) return null;
  if (existsSync(paths.legacyProvider)) return 'legacy';
  if (existsSync(paths.modernProvider)) return 'modern';
  return 'legacy'; // 没有可识别配置时保留旧行为，由 cjs/宿主自行处理。
}

/**
 * 为 modern 布局准备兼容启动目录：复制入口 cjs 与 provider 配置到按 appRoot
 * 哈希命名的稳定目录，并把 node-runtime 软链过去。目录稳定 + 存在即跳过，
 * 保证多次唤醒幂等、不重复复制。返回可直接交给系统 node 的入口路径。
 */
export function prepareZcodeEntry(appRoot) {
  const paths = zcodeAppPaths(appRoot);
  const digest = createHash('sha256').update(appRoot).digest('hex').slice(0, 16);
  // 测试可通过该环境变量把兼容目录重定向到隔离位置。
  const root = process.env.AGENT_TEAM_ZCODE_COMPAT_DIR?.trim() || join(tmpdir(), `agent-team-zcode-compat-${digest}`);
  const entryDir = join(root, 'glm');
  const entry = join(entryDir, 'zcode.cjs');
  const config = join(entryDir, 'provider', 'zcode-builtin.json');
  mkdirSync(join(entryDir, 'provider'), { recursive: true, mode: 0o700 });
  if (!existsSync(entry) || statSync(entry).size !== statSync(paths.entry).size) copyFileSync(paths.entry, entry);
  const provider = existsSync(paths.legacyProvider) ? paths.legacyProvider : paths.modernProvider;
  if (existsSync(provider) && (!existsSync(config) || statSync(config).size !== statSync(provider).size)) {
    copyFileSync(provider, config);
  }
  if (existsSync(paths.runtime)) {
    const link = join(entryDir, 'node-runtime');
    if (!existsSync(link)) {
      try { symlinkSync(paths.runtime, link, 'dir'); } catch { /* 并发下已创建 */ }
    }
  }
  return entry;
}

/**
 * 解析 ZCode 启动命令，返回 { command, args, env }：
 * - AGENT_TEAM_ZCODE_COMMAND / ZCODE_AGENT_SERVER_COMMAND 显式覆盖（后者是 ZCode 官方通道，
 *   须是可直接执行 protocol 参数的命令）；
 * - binding.command 指向真实可执行文件时直接使用；macOS 桌面壳是 Electron 二进制，
 *   识别后按 provider 配置布局选择启动方式（见 detectZcodeLayout）；
 * - 最后按平台探测桌面 app 安装位置；找不到则抛错并说明可用出口。
 */
export function resolveZcodeLaunch({ command, cwd } = {}) {
  const protocol = cwd ? ['app-server', '--stdio', '--cwd', cwd] : ['app-server', '--stdio'];
  const override = process.env.AGENT_TEAM_ZCODE_COMMAND?.trim() || process.env.ZCODE_AGENT_SERVER_COMMAND?.trim();
  if (override) return { command: override, args: protocol, env: {} };
  const desktopLaunch = appRoot => {
    const layout = detectZcodeLayout(appRoot);
    if (layout === null) return null;
    if (layout === 'modern') {
      // 新版配置迁移 + Electron 启动约束：用系统 node 跑兼容目录里的入口。
      return { command: process.execPath, args: [prepareZcodeEntry(appRoot), ...protocol], env: {} };
    }
    const paths = zcodeAppPaths(appRoot);
    return { command: paths.electron, args: [paths.entry, ...protocol], env: { ELECTRON_RUN_AS_NODE: '1' } };
  };
  if (command && command !== 'zcode' && existsSync(command)) {
    const macApp = process.platform === 'darwin'
      ? /^(.+\.app)\/Contents\/MacOS\/[^/]+$/.exec(command)
      : null;
    if (macApp) {
      const launch = desktopLaunch(macApp[1]);
      if (launch) return launch;
    }
    return { command, args: protocol, env: {} };
  }
  if (process.platform === 'darwin') {
    const launch = desktopLaunch('/Applications/ZCode.app');
    if (launch) return launch;
  }
  throw new Error(
    '未找到 ZCode 桌面安装；请用 agent-team connect --command 指定 ZCode 可执行文件，'
    + '或设置 AGENT_TEAM_ZCODE_COMMAND 环境变量',
  );
}

/** AGENT_TEAM_ZCODE_HOME 把唤醒实例的 ZCode 数据目录重定向到隔离环境（验收用）。 */
export function applyZcodeHome(env) {
  const home = process.env.AGENT_TEAM_ZCODE_HOME?.trim();
  return home ? { ...env, HOME: home } : env;
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
    onRequest: headlessInteractionReply,
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
