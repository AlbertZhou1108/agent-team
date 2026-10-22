# Team / Goal 重构实施计划

日期：2026-10-23
状态：设计完成，未开始业务代码实施

依据：

- [领域术语](../GLOSSARY.md)
- [ADR 0001：拆分 Team、Goal 与 Work Item 生命周期](./adr/0001-separate-team-goal-and-work-item-lifecycles.md)
- [ADR 0002：Goal 消息消费与收尾 cutoff](./adr/0002-bound-goal-message-consumption-and-finalization-cutoff.md)

## 1. 范围

本次重构解决以下问题：

- Team 不再因为 Goal 完成而表现为关闭或不可交流。
- Team 与 Main Agent 控制关系保持持久。
- Team 可以没有 Goal，也可以有多个 Goal Draft 和多个 Queued Goal。
- 用户确认 Goal Draft 后，Goal 进入可排序队列。
- 调度器只启动第一个通过启动准入检查的 Goal。
- Goal 收尾只等待 cutoff 之前发给当前 Main Agent 的 Goal Inbox 消息。
- Team 归档时冻结消息、Draft 和 Queue，恢复后继续使用原数据。

本次不包含：

- 修改模型策略及其选择方式。
- 新增多个并行 Current Goal。
- 让 Agent 自行确认 Goal Draft 或扩大授权。
- 把普通 Team 消息自动转换成 Goal。
- 删除或归档 Team 的历史数据。

## 2. 状态与不变量

### 2.1 Team

```text
open ⇄ archived
```

- `open` Team 接受普通交流，并允许调度 Goal。
- `archived` Team 保留消息、Draft 和 Queue，但不接受新消息、不调度 Goal。
- 有 Current Goal 时不能归档。
- Main Agent 控制关系属于 Team，不属于 Goal。

### 2.2 Goal Draft

Goal Draft 不是 Goal，没有 Goal 生命周期状态。

允许操作：

- 创建。
- 修改。
- 删除。
- 用户确认。

确认需要绑定 `revision` 与 `hash`。确认成功后生成一个 Queued Goal；未确认 Draft 可以删除。

### 2.3 Goal

```text
queued ──cancel──────────────→ cancelled
   │
   └─first-eligible──────────→ active
                                 │
                                 ├─finish request→ finalizing
                                 │                    │
                                 │                    ├─complete→ completed
                                 │                    └─withdraw→ active
                                 │
                                 └─terminate────────→ terminated

finalizing ──terminate────────────────────────────→ terminated
```

- 每个 Team 最多一个 `active/finalizing` Goal。
- Queued Goal 不由 `goal_version` 推断顺序，而由显式队列位置决定。
- 用户可调整 Queued Goal 顺序。
- 队列调度从上到下选择第一个通过启动准入检查的 Goal。
- 无法启动的 Goal 保留原队列位置并被跳过。
- 启动准入失败与 Goal 启动后的执行失败必须分开处理。
- `cancelled` 只用于启动前取消；启动后停止使用 `terminated`。

### 2.4 启动准入

只检查确定性前置条件：

- Team 为 `open`。
- Team 没有 Current Goal。
- Main Agent 控制关系有效且没有未完成的交接。
- Goal Contract 已确认。
- 必需成员存在且未移除。
- 工作区存在并可访问。
- Goal 要求的执行策略没有超过 Team Charter 或本次用户追加授权。
- 相关宿主当前可用。
- 必要的依赖或授权请求没有保持 pending。

启动准入不判断任务是否会成功。已经启动后的网络、模型、工具或成员失败属于运行失败，不把 Goal 自动放回队列。

## 3. 已确认的授权、交接与失败语义

本阶段开始前已经确认：

### 3.1 Goal Draft 确认

- 用户明确提出工作请求后，Main Agent 可以创建 Goal Draft。
- 用户必须确认 Goal Draft，才能生成 Queued Goal。
- 用户直接说“做这个”不替代对具体 Draft revision/hash 的确认。
- 超出 Team Charter 的权限在执行计划中显式展示，由同一次确认授权。

