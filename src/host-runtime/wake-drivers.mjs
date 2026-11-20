import { HOST_DEFINITIONS } from '../hosts/definitions.mjs';

// 主控主动唤醒驱动注册表：按宿主从 definitions.mjs 派生；
// registerWakeDriver 保留给测试注入假驱动。
const drivers = new Map(
  [...HOST_DEFINITIONS]
    .filter(([, definition]) => definition.wake)
    .map(([name, definition]) => [name, {
      id: definition.wake.id,
      fingerprint: definition.wake.fingerprint,
      wake: definition.wake.wake,
    }]),
);

export function wakeDriverFor(host) {
  return drivers.get(host) ?? null;
}

export function registerWakeDriver(host, driver) {
  if (!host || !driver?.wake) throw new Error('主动唤醒 driver 无效');
  drivers.set(host, driver);
}
