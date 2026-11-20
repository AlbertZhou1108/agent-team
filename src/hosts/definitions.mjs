import { homedir } from 'node:os';
import { join } from 'node:path';
import { createCodexHost, codexCapabilities, CODEX_TRAITS } from './codex/index.mjs';
import { codexWakeFingerprint, wakeCodexAppServer } from './codex/wake.mjs';
import { createClaudeHost, claudeCapabilities, CLAUDE_TRAITS } from './claude/index.mjs';
import { createDshHost, dshCapabilities, DSH_TRAITS } from './dsh/index.mjs';
import { dshWakeFingerprint, wakeDshSession } from './dsh/wake.mjs';
import { createZcodeHost, zcodeCapabilities, ZCODE_TRAITS } from './zcode/index.mjs';
import { applyZcodeHome, resolveZcodeLaunch, zcodeWakeFingerprint, wakeZcodeAppServer } from './zcode/wake.mjs';
import { resolveCapabilities } from './capabilities.mjs';

/**
 * 四个内置宿主共同的手写能力。`session.spawn` 与 `session.wake` 不在这里：
 * 前者由"有没有成员工厂"推导，后者由"有没有注册唤醒驱动"推导（见文件末尾）。
 * 这里只写宿主自身的本事。
 */
const COMMON_CAPABILITIES = Object.freeze({
  'session.deliver': true,
  'turn.observe': true,
  'exec.read': true,
  'exec.write': true,
  'exec.shell': true,
  'user.elicit': false,
  'user.notify': false,
  'telemetry.tokens.direct': true,
  'telemetry.tokens.derived': true,
  'telemetry.turn_time': true,
  'telemetry.context_window': true,
});

/**
 * 桌面应用类主控（WorkBuddy）：框架不启动它，也没有注入接口，所以只声明
 * "能收发、能观察"。执行能力全为 false——它不接派单，也不产出遥测。
 */
const WORKBUDDY_CAPABILITIES = Object.freeze({
  'session.deliver': true,
  'turn.observe': true,
  'exec.read': false,
  'exec.write': false,
  'exec.shell': false,
  'user.elicit': false,
  'user.notify': false,
  'telemetry.tokens.direct': false,
  'telemetry.tokens.derived': false,
  'telemetry.turn_time': false,
  'telemetry.context_window': false,
});

/**
 * 按宿主收敛的适配定义：一个宿主要接入框架的全部事实都在这里声明——
 * 成员工厂、遥测能力声明、主动唤醒驱动（可选）、技能安装目标（可选）、
 * 主控会话发现（可选）。五个消费点全部从本表派生，对外导出名不变：
 * - hosts/index.mjs → HOST_FACTORIES / DEFAULT_HOST_SPECS（成员注册）
 * - telemetry-capabilities.mjs → capabilityBuilders（遥测兼容查表）
 * - hosts/wake-drivers.mjs → 驱动注册表（主控唤醒）
 * - skill-install.mjs → defaultSkillTarget / sharedSkillTarget
 * - rpc.mjs controlHostContext → 主控会话发现链
 * 新增宿主只改本文件；注册顺序即会话发现优先级（Codex 最先，保留其
 * multi-agent 子会话降级语义）。
 */
