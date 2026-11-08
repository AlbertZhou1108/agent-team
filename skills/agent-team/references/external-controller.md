# 外部主控

## 会话开始

确认工具中存在 `control_protocol`、`control_teams` 和 `team_send`。先调用 `control_protocol` 读取当前协议与有效能力；协议返回只读或 MCP 不兼容时，不尝试创建团队、发送或改变控制权。

一个外部主控会话可以管理多个团队。团队工具必须显式传 `teamId`，不要依赖隐式当前团队，也不要把一个团队的私人内容带给另一个团队。

同一用户身份可能在多个宿主窗口登记了多个 binding。`control_teams` 的 `active` 表示当前 binding 是否持有团队写入席位；非 active binding 可以读取，但发送、改任务、答复决策、停止成员或归档前必须先调用 `team_activate`。取得席位后，原 binding 自动退为只读。

## 领取工作

调用 `control_inbox` 领取成员回复和需要用户处理的事件。只有持有对应团队 active 写入席位的 binding 能领取该团队的投递；领取是持久、幂等的，同一投递不会再次返回。顶层 Codex 连接可从宿主环境或外围启动器取得可恢复 thread，并通过 `codex exec resume` 重新注入 Agent Team MCP 后唤醒积压会话；唤醒消息只要求调用 `control_inbox`。Codex multi-agent 子会话不能由父级恢复，必须保持 pull-only，除非外围启动器明确绑定可恢复 session。其他没有主动注入能力的宿主退化为下次活动时拉取，不能声称成员消息已经即时送达。

`control_teams` 只返回当前 principal 控制的团队。`team_snapshot`、`team_members` 和 `team_read` 用于读取；读取正文时必须沿用返回的 `messageId`、`hash`、`offset` 和 `bodyLimit`，不要根据消息编号猜测内容。

## 创建与派发

`team_create` 的工作目录必须位于连接时登记的 `workspaceRoots` 内。默认使用 `read-only`；需要写入时显式选择策略，且不能超过当前绑定返回的 `policies`。成员格式为 `名称=宿主`。

`team_send` 会唤醒成员；`team_note` 不唤醒，随下一次正式输入交付。请求协助、审阅或确认时设置 `expectsReply=true`。`team_tasks_set` 只整体替换当前主控自己的计划。

外部主控通过团队获得的权限不能超过其当前宿主权限、注册工作区、团队策略和成员宿主能力的交集。尝试越权必须报告具体限制，不能静默换用更高权限。

## 用户决策

成员调用 `ask` 时，外部团队会生成 pending decision。用 `control_decisions` 查看问题和选项。确实需要用户决定时，主控在宿主会话中汇总并向用户提问；用户回答后，用 `team_decision_answer` 将结构化答复送还原成员。

不要把主控自己的猜测写成用户答复。答复请求属于团队；宿主会话更换后，新 active controller 仍可读取 pending decision，但只能由当前连接回答。

## 失败与边界

同步工具失败由 `isError` 返回，按错误内容修正参数或报告限制。异步投递、协议不兼容和待核实运行应通过 `control_status`、`control_inbox` 或控制事件暴露，不能只写静默日志。

外部主控可以归档团队，但不能永久删除。团队记录是协作事实来源；宿主原生转录只是副本。不要自动读取主控宿主的完整聊天记录，也不要假设打开相同宿主产品的新窗口就是已有成员会话。
