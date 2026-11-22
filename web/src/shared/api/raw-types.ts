/**
 * 原始 API 响应类型入口。
 *
 * 1132 行的单文件已按领域拆分到 ./types/*;此文件只做类型再导出,保持既有
 * `import type { ... } from './raw-types'` / `@/shared/api/raw-types` 调用点不变:
 *   - core:      团队、成员、会话、消息、互动、任务、回合轨迹、概览与快照
 *   - panel:     Panel Agent、私聊消息与流片段、未读投影、附件 DTO
 *   - telemetry: 宿主遥测只读观测与批次
 *   - desktop:   宿主连接与桌面应用集成结果
 *   - notes:     随心记与归档事实快照
 *   - settings:  模型目录/策略、主题包、附件设置
 *
 * 新代码可直接从所属领域文件导入;跨域依赖一律走 `import type`(永不产生运行时导入)。
 */
export type * from './types/core';
export type * from './types/panel';
export type * from './types/telemetry';
export type * from './types/desktop';
export type * from './types/notes';
export type * from './types/settings';