const RAW_DEFINITIONS = new Map([
  ['codex', {
    factory: createCodexHost,
    capabilities: COMMON_CAPABILITIES,
    traits: CODEX_TRAITS,
    telemetryCapabilities: codexCapabilities,
    // 桌面集成的会话身份通道:桌面 MCP 子进程能拿到 CODEX_THREAD_ID,
    // 激活连接可按线程解析出每会话独立的会话连接。
    desktopConversationIdentity: 'thread',
    wake: {
      id: 'codex-app-server',
      fingerprint({ command, threadId, mcpConfig }) {
        return codexWakeFingerprint({ command, threadId, mcpConfig });
      },
      wake(args) {
        return wakeCodexAppServer(args);
      },
    },
    skill: { mode: 'copy', dir: home => join(home ?? homedir(), '.codex', 'skills', 'agent-team') },
    discoverControllerSession(env) {
      // 顶层 Codex 的 THREAD_ID 与 SESSION_ID 相同；multi-agent 子会话的
      // THREAD_ID 是父级不可恢复的子 thread——只能降级 pull-only。
      const thread = env.CODEX_THREAD_ID?.trim();
      const session = env.CODEX_SESSION_ID?.trim();
      if (thread && session && thread !== session) return { session: null, clearExistingSession: true };
      if (thread || session) return { session: thread || session, clearExistingSession: false };
      return null;
    },
  }],
  ['zcode', {
    factory: createZcodeHost,
    capabilities: COMMON_CAPABILITIES,
    traits: ZCODE_TRAITS,
    telemetryCapabilities: zcodeCapabilities,
    wake: {
      id: 'zcode-app-server',
      fingerprint({ command, threadId, mcpConfig }) {
        return zcodeWakeFingerprint({ command, threadId, mcpConfig });
      },
      wake(args) {
        const launch = resolveZcodeLaunch({ command: args.command, cwd: args.cwd });
        return wakeZcodeAppServer({
          ...launch,
          env: applyZcodeHome(launch.env),
          sessionId: args.threadId,
          text: args.text,
          cwd: args.cwd,
          mcpConfig: args.mcpConfig,
          timeout: args.timeout,
        });
      },
    },
    skill: { mode: 'shared', dir: home => join(home ?? homedir(), '.agents', 'skills', 'agent-team') },
    discoverControllerSession(env) {
      // ZCode 的 MCP 子进程不注入会话 id；bash 子进程的变量作兜底，
      // 主控会话通常经 connect --session 显式绑定。
      const session = env.ZCODE_SESSION_ID?.trim();
      return session ? { session, clearExistingSession: false } : null;
    },
  }],
  ['dsh', {
    factory: createDshHost,
    capabilities: COMMON_CAPABILITIES,
    traits: DSH_TRAITS,
    telemetryCapabilities: dshCapabilities,
    // 桌面 MCP 子进程拿不到 DSH_SESSION_ID(实测),桌面会话身份只能经
    // bind_client_session 显式绑定;绑定前激活连接拒绝执行工具。
    desktopConversationIdentity: 'manual',
    wake: {
      id: 'dsh-headless-resume',
      fingerprint({ command, threadId, mcpConfig }) {
        return dshWakeFingerprint({ command, threadId, mcpConfig });
      },
      wake(args) {
        return wakeDshSession(args);
      },
    },
    skill: { mode: 'shared', dir: home => join(home ?? homedir(), '.agents', 'skills', 'agent-team') },
    discoverControllerSession(env) {
      // DSH 给 bash 子进程注入 DSH_SESSION_ID；MCP stdio 子进程擦除 DSH_*，
      // 主控会话通常经 connect --session 显式绑定。
      const session = env.DSH_SESSION_ID?.trim();
      return session ? { session, clearExistingSession: false } : null;
    },
  }],
  ['claude', {
    factory: createClaudeHost,
    capabilities: COMMON_CAPABILITIES,
    traits: CLAUDE_TRAITS,
    telemetryCapabilities: claudeCapabilities,
    // 桌面 MCP 子进程拿不到 CLAUDE_SESSION_ID(实测),也没有安全的同会话唤醒;
    // 桌面集成解析为应用级单连接并保持 Pull-only,限制如实展示(ADR 0011)。
    desktopConversationIdentity: 'app',
    skill: { mode: 'copy', dir: home => join(home ?? homedir(), '.claude', 'skills', 'agent-team') },
    discoverControllerSession(env) {
      const session = env.CLAUDE_SESSION_ID?.trim();
      return session ? { session, clearExistingSession: false } : null;
    },
  }],
  ['workbuddy', {
    // 桌面应用，作为 MCP 客户端连到框架，以主控身份参与。
    // 没有 factory（框架启动不了它），所以没有实现目录；`session.spawn` 由工厂推导为 false。
    // 没有 wake（无注入接口），`session.wake` 由驱动推导为 false。
    capabilities: WORKBUDDY_CAPABILITIES,
    traits: Object.freeze({}),
    skill: { mode: 'copy', dir: home => join(home ?? homedir(), '.workbuddy', 'skills', 'agent-team') },
  }],
]);

/**
 * 对外导出的宿主定义：手写声明 + 由工厂/驱动推导出的 spawn/wake。
 * 推导集中在这里，保证"一个宿主的能力"只有一种来源。
 */
export const HOST_DEFINITIONS = new Map(
  [...RAW_DEFINITIONS].map(([name, definition]) => [name, Object.freeze({
    ...definition,
    capabilities: resolveCapabilities({
      declaration: definition.capabilities,
      hasFactory: typeof definition.factory === 'function',
      hasWake: Boolean(definition.wake),
    }),
  })]),
);

/**
 * 连接面:桌面主控省略 workspace 时,团队跟随会话当前目录;
 * CLI 连接必须显式提供工作目录。所有 surface 判断都走这里,
 * 不要在业务代码里比较字符串字面量。
 */
export const SURFACES = Object.freeze({ cli: 'cli', desktop: 'desktop' });

export function surfaceFollowsConversation(surface) {
  return surface === SURFACES.desktop;
}
