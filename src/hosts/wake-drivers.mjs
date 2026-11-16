import { codexWakeFingerprint, wakeCodexAppServer } from './codex-wake.mjs';
import { resolveZcodeLaunch, zcodeWakeFingerprint, wakeZcodeAppServer } from './zcode-wake.mjs';

const drivers = new Map([
  ['codex', {
    id: 'codex-app-server',
    fingerprint({ command, threadId, mcpConfig }) {
      return codexWakeFingerprint({ command, threadId, mcpConfig });
    },
    wake(args) {
      return wakeCodexAppServer(args);
    },
  }],
  ['zcode', {
    id: 'zcode-app-server',
    fingerprint({ command, threadId, mcpConfig }) {
      return zcodeWakeFingerprint({ command, threadId, mcpConfig });
    },
    wake(args) {
      const launch = resolveZcodeLaunch({ command: args.command, cwd: args.cwd });
      return wakeZcodeAppServer({
        ...launch,
        sessionId: args.threadId,
        text: args.text,
        cwd: args.cwd,
        mcpConfig: args.mcpConfig,
        timeout: args.timeout,
      });
    },
  }],
]);

export function wakeDriverFor(host) {
  return drivers.get(host) ?? null;
}

export function registerWakeDriver(host, driver) {
  if (!host || !driver?.wake) throw new Error('主动唤醒 driver 无效');
  drivers.set(host, driver);
}
