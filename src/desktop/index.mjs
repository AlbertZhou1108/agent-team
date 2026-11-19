// 桌面域门面:检测、验证、状态、停用管理与宿主切片的公共入口。
// 各宿主切片的验证策略在这里展开挂到定义表顶层(验证执行器读顶层属性;
// 定义表保持纯数据,不含宿主切片代码)。
import { DESKTOP_DEFINITIONS } from './definitions.mjs';
import { codexDesktopVerification } from './codex.mjs';
import { dshDesktopVerification } from './dsh.mjs';
import { claudeDesktopVerification } from './claude.mjs';

Object.assign(DESKTOP_DEFINITIONS.get('codex'), codexDesktopVerification());
Object.assign(DESKTOP_DEFINITIONS.get('dsh'), dshDesktopVerification());
Object.assign(DESKTOP_DEFINITIONS.get('claude'), claudeDesktopVerification());

export * from './definitions.mjs';
export * from './detect.mjs';
export * from './verify.mjs';
export * from './status.mjs';
export * from './manage.mjs';
export * from './codex.mjs';
export * from './dsh.mjs';
export * from './claude.mjs';
