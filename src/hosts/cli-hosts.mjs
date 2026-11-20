// 兼容 barrel：两个 CLI 宿主适配器历史上同处一文件，测试/脚本从这里 import。
// 实现已拆到 claude/ 与 dsh/；新代码请直接从对应模块导入。
export { readClaudeSessionMetadata, createClaudeHost } from '../member/claude/index.mjs';
export { createDshHost } from '../member/dsh/index.mjs';
