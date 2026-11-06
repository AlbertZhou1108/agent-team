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

/** 工作台待办数：待答复互动卡 + 等待回复的消息。字段缺失按 0 处理。 */
export function pendingCount(workbench) {
  return (workbench?.pending?.length ?? 0) + (workbench?.waiting?.length ?? 0);
}
