// 宿主适配器的显式契约与注册表。
//
// 宿主的全部注册事实按宿主收敛在 definitions.mjs 的 HOST_DEFINITIONS 里；
// 本文件只派生成员侧注册表。新增宿主：改 definitions.mjs，遥测能力、
// 主控唤醒驱动、技能目录、主控会话发现随之生效。
// 调用方(server.mjs)只依赖这里的注册表,不再各自维护工厂 Map。
import { HOST_DEFINITIONS } from './definitions.mjs';

/**
 * 内置宿主:friendly name -> 工厂。没有工厂的宿主（例如桌面应用类主控）不参与成员注册，
 * 它们只能作为外部主控接入——这正是 `session.spawn = false` 的含义。
 */
export const HOST_FACTORIES = new Map(
  [...HOST_DEFINITIONS]
    .filter(([, definition]) => typeof definition.factory === 'function')
    .map(([name, definition]) => [name, definition.factory]),
);

/** 未显式提供 hosts 配置时的默认注册；同样只包含可被启动的成员宿主。 */
export const DEFAULT_HOST_SPECS = Object.freeze(
  Object.fromEntries(
    [...HOST_DEFINITIONS]
      .filter(([, definition]) => typeof definition.factory === 'function')
      .map(([name]) => [name, Object.freeze({ adapter: name })]),
  ),
);

/**
 * 校验宿主适配器是否满足契约。run 是唯一必需方法;其余可选方法只要声明就必须是函数,
 * 避免调用方在运行时才发现拼错或漏实现。
 */
export function assertHostContract(name, host) {
  if (typeof host?.run !== 'function') throw new Error(`宿主缺少 run 接口: ${name}`);
  for (const method of ['connectionStatus', 'sessionKey', 'supportsPolicy', 'capabilities']) {
    if (host?.[method] !== undefined && typeof host[method] !== 'function') {
      throw new Error(`宿主 ${name} 的 ${method} 不是函数`);
    }
  }
  return host;
}
