import { codexWakeFingerprint, wakeCodexAppServer } from './codex-wake.mjs';

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
]);

export function wakeDriverFor(host) {
  return drivers.get(host) ?? null;
}

export function registerWakeDriver(host, driver) {
  if (!host || !driver?.wake) throw new Error('主动唤醒 driver 无效');
  drivers.set(host, driver);
}
