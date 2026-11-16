import { homedir } from 'node:os';
import { join } from 'node:path';
import { createCodexHost, codexCapabilities } from './codex.mjs';
import { codexWakeFingerprint, wakeCodexAppServer } from './codex-wake.mjs';
import { createClaudeHost, claudeCapabilities } from './claude.mjs';
import { createDshHost, dshCapabilities } from './dsh.mjs';
import { dshWakeFingerprint, wakeDshSession } from './dsh-wake.mjs';
import { createZcodeHost, zcodeCapabilities } from './zcode.mjs';
import { applyZcodeHome, resolveZcodeLaunch, zcodeWakeFingerprint, wakeZcodeAppServer } from './zcode-wake.mjs';

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
export const HOST_DEFINITIONS = new Map([
  ['codex', {
    factory: createCodexHost,
    telemetryCapabilities: codexCapabilities,
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
    telemetryCapabilities: dshCapabilities,
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
    telemetryCapabilities: claudeCapabilities,
    skill: { mode: 'copy', dir: home => join(home ?? homedir(), '.claude', 'skills', 'agent-team') },
    discoverControllerSession(env) {
      const session = env.CLAUDE_SESSION_ID?.trim();
      return session ? { session, clearExistingSession: false } : null;
    },
  }],
]);
