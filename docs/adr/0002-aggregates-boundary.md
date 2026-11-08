# ADR 0002：三表聚合边界

- 状态：已采纳（2026-11-06，提交 04d90270 / bbbfb34）
- 背景：业务模块直写 messages / turns / conversations SQL，schema 变更要跨模块搜索；测试分层规则要求 contract 不得断言内部行。
- 决策：这三张表的读写与不变式集中在 `src/aggregates/{messages,turns,conversations}.mjs`（纯函数、接收 store）；业务模块不得直写。分析查询仍可直接用 `store.all`。
- 后果：新增不变式先加聚合方法再迁移调用点；后续团队/设置/面板域按同一模式扩展（teams/settings/panel 已落地）。
