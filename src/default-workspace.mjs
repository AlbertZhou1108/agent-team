import { homedir } from 'node:os';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// 默认私人工作区:让 Panel Agent 开箱即用,用户无需先手动选择目录。
// 附件副本不存放在这里——私人工作区是用户和 Agent 的工作区域,
// 框架数据(附件副本)统一放数据目录,避免污染工作区。

export function defaultPanelWorkspace({ home = homedir(), platform = process.platform } = {}) {
  const documents = join(home, 'Documents');
  // macOS/Windows 的 Documents 是标准用户目录;Linux 桌面环境通常也存在,
  // 缺席时(无桌面环境)回退到 XDG 数据目录,保证路径始终用户可见或约定俗成。
  if (platform === 'darwin' || platform === 'win32' || existsSync(documents)) {
    return join(documents, 'AgentTeam');
  }
  return join(home, '.local', 'share', 'agent-team', 'workspace');
}

// 创建 Panel Agent 未指定工作区时:按系统提供默认目录并确保存在。
// home/platform 可注入,测试据此隔离真实用户目录。
export function ensureDefaultPanelWorkspace(options = {}) {
  const workspace = defaultPanelWorkspace(options);
  mkdirSync(workspace, { recursive: true });
  return workspace;
}
