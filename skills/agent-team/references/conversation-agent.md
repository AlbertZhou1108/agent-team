# 会话与消息读取

## 定位与查询

已有明确团队上下文时沿用；没有上下文时先查询可见团队，必要时询问。读取到的状态只是本次观察，重要变化后补读。

| 入口 | 查询能力 |
| --- | --- |
| Panel Agent 私人会话 | `teams_list`、`team_snapshot(groupId)`、`team_members(groupId)`、`team_read(groupId, …)`；需要来源时使用 `team_message_trace`、`team_turn_trace` |
| 团队主成员 private 或普通成员 | 使用实际可用的 `read`、`members`；当前回合输入带有来源与执行策略 |
| 外部 Agent | 通过用户指定的数据目录使用公开 CLI `groups`、`state`、`members`，或面板读取接口；CLI 没有通用消息正文读取子命令 |

回答进度时区分：谁提出了什么、实际做了什么、有什么核验、还有什么问题。运行数为零、任务标记 done、成员说完成、团队归档，都不能单独证明结果正确。引用真实消息编号或当前文件，保留分歧和未验证部分。

## 读取完整消息

`read` 与 `team_read` 使用相同的正文读取机制，后者还需 `groupId`：

1. 用 `after`、`limit` 按需列出消息。`after` 是消息序号，不是消息 ID；默认每页 50 条，上限 200。当前 schema 的有界列表包含 `preview`、`ref` 和完整性标记，不保证正文完整。
2. 需要核对正文时，从已列出的消息取得 `id` 与 `ref.hash`，传入 `messageId`、`hash`、`offset`、`bodyLimit` 展开；单次正文上限 4096 个 Unicode code point。
3. 按返回的 `next` 和完整性标记继续读取，直到覆盖所需正文。偏移单位是 Unicode code point，不是字节或 JavaScript UTF-16 长度。哈希不匹配时重新列出，使用当前引用。
4. 列表分页使用 `nextAfter`；正文展开使用 `next`。两者分开保存。按团队和 sender 过滤条件分别维护列表游标，过滤查询不能证明全群已读。

旧会话可能返回兼容格式；以实际 `schema/view`、`text/preview` 和完整性字段判断，不把预览或截断事件当作全文。多个查询不是原子快照。

## 从私人咨询转交团队

Panel Agent 私人会话可以通过 `team_create` 按用户明确需求直接建群。观察中的团队需用 `request_team_takeover` 征询接管；交还用 `request_team_handback`。只在工具结果确认生效后报告关系已经改变。

关系为 main 时，用 `team_request_submit(groupId,text,operationId)` 把用户要求投递到团队 coordination；同一用户消息内的重试复用 operationId。等待结果时结束私人回合，由团队主控上下文组织成员。用 `team_requests` 查询请求与回执；来源通知和回执不会自动唤醒私人模型。

普通主成员 private 与 Panel 私人助手不同；需要共享执行指令时，使用 `/direct` 或团队输入入口。外部 Agent 已获用户明确共享授权且具备 CLI 能力时，可调用公开 `direct --group … --text … --data …`；只转交必要内容。

## 用户互动的答复去向

`ask` 发出 choice（2–8 个选项）或 input 卡后立即返回，发起者结束回合等待答复。需要用户连续确认多件事时，用同一个 `ask` 的 `steps` 一次发出 2–8 步：面板显示为一张卡片逐步作答，中途每步答复只推进进度，全部答完才把汇总答复作为一条用户消息送回，发起者只被唤醒一次。主成员的答复进入团队 coordination；普通成员的答复进入独立的“用户 ↔ 成员”会话，未必是原送审或协作会话。Panel 私人或团队主控发起的答复分别返回私人或该团队 coordination。需要延续的关键信息应在问题中写清，收到答复后按需读取关联消息。

互动卡是面板上的唯一展示面：卡片背后有一条只作答复线程与群记录的锚点消息，面板不再重复渲染它的正文，所以不要把卡片内容再发一遍普通消息。
