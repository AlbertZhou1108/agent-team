/**
 * Electron 主进程与本地服务之间的接线。
 *
 * 复用 src/launcher.mjs 的 discover/launch：先探测已有实例，没有再起一个
 * 独立进程。服务不进主进程 —— node:sqlite 是同步 API，会阻塞窗口交互。
 */
import { applicationData, discover, launch, stopService } from '../src/launcher.mjs';

export function serviceDirectory() {
  return applicationData();
}

export async function ensureService(directory) {
  return launch({ directory });
}

export async function serviceAlive(directory) {
  try {
    return Boolean(await discover(directory));
  } catch {
    return false;
  }
}

export async function stop(directory) {
  return stopService(directory);
}

/**
 * 桌面徽标数：待办卡片 + 未读消息，两者都是「有事找我」。
 *
 * 「等待回复」是用户发出后没有回音的指令，属于待办审计而非「有事找我」，
 * 不计入徽标；字段缺失按 0 处理。
 */
export function badgeCount(workbench) {
  return (workbench?.pending?.length ?? 0) + (workbench?.unreadTotal ?? 0);
}
