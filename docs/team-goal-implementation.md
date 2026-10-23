# Team 与 Goal 生命周期实现

日期：2026-10-24
状态：当前实现

依据：

- [领域术语](../GLOSSARY.md)
- [ADR 0001：拆分 Team、Goal 与 Work Item 生命周期](./adr/0001-separate-team-goal-and-work-item-lifecycles.md)
- [ADR 0002：Goal 消息消费与收尾 cutoff](./adr/0002-bound-goal-message-consumption-and-finalization-cutoff.md)
- [ADR 0003：Goal 授权、确认与失败边界](./adr/0003-confirm-goal-authority-and-failure-boundaries.md)

## 领域对象

Team 是长期存在的通信与协作空间；Goal 是受完整契约约束的一次执行周期；Work Item 是 Goal 内可整体接受的成果单元。

| 对象 | 状态 |
| --- | --- |
| Team | `open`、`archived` |
| Goal Draft | `draft`、`confirmed`、`deleted` |
| Goal | `queued`、`active`、`finalizing`、`completed`、`terminated`、`cancelled` |
| Work Item | `pending`、`in_progress`、`blocked`、`pending_decision`、`accepted`、`cancelled` |

Team 状态与 Goal 执行状态分离。`closed` 只表示当前 Goal 已结束，不等于 Team 被关闭或归档。

## Goal Draft 与 Queue

- 用户可在 Goal Draft 中准备未来目标；Main Agent 可创建和修改 Draft，但不能代替用户确认。
- 用户确认绑定 Draft ID、draft revision 与 hash。任一字段不匹配都拒绝。
- 确认后的 Goal 进入用户控制顺序的 Goal Queue，不能退回 Draft。
- 队列中的 Goal 可以取消，取消后成为 `cancelled`，不会重新回到草稿。
- Team 没有 Current Goal 时，调度器按队列顺序寻找第一个满足启动条件的 Goal。
- 不满足条件的 Goal 保持原队列位置并被跳过，不会自动移队或取消。
- 启动条件只证明可以尝试执行，不预测 Goal 一定成功。

## Current Goal

Team 最多有一个 Current Goal，状态为 `active` 或 `finalizing`。

- `goal_draft_*` 工具负责读取、创建和修改 Draft。
- 用户通过确认接口把精确 Draft 版本加入 Queue。
- 队列重排、取消、归档和恢复是命名用户操作，不使用通用状态写入。
- 新 Goal 启动后，Work Item、证据、审查、运行、消息上下文和最终交付都绑定其 Goal ID。
- 已完成或终止的 Goal 保留为历史，不被后续 Goal 覆盖。

## 收尾与 Finalization Cutoff

进入 `finalizing` 时记录当前 Team 消息序号作为 Finalization Cutoff。

收尾门禁只检查 cutoff 之前、发给 Current Goal Main Agent 且尚未被正常 coordination 回合消费的 Goal Inbox 消息。cutoff 之后的 Team Chat 和 Goal Peer Message 继续可见、可投递，但不会自动阻塞当前 Goal。

`team_finish` 的成功返回只表示收尾已请求。调用工具的回合实际结束，且没有未处理 cutoff 内消息、活动运行或待核实运行后，Goal 才能进入 `completed` 或 `terminated`。

用户可撤回尚未完成的 finalization；再次收尾会生成新的 cutoff。

## 失败与终止

- Agent Turn 失败不会自动终止 Goal；可重试、阻塞或由 Main Agent 调整工作项。
- 用户可显式终止无法继续的 Current Goal，结果为 `terminated`、`outcome=incomplete`。
- 无法确认旧 Main Agent 停止时进入交接注意状态，目标工作暂停，不允许双主控写入。
- Goal 结束后 Team 保持开放，用户可询问、解释和诊断；执行新工作必须确认新 Goal。

## 持久化

生命周期使用以下表：

| 表 | 内容 |
| --- | --- |
| `goal_drafts` | Draft、revision、hash、确认目标 |
| `goals` | 队列位置、目标版本、契约、cutoff、结果和终态 |
| `goal_contract_versions` | 每个 Goal 的契约版本与 hash |
| `goal_events` | Draft、Queue、启动、收尾和终止的追加记录 |
| `message_context` | 消息可选的 Goal/Work Item 关联 |
| `turn_inputs` / `panel_turn_inputs` | 回合实际消费的消息 |

`team_state` 保留整体 revision 和兼容投影，但 Current Goal 的权威状态来自 `goals`。约束索引阻止同一 Team 同时存在两个 `active`/`finalizing` Goal。

## HTTP API

所有写接口只接受命名操作，并在团队与 Main Agent 作用域内校验：

```text
GET  /api/teams/:id/goals
POST /api/teams/:id/goal-drafts/:draftId/confirm
POST /api/teams/:id/goal-drafts/:draftId/delete
POST /api/teams/:id/goal-queue/reorder
POST /api/teams/:id/goals/:goalId/cancel
POST /api/teams/:id/goals/:goalId/withdraw-finish
POST /api/teams/:id/goals/:goalId/terminate
POST /api/teams/:id/archive
POST /api/teams/:id/restore
```

写请求要求 JSON Content-Type；若携带 Origin，必须与面板同源。面板无需 Cookie 或密钥，仍校验 Host、`Sec-Fetch-Site` 和方法。

## Agent 工具

- `goal_draft_read`
- `goal_draft_create`
- `goal_draft_update`
- `next_goal_request`
- `team_finish`
- `finish_withdraw`

Main Agent 可创建 Draft 和提出下一目标，不能代替用户确认、终止或归档。普通成员不能修改 Goal 生命周期。

## 面板

`GoalLifecyclePanel` 与 Team 首页展示：

- Team 是否开放或归档；
- 无 Current Goal 状态；
- Goal Draft 的新增、编辑、确认和删除；
- Goal Queue 顺序、跳过原因和取消；
- Current Goal 的契约、工作项、运行、收尾和终止；
- 历史 Goal 的完成或终止结果。

完成 Goal 后仍可使用团队指令交流。面板不会把“无进行中目标”呈现为 Team 已关闭。

## 验证

```bash
node --disable-warning=ExperimentalWarning --test test/team-goal-lifecycle.test.mjs
node --disable-warning=ExperimentalWarning --test test/team-goal-http.test.mjs
node --disable-warning=ExperimentalWarning --test test/team-goal-integration.test.mjs
npm test
npm run check
npm run build
```

测试覆盖 Draft 版本确认、队列顺序、跳过、取消、归档/恢复、单 Current Goal 约束、消息上下文、消费与 cutoff、收尾门禁、终止、重启恢复、HTTP 参数和前端生命周期交互。