### 3.2 Main Agent 交接失败

交接必须撤销旧主 Agent 的后续写权限。无法确认旧回合结束时：

- Team 进入“交接待处理”，而不是无限静默等待。
- Goal 保持当前生命周期状态，但禁止继续派工和修改工作项。
- 用户可以选择重试停止、强制完成交接或取消交接。
- 强制完成交接后，旧控制版本写入必须被 fencing 拒绝。

### 3.3 运行失败传播

- Agent Turn 失败不自动终止 Goal。
- Work Item 根据错误进入 `blocked`、重试或有依据的取消。
- Main Agent 可以继续调度或向用户报告。
- 只有用户明确终止，或框架无法维持 Goal 一致性时，Goal 才进入 `terminated`。

## 4. 深模块接口

新增 `TeamGoalLifecycle` 模块，集中管理 Team、Goal Draft、Goal Queue 和 Current Goal。`Bus` 负责宿主运行与消息路由，`Collaboration` 保留 Work Item、证据、审查和成果职责。

外部接口保持较小：

```js
lifecycle.read(teamId)
lifecycle.apply(teamId, actor, command, expectedRevision, operationId)
lifecycle.advance(teamId, trigger)
```

`read(teamId)` 返回：

- Team 可交流与归档状态；
- Main Agent assignment；
- Current Goal；
- Goal Drafts；
- 有序 Goal Queue 和每项启动阻塞原因；
- Goal 历史摘要。

`apply` 接受的命令：

- `team.archive`
- `team.restore`
- `draft.create`
- `draft.update`
- `draft.delete`
- `draft.confirm`
- `queue.reorder`
- `queue.cancel`
- `goal.finish-request`
- `goal.finish-withdraw`
- `goal.terminate`

`advance` 是内部调度入口，可由以下事件触发：

- Goal 完成或终止；
- Team 恢复；
- Main Agent 交接完成；
- 成员、工作区或授权发生变化；
- 队列顺序变化；
- 某个阻塞原因被解除；
- 服务启动恢复。

接口约束：

- 所有写操作使用 Team 级 revision。
- 所有写操作必须带幂等 `operationId`。
- 队列调度在单个事务内完成。
- Goal 激活和 Current Goal 唯一约束由数据库共同保护。
- 不能通过重新创建同名 Goal 绕过 `cancelled` 或 `terminated` 历史。

## 5. 持久化设计

最终持久化拆为以下对象：

| 数据 | 内容 |
| --- | --- |
| `groups.state` | Team 的 `open/archived` |
| `groups.revision` | Team 状态、队列和 Main Agent 变更基准 |
| `team_charter_versions` | 持久成员、工作区和授权上限 |
| `goal_drafts` | Draft revision、正文、hash、确认/删除状态 |
| `goals` | Goal 生命周期、队列位置、cutoff、结果与时间 |
| `goal_contract_versions` | 每个 Goal 的契约版本、hash 和用户授权 |
| `goal_events` | Draft、队列、启动、收尾、取消和终止的追加式事件 |
| `work_items.goal_id` | Work Item 明确归属 Goal |
| `work_records.goal_id` | 工作记录明确归属 Goal |
| `user_outputs.goal_id` | 最终交付明确归属 Goal |
| `runtime_attempts.goal_id` | Agent Turn 所属 Goal，Team Chat 回合可为空 |
| `message_context.goal_id` | 消息所属 Goal，Team Chat 为空 |

`goals` 至少包含：

```text
id
group_id
number
state
queue_position
revision
cutoff_seq
outcome
final
finish_reason
origin_draft_id
created
started
ended
```

数据库约束：

- 每个 Team 的 Goal `number` 唯一。
- 每个 Team 最多一个 `active/finalizing` Goal。
- 只有 `queued` Goal 持有 `queue_position`。
- 同一 Team 的 Queued Goal 位置唯一。
- 终态 Goal 不持有队列位置。

