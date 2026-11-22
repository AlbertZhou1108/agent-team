// 桌面应用的安装/停用/启用/移除入口:统一按 kind 定位最新桌面安装行。
import * as externalAgg from '../aggregates/external-control.mjs';
import { desktopApplicationStatus } from './status.mjs';
import { removeDesktopHostSpec } from './member-hosts.mjs';
import { detectDesktopApplications } from './detect.mjs';
import { installCodexDesktopIntegration } from './codex.mjs';
import { installDshDesktopIntegration } from './dsh.mjs';
import { installClaudeDesktopIntegration } from './claude.mjs';
import { installZcodeDesktopIntegration } from './zcode.mjs';

function requireApplication(store, kind) {
  const row = externalAgg.applicationForKind(store, kind);
  if (!row) throw new Error(`未检测到桌面应用安装: ${kind}`);
  return row;
}

function statusFor(store, kind) {
  return desktopApplicationStatus(store).find(item => item.kind === kind);
}

/** 用户停用:系统能力结论保留,状态投影为不可用;该 surface 的新工作停止。 */
export function disableDesktopApplication(store, kind, { reason = null } = {}) {
  const row = requireApplication(store, kind);
  externalAgg.setApplicationDisabled(store, row.id, { reason });
  return statusFor(store, kind);
}

/** 重新启用:清停用标记并回到未验证状态,恢复可用必须重走完整验证。 */
export function enableDesktopApplication(store, kind) {
  const row = requireApplication(store, kind);
  externalAgg.clearApplicationDisabled(store, row.id);
  return statusFor(store, kind);
}

/** 四家桌面集成的安装入口:kind 决定真实安装函数,能力差异由各垂直切片自述。 */
const DESKTOP_INSTALLERS = new Map([
  ['codex', installCodexDesktopIntegration],
  ['dsh', installDshDesktopIntegration],
  ['claude', installClaudeDesktopIntegration],
  ['zcode', installZcodeDesktopIntegration],
]);

/**
 * 统一桌面集成安装分发:HTTP `/api/desktop/install` 与 RPC `desktop_install`
 * 共用本入口,避免两处各自维护 kind→安装函数的分叉(RPC 曾漏掉 zcode)。
 * `detections` 可由调用方注入(测试/批量安装复用一次检测结果),缺省时现场检测。
 */
export async function installDesktopIntegration(store, kind, { detections, socketPath, ...options } = {}) {
  const install = DESKTOP_INSTALLERS.get(kind);
  if (!install) {
    const error = new Error(`暂不支持安装桌面集成: ${kind}`);
    error.status = 400;
    throw error;
  }
  const resolvedDetections = detections ?? await detectDesktopApplications(store);
  return install(store, { detections: resolvedDetections, socketPath, ...options });
}

/** 移除集成登记:团队、消息与成员记录不受影响;再检测到会重新登记为未验证。 */
export function removeDesktopApplication(store, kind) {
  const row = requireApplication(store, kind);
  externalAgg.removeApplication(store, row.id);
  // 同时摘掉该应用动态注册的成员宿主,避免引擎已卸载后仍被派单。
  removeDesktopHostSpec(store.directory, `${kind}-desktop`);
  return statusFor(store, kind);
}
