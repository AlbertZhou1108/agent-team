# 通信内核减负方案

日期:2026-10-25
状态:已采纳,阶段 0-5 已实施(2026-10-25)
决策记录:[ADR 0004 — Revert to a Communication-First Core](./adr/0004-revert-to-communication-core.md)

## 1. 背景与诊断

项目核心是多 Agent 通信框架,但约 35% 的后端代码(约 3300 行)用于强制协作流程,并通过五组钩子嵌进消息收发路径:

1. **泵被状态机劫持**:`store.pending()` SQL `JOIN team_state`,仅 `active/closed` 相位投递,并排除 `message_dispositions`;`closing` 冻结全部派发。
2. **发送侧门禁 + 账本**:每条 `send/note` 过 `requireCommunication`(契约存在 + 未归档 + 相位 + 无未知运行),事务内写 `message_context(work_item_id, contract_version, goal_id)`;不确认契约连群都建不了(`createGroup` 直接拒绝)。
3. **回合背流程**:策略从契约+工作项推导;`runtime_attempts` 携带契约/目标列;prompt 注入契约/工作项/目标视图(约 300 行投影);每回合 finally 跑 `reconcile` 推进状态机。
4. **收尾四重审计**:工作项全结 + 完成条件覆盖 + dispositions 全覆盖 + Goal Inbox 消费完,否则拒绝 `team_finish`。
5. **目标生命周期反向写总线**:goal 投影回 `team_state`,Goal Inbox 未消费可阻塞收尾。

## 2. 取舍

**保留(通信与运行安全)**:消息总线(send/note/read、双人会话、coordination 串行、批量合并)、回合引擎与宿主适配、遥测与流式、Panel Agent、未知运行闸门、指令幂等编号、策略域 communication/project 与宿主沙箱(来源改为建群参数)、成员生命周期、`groups.state` 归档开关。

**移除(任务流程)**:目标生命周期全部、工作项状态机与审查引用校验、契约版本链与 change_request、preparation 建群协议、team_finish/closing/closed 相位与 dispositions、operationId 管理账本、模型规划三件套。

**降级保留**:契约 → 可选 charter 纯文本(prompt 上下文,非门禁);完成 → 用户归档;角色模型 → `--hosts` 与全局策略直接解析。

## 3. 架构对比

| 层 | 减负前 | 减负后 |
| --- | --- | --- |
| 总线 | bus.mjs 2909 行,65% 内核 + 35% 流程钩子 | 约 1900 行纯通信 |
| 协作模块 | collaboration.mjs 604 行(preparation/门禁/工作项/收尾) | 约 100 行(归档、未知运行、角色名) |
| 目标生命周期 | team-goal-lifecycle.mjs 964 行 | 删除 |
| 上下文投影 | information.mjs 651 行(含 300 行流程视图) | 约 350 行纯消息投影 |
| 状态 | 群 2 态 × 相位 3 态 × 工作项 6 态 × 契约/目标版本链 | `open/archived` 一个开关 |
| Agent 工具 | 约 25 个 | 约 12 个 |
| 流程表 | 17 张 + 通信表渗入列 | 全部 DROP,消息历史保留 |

职责边界:分工、质量把关、完成判定由主 Agent 用消息自行组织;框架只保留投递安全(未知运行闸、指令幂等、重启恢复)与执行策略两档。

## 4. 执行阶段

每阶段独立 commit,`npm run check && npm test` 全绿后进入下一阶段。

| 阶段 | 内容 | 止血点 |
| --- | --- | --- |
| 0 | ADR 0004 + 本文档 | — |
| 1 | 存储解耦:`pending()` 去 team_state JOIN 与 dispositions 过滤;发送事务去 `message_context`;`runtime_attempts` 去契约/目标列 | 消息泵不再依赖流程状态 |
| 2 | 拆门禁与注入:`requireCommunication` 收窄为归档+未知运行两查;prompt 去流程视图;固定规则重写为通信话术 | 回合不再携带流程 |
| 3 | 删流程模块:team-goal-lifecycle、流程工具约 13 个、preparation 协议、模型规划三件套;`createGroup` 解禁,charter 随建群输入 | 后端减负完成 |
| 4 | 前端:删 GoalLifecyclePanel,协作页改写为团队概览,API/类型瘦身 | 前端减负完成 |
| 5 | 删 team-goal-* 测试;store 幂等迁移(DROP 流程表);重写 README/concept/collaboration-concept | 全部完成 |

## 6. 实施记录

- 后端:src 净删约 5400 行;agent 工具从约 25 个减到 12 个;CONTEXT_SCHEMA_VERSION 升为 2(旧会话走 legacy 原始输入路径)。
- 迁移:Store.migrate() 幂等 DROP 流程表并清理渗入列;消息、成员、会话、遥测保留。
- 验收:scripts/verify-collaboration.mjs 改为消息级验收(核对轮询 + ACCEPTANCE_DONE/ACCEPTANCE_BLOCKED 最终文本约定)。
- 群执行策略:groups.policy(communication|read-only|workspace-write,默认 workspace-write)+ allow_shell;coordination/profile/private 恒为 communication。

## 5. 风险与回退

- 主 Agent 失去结构化工作项后,长任务协调质量依赖模型自身。实测不达标时,再考虑以可选层加回流程,而不是默认状态机。
- 收尾语义由"框架审计"变为"主 Agent 宣布 + 用户归档";归档前未处理消息直接留在历史里。
- 回退方式:重构在独立分支进行,按 commit 逐阶段回退。