## 6. 消息与消费

消息通过 `message_context.goal_id` 关联 Goal。`work_item_id` 不能替代 `goal_id`。

Goal Inbox 查询条件：

```text
message.kind = send
message.recipient = current Main Agent
message_context.goal_id = Current Goal
```

`note` 不单独阻塞收尾，随下一次输入交付；`system` 和 Team Chat 不阻塞 Goal。

消费证据来自正常结束的消费者 Turn：

- member Main Agent 使用 `turns` 与 `runtime_attempts.state=completed`；
- Panel Agent 使用 `panel_turns` 与 `panel_turns.state=completed`；
- `failed/cancelled/unknown/stopped` 不算消费。

收尾门禁：

```text
不存在未消费的 Goal Inbox Message
其中 message.seq <= goal.cutoff_seq
```

进入 `finalizing` 时原子保存 cutoff。撤回后清空 cutoff，再次进入时重新生成。Goal 完成后 cutoff 保留为历史事实。

现有 `message_dispositions` 不再作为完成门禁。若仍需展示“已处理结果”，应由 Work Item 或成果记录引用消息，而不是要求逐条填写理由。

## 7. 数据迁移

迁移必须采用 expand/backfill/contract 顺序，不直接原地替换所有表。

### 7.1 Expand

- 给 `groups` 增加 Team 状态和 revision。
- 创建 Team Charter、Goal Draft、Goal、Goal Contract 和 Goal Event 表。
- 给 Work Item、记录、输出、运行和消息上下文增加可空 `goal_id`。
- 保留旧 `team_state`、`contract_versions` 和 `goal_version` 直到新模型完成验收。

### 7.2 Backfill

- 每个现有 Team 增加 `open` 状态。
- `team_state.active` 迁移为 Current Goal `active`。
- `team_state.closing` 迁移为 Current Goal `finalizing`。
- `team_state.closed + completed` 迁移为 Goal `completed`。
- `team_state.closed + incomplete` 迁移为 Goal `terminated`。
- 所有现有 Team 默认仍为 `open`，不因历史 Goal 完成而归档。
- 现有每个 `goal_version` 迁移为独立历史 Goal。
- `contract_versions` 按时间和目标版本迁移为 Goal Contract。
- Work Item、工作记录、最终交付和运行记录通过 `goal_version` 回填 `goal_id`。
- 消息优先通过 Work Item 回填 Goal；无法可靠归属的消息保留在 Team Chat，不猜测。
- 现有 Group workspace 和成员生成 Team Charter v1。

### 7.3 Contract

新代码完全切换后：

- 停止读写 `team_state.phase`。
- 停止用 Team 级 `goal_version` 作为当前目标引用。
- 旧 API 字段保留一个兼容窗口并标注 deprecated。
- 完成迁移覆盖测试后再删除旧列和旧表。

迁移先在 `work/dev` 数据库副本上执行并保留备份。测试必须包含实际旧 schema fixture，而不只测试空库建表。

## 8. API、工具与 UI

### 8.1 用户 API

新增命名且受限的写接口：

```text
POST /api/teams/:id/archive
POST /api/teams/:id/restore
POST /api/goal-drafts/:id/delete
POST /api/goal-drafts/:id/confirm
POST /api/teams/:id/goal-queue/reorder
POST /api/goals/:id/cancel
POST /api/goals/:id/withdraw-finish
POST /api/goals/:id/terminate
```

读接口在现有 `/api/collaboration` 上返回新的 Team/Goal 投影，或新增等价接口。所有写接口继续使用现有本地 Host、同源、Cookie 和 JSON 请求约束。

### 8.2 Agent 工具

Main Agent 可读写可观察状态，并可提出 Draft。用户决定权保持独立：

