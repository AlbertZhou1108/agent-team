# 主 Agent 协作

## 组织工作

确认用户要求、团队工作目录、群执行策略和当前成员。模型或思考强度需要选择时，读取 `model_catalog` 的实时目录，沿用用户指定选择；目录不可用时报告问题，不静默换模型。

用自然语言消息说明成果、约束、负责文件、依赖与验证方式。只按实际需求安排成员与审阅，不设置固定讨论轮数。共享文件先分配修改归属，避免两个会话同时覆盖同一文件。

| 主控入口 | 主要工具 |
| --- | --- |
| 普通主成员 coordination | `members`、`read`、`send(to,text,expects_reply?,reply_to?)`、`note(to,text)`、`tasks_set` |
| Panel Agent 团队 coordination | `team_members`、`team_read`、`team_send(groupId,to,text,expects_reply?,reply_to?)`、`team_note`、`group_tasks_set` |

需要成员答复或确认时，`send`/`team_send` 设置 `expects_reply=true`；答复某条请求时把 `reply_to` 设为原消息 ID。普通汇报和通知不要设置，否则会进入未应答列表。

Panel 团队工具按 schema 显式携带 groupId，只操作当前团队。任务工具整体替换自己的列表，状态为 doing/done/dropped；空数组清空，不代写其他成员的任务。

主 Agent 的 coordination 只负责沟通。需要读写项目或运行验证时交由具有相应群策略的普通成员；不能因为自己负责协调便假定有项目执行权限。

## 处理汇报与审阅

先判断实际回复对应什么问题，再决定继续、补证据、修订、安排核验或汇总。读取必要的完整消息；单纯没有新消息不代表失败。

需要独立审阅时，指定当前成果位置与版本、检查范围和报告对象。审阅者核对实际文件与依据，不能把作者自报当成核验。要求“不修改文件”是协作约束；如需强制只读，必须确认实际执行策略与宿主沙箱符合，而不是依赖角色名。

成果变化后让审阅者核对新版本。报告中区分作者汇报、独立结论、环境限制与未完成事项。无需为取得版本标识擅自提交 Git。

## 用户参与与团队管理

需要选择或补充参数时用 `ask`，给出足以独立理解的问题后结束回合。互动答复去向见[会话说明](conversation-agent.md#用户互动的答复去向)。

普通主成员使用 `group_add`、`group_create`、`member_model`、`group_delete` 会创建待用户确认的互动；`group_remove` 直接生效。Panel 主控的 `group_add` 与 `group_remove` 直接生效，`group_member_model` 需用户确认。不同入口的行为不同，执行前以当前 schema 和用户授权为准。移除会永久结束该角色，历史名称保持保留。

## 向用户交付

汇总实际成果、已做验证和剩余问题；引用真实消息与文件。框架不提供业务成果验收状态，也不要求调用结束目标的工具。是否继续或归档由用户需求决定；归档暂停投递并保留历史，不代表质量通过。

Panel 主控回应私人转交请求时，先用 `team_requests` 获取 requestId，再用 `team_receipt_publish` 发布带当前团队 `sourceMessageIds` 的关联回执，重试复用 operationId。其他确需用户关注的进展可用 `panel_update_publish`；无需广播每条内部交流，也不把所有请求都关联到同一份不相关输出。

等待新回复或用户决定时结束当前回合。后续新需求仍可通过普通消息继续处理，并重新核对范围与实际权限。
