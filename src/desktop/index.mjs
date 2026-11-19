// 桌面域门面:检测、验证、状态、停用管理与宿主切片的公共入口。
// Codex 切片的验证策略在这里挂到定义表上(定义表保持纯数据)。
import { DESKTOP_DEFINITIONS } from './definitions.mjs';
import { codexDesktopVerification } from './codex.mjs';

DESKTOP_DEFINITIONS.get('codex').verify = codexDesktopVerification();

export * from './definitions.mjs';
export * from './detect.mjs';
export * from './verify.mjs';
export * from './status.mjs';
export * from './manage.mjs';
export * from './codex.mjs';
