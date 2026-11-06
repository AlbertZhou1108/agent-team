// Panel Agent 访问级别与私人工作区校验。
// 纯函数,接收 bus;不直接访问数据库(数据目录路径由 store.directory 提供)。
import { resolve, relative, isAbsolute } from 'node:path';
import { statSync } from 'node:fs';

/** 读取并校验访问级别;缺省 read-only。 */
export function panelAccessValue(agent) {
  const access = agent?.access ?? 'read-only';
  if (!['read-only', 'workspace-write', 'full-access'].includes(access)) throw new Error('Panel Agent 访问级别无效');
  return access;
}

/**
 * 校验私人工作区:必须存在、是目录、且不在数据目录内。
 * 未指定时只允许只读访问;返回规范化后的绝对路径或 null。
 */
export function panelWorkspace(bus, value, access) {
  if (value === undefined || value === null || value === '') {
    if (access !== 'read-only') throw new Error('工作区写入和完全权限需要设置私人工作区');
    return null;
  }
  if (typeof value !== 'string' || !value.trim()) throw new Error('Panel Agent 私人工作区无效');
  const resolved = resolve(value.trim());
  let stat;
  try { stat = statSync(resolved); } catch { throw new Error('Panel Agent 私人工作区不存在'); }
  if (!stat.isDirectory()) throw new Error('Panel Agent 私人工作区不是目录');
  const rel = relative(bus.store.directory, resolved);
  if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error('Panel Agent 私人工作区不能位于数据目录内');
  return resolved;
}

/** 宿主能力校验:宿主显式声明不支持该访问级别时拒绝。 */
export function requirePanelAccess(bus, hostName, access) {
  const adapter = bus.hosts.get(hostName);
  const support = adapter?.supportsPanelAccess?.({ access }) ?? { supported: true };
  if (support === false || support.supported === false) throw new Error(`宿主 ${hostName} 不支持私人访问级别 ${access}：${support.reason ?? '宿主能力不足'}`);
}
