// 桌面引擎作为「成员宿主」的注册通道。
//
// 桌面应用本身是主控,不参与成员注册;但它的内嵌引擎可以在框架私有目录里
// 执行成员回合(隐藏会话,不写用户可见聊天历史)。这类宿主不是内置适配器,
// 由接入安装按检测到的引擎路径动态产出 spec,持久化在数据目录里,服务启动时
// 与内置宿主合并。文件不存在时完全不影响既有启动路径。
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DESKTOP_HOSTS_FILE = 'desktop-hosts.json';

export function desktopHostsPath(directory) {
  return join(directory, DESKTOP_HOSTS_FILE);
}

/** 读取动态桌面宿主 spec;文件缺失或损坏时返回空表(不让坏文件阻塞启动)。 */
export function readDesktopHostSpecs(directory) {
  try {
    const parsed = JSON.parse(readFileSync(desktopHostsPath(directory), 'utf8'));
    const hosts = parsed?.hosts;
    return hosts && typeof hosts === 'object' && !Array.isArray(hosts) ? hosts : {};
  } catch {
    return {};
  }
}

/** 写入/更新一个动态宿主 spec,保留其余条目。 */
export function writeDesktopHostSpec(directory, hostName, spec) {
  if (!hostName || typeof hostName !== 'string') throw new Error('桌面成员宿主需要名称');
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('桌面成员宿主需要 spec 对象');
  const hosts = { ...readDesktopHostSpecs(directory), [hostName]: spec };
  writeFileSync(desktopHostsPath(directory), `${JSON.stringify({ hosts }, null, 2)}\n`, { mode: 0o600 });
  return hosts;
}

/** 移除动态宿主 spec;不存在时是空操作。 */
export function removeDesktopHostSpec(directory, hostName) {
  const hosts = readDesktopHostSpecs(directory);
  if (!(hostName in hosts)) return hosts;
  delete hosts[hostName];
  writeFileSync(desktopHostsPath(directory), `${JSON.stringify({ hosts }, null, 2)}\n`, { mode: 0o600 });
  return hosts;
}
