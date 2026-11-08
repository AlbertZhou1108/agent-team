# ADR 0001：事务支持嵌套（SAVEPOINT）

- 状态：已采纳（2026-11-06，提交 3bebab2）
- 背景：`store.transaction()` 手写 BEGIN，不支持嵌套；event-log 与 team-requests 各自用 `isTransaction` / `transaction:false` 绕行，新调用点漏传即运行时失败。
- 决策：顶层保持 BEGIN IMMEDIATE；已在事务中时自动降级为 SAVEPOINT。删除全部绕行代码。
- 后果：调用方无需感知事务上下文；嵌套回滚语义由测试钉住（`test/internal/transaction-nesting.test.mjs`）。禁止再引入 `db.isTransaction` 判断。
