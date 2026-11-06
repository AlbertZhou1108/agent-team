// 宿主适配器的显式契约与注册表。
//
// 新增宿主:在本文件加一个工厂 import 与注册项;遥测能力声明在
// telemetry-capabilities.mjs 的 capabilityBuilders 加一个 builder。
// 调用方(server.mjs)只依赖这里的注册表,不再各自维护工厂 Map。
import { createCodexHost } from './codex.mjs';
import { createClaudeHost, createDshHost } from './cli-hosts.mjs';

/**
 * 宿主适配器契约。
 * @typedef {Object} HostAdapter
 * @property {(context: object) => Promise<object>} run 必需:执行一个回合。
 * @property {(options?: object) => object} [connectionStatus] 可选:连接/登录状态。
 * @property {(input: object) => string} [sessionKey] 可选:宿主会话域。
 * @property {(input: object) => object} [supportsPolicy] 可选:策略能力。
 * @property {(input: object) => object} [capabilities] 可选:遥测能力声明。
 */

/** 内置宿主:friendly name -> 工厂。 */
export const HOST_FACTORIES = new Map([
  ['codex', createCodexHost],
  ['claude', createClaudeHost],
  ['dsh', createDshHost],
]);

/** 未显式提供 hosts 配置时的默认注册。 */
export const DEFAULT_HOST_SPECS = Object.freeze({
  codex: Object.freeze({ adapter: 'codex' }),
  claude: Object.freeze({ adapter: 'claude' }),
  dsh: Object.freeze({ adapter: 'dsh' }),
});

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