- `goal_draft_read`
- `goal_draft_create`
- `goal_draft_update`
- `goal_finish`
- `goal_finish_withdraw`
- `work_item_update`

用户确认、删除 Draft、队列取消、队列排序、终止和归档通过可信 UI/RPC 入口完成。若允许 Main Agent代用户发起这些操作，也必须保存明确的用户来源。

### 8.3 UI

- Team 状态和 Goal 状态分开显示。
- 没有 Goal 的 open Team 显示普通交流入口。
- Current Goal、Goal Queue 和 Goal Drafts 分区展示。
- Draft 确认卡片显示 revision、hash、权限差异和开始条件。
- Queue 支持拖拽并显示每项启动阻塞原因。
- Goal 完成不再显示为 Team 已关闭。
- Archived Team 从普通 Team 列表移出，在设置中恢复。

## 9. 验收测试

### 9.1 领域状态机

- Draft 创建、编辑、删除和 revision/hash 冲突。
- 多个 Draft 和多个 Queued Goal。
- 确认只入队，不插队。
- 用户调整队列后顺序持久化。
- 队首被跳过，后续 Goal 启动。
- 全部 Goal 不可启动时无 Current Goal。
- 最多一个 Current Goal。
- 完成或终止后自动调度下一个 Goal。
- Current Goal 存在时不能归档。
- 恢复后队列调度继续。

### 9.2 授权与交接

- Main Agent 不能自行确认 Draft。
- 超出 Team Charter 的 Goal 没有授权时不能启动。
- 交接期间禁止派工并保留 Goal。
- 交接 unknown 不无限卡住，用户可选择终止或强制完成。
- 旧控制版本不能写入。

### 9.3 消息与收尾

- Goal Peer Message 不阻塞收尾。
- 普通 Team Chat 不阻塞收尾。
- cutoff 前未消费的 Goal Inbox Message 阻止完成。
- cutoff 后的消息不阻止完成。
- 正常结束 coordination Turn 的消费证据有效。
- failed/cancelled/unknown/stopped Turn 不算消费。
- 撤回收尾后生成新 cutoff。

### 9.4 恢复与迁移

- 服务重启后 Draft、Queue、Current Goal、cutoff 和阻塞原因恢复。
- 旧数据库完整迁移并可继续启动。
- 旧 `closed` Goal 对应 Team 全部保持 open。
- 迁移重复执行幂等。
- 新表约束阻止两个 Current Goal 和重复队列位置。

### 9.5 前端

- Team 无 Goal 状态。
- Draft 确认和删除。
- Queue 拖拽、取消和阻塞提示。
- Archived Team 的设置页恢复。
- Goal 完成之后仍可交流。
- 旧 `/api/collaboration` 数据在后端切换期间的兼容行为。

## 10. 分批交付

| 阶段 | 内容 | 退出条件 |
| --- | --- | --- |
| 0 | 独立提交当前已完成的 Panel Agent continuation 修改 | 工作树基线明确，完整测试通过 |
| 1 | 新表、Team/Goal 状态机、迁移 fixture | 已完成：核心状态、队列、归档、cutoff 和旧状态迁移测试通过；尚未接入 Bus/UI |
| 2 | Goal Draft、Queue 和调度器 | 已完成：队列、跳过、幂等、归档冻结和重启恢复测试通过；尚未接入 Bus/UI |
| 3 | `goal_id` 消息上下文、消费和 cutoff | 收尾门禁测试通过 |
| 4 | Bus、RPC、HTTP 和 Agent 工具接入 | 无旧 phase 读写，API 鉴权通过 |
| 5 | 前端 Draft、Queue、Archived Team 和状态拆分 | 前端测试、类型检查和浏览器验收通过 |
| 6 | 旧字段兼容与清理、文档更新 | `npm test`、`npm run check`、构建和真实回放通过 |

每个阶段应形成独立、可回滚的提交。阶段 1 开始前必须先确认第 3 节中的授权、交接和失败传播语义。
