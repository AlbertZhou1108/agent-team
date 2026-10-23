# 团队会话输入与主 Agent 指令

团队面板逐步提供受控操作入口。团队会话输入发送到当前主 Agent 的 coordination，与 Panel Agent 私人会话隔离；不广播给所有成员，也不冒充成员。输入“批准”等文字不触发契约审批。closed 目标仍可交流，新执行任务依旧需要确认新目标；closing、归档和待核实运行沿用现有通信限制。

## 组件与草稿

`MessageComposer.vue` 从原 Panel Agent 输入区提取，复用既有 InputGroup、默认按钮、输入高度与键盘行为。模型选择、设置及停止运行通过插槽留给 Panel Agent 页面。Enter 发送，Shift+Enter 换行；中文输入法确认不发送。发送中和禁用时均拦截键盘/表单重复提交。

团队输入草稿按团队独立保存在本机 localStorage，与 Panel Agent 私聊草稿独立；发送中的状态保存在 Pinia，页面切换不取消请求。网络结果不明确时保留请求编号、原文本和原接收者，刷新后重试不会重复创建消息。正文编辑后创建新编号。成功响应只清除该次发送文本，不清除发送期间新输入的草稿。切换团队不会把草稿或完成回调应用到另一团队。

## HTTP 与持久幂等

- `POST /api/teams/:id/directives`：只接收 `text`、`operationId`、`controllerId`。文本 trim 后1–48000字符；编号1–128个字母/数字/下划线/连字符。
- `GET /api/teams/:id/directives`：返回最近50条界面指令的投递回执，不返回任何用户私聊。

面板无需密钥或Cookie；接口保留Host与跨站请求检查，POST统一检查提供的Origin及JSON Content-Type。Vite开发代理只将来自前端同源的Origin映射为后端Origin；跨源Origin原样转发并拒绝。不是通用RPC接口。

`team_directive_requests`按团队与operationId唯一，引用现有messages。新指令在事务中校验当前controllerId，再复用 `Bus.directive()`；主控变化时拒绝旧页面发送，不静默改投另一身份。同编号同文本/接收者返回原消息；不同内容拒绝，重启后仍有效。已记录消息的重试查询原回执，不重新派发，也不批量重试失败outbox。

## 状态语义

- `queued` / 已排队：消息已持久记录，尚无宿主接受依据；主 Agent忙碌时在其coordination串行排队。
- `delivered` / 已投递：现有outbox或panel_outbox的accepted已写入，只表示宿主接受输入，不代表执行成功或目标完成。后续运行错误单独显示。
- `failed` / 投递失败：未接受的投递存在明确错误；不会自动重发。
- `unknown` / 投递待核实：未有接受依据且对应运行处于unknown，不伪装已投递。

状态来源是既有消息关联、outbox、回合输入和运行记录，不根据模型最终文本猜测。Panel接管时自动进入Panel coordination，不写入其私人会话。

## 最终回复回流

界面指令对应的 coordination 回合成功结束后，框架将非空最终文本写入团队消息，发送者为该指令的主 Agent，接收者为用户，`reply_to` 关联原指令，并保留回合来源。已关联回复或同回合已有相同文本时不重复插入；给其他成员发送不同内容不替代用户回复。回复直接展示，不再触发 Agent 调度，也不影响目标是否完成。

普通成员主 Agent 和 Panel Agent 主控都会在用户指令回合发布 `team-stream`。团队页通过 `/api/teams/:id/events` 接收 `start` / `delta` / `complete`，在当前消息流末尾显示临时回复草稿；完整回复落库后重取消息并删除草稿。

Agent 对任意成员调用 `send` / `note` / `team_send` / `team_note` 时，消息正文同样来自宿主公开的工具参数增量，并作为独立草稿发布到对应团队的 `team-stream`。留言保留 `note` 语义；工具失败时立即发布 `error` 并删除草稿，不会留下永久“正在生成”状态。内部回合中的其他工具调用和隐藏推理不进入团队消息流。

`complete` 事件携带持久消息的 `messageId` 与 `messageSeq`。前端先以该 ID 展示完成态，再与消息查询结果按 ID 去重；即使增量完成后查询缓存尚未追上，消息也不会短暂消失。

仅处理 `team_directive_requests` 记录的输入，不回流私人会话或普通成员消息。失败、取消和空输出不伪造回复。重启会从已完成回合的持久最终输出中幂等补回缺失回复，无需重新调用模型；成员主 Agent 与 Panel Agent coordination 均适用。

## 验证

- `test/team-directives.test.mjs`：真实HTTP无Cookie访问/同源、参数与伪造身份拒绝、持久幂等与重启、忙碌排队、失败不重复派发、Panel主控路由与私聊隔离、closed通信和closing/归档拒绝。
- `web/src/stores/team-directives.test.ts`：团队隔离、网络失败/刷新复用编号、双重提交防护、保护发送期间新草稿。
- `MessageComposer.test.ts`：共享的实际发送处理函数，覆盖IME、换行与发送/禁用状态。
- 隔离fake宿主浏览器验收：表单发送、共享会话用户消息、已排队到已投递状态及底部布局；未使用真实模型或向用户团队派发消息。

最终回复回归覆盖消息关联、无额外 Agent 回合、历史输出恢复、重启去重、Panel Agent 私聊隔离以及空输出与失败回合。
