# 消息与执行过程关联

> 注:ADR 0004([通信内核优先](./adr/0004-revert-to-communication-core.md))已移除契约、工作项与目标生命周期等框架流程机制。本文中相关描述已过时,仅保留仍在实现的通信、遥测与宿主接入部分;流程相关段落以 ADR 0004 与 [README](../README.md) 为准。

框架在每次调用宿主前生成 `turnId`，独立于消息编号和宿主会话编号。同一消息恢复发送时保留消息编号，每次尝试生成不同的 turnId。

## 读取接口

本机面板无需密钥或 Cookie，可直接访问普通链接。查询接口只读；团队操作面板不提供通用写 RPC。`POST /api/teams/:id/directives` 接收 text、operationId 和当前 controllerId，经 Host、跨站、同源和团队/主控检查后复用用户 directive 通道；同编号同内容幂等返回原消息。`GET` 同一路径返回最近 50 条发送回执，已投递仅表示宿主接收，不代表任务完成。归档/closing 团队拒绝新指令；closed 目标只允许既有沟通语义，消息不替代正式审批。全局模型策略使用 `POST /api/model-policy`。Panel Agent 使用命名的身份、私聊、准备确认、接管和交还接口，每个接口独立校验参数、团队作用域、控制者 revision 和同源请求。

- `GET /api/snapshot`：返回群、成员、群会话、活动运行和团队阶段摘要。
- `GET /api/collaboration?group=<群编号>&after=<记录序号>`：返回有效契约、工作项、证据引用、待用户决定、收尾状态、未处理消息、待核实运行和分页流转记录。
- `GET /api/message-trace?message=<消息编号>`：返回 `source` 和 `inputAttempts`。
- `GET /api/models?endpoint=<会话编号>&after=<事件序号>`：返回该群会话由观测推导的 `currentModel`、`currentReasoningEffort`、增量 `modelObservations` 和 `nextAfter`。
- `GET /api/model-catalog?refresh=0|1`：返回各宿主当前可选择的模型和思考强度；默认缓存 30 秒，`refresh=1` 强制探测。
- `GET /api/turn?turn=<框架回合编号>&after=<事件序号>`：返回回合、原生回合引用、输入消息编号、输出消息及发送锚点、当前模型摘要、整轮 `modelObservations`、顺序事件。事件每页最多 200 条，用 `nextAfter` 继续读取。
- 原有 `/api/history` 每条事件增加 `turn_id`，旧事件为 null。

`source.kind` 为 group、private、system 或 unknown。group 包含 turnId、endpointId、eventSeq、框架 callId，以及可用时的 nativeCallId。eventSeq 精确指向框架收到 send/note 的调用事件；原生事件另外保留。一个回合发出多条消息时，各条消息共享 turnId，但发送锚点不同。

`inputAttempts` 表示框架发起调用的尝试，不能直接当成宿主已接受。查看该回合的 `framework.input_accepted` 事件判断适配器是否确认接受；Codex 在 turn/start 返回后确认，Claude/DSH 当前保守地在成功结束后确认。进程崩溃可能没有结束事件，这不证明宿主没有执行。

## 框架记录

框架记录输入、工具调用及结果、适配器暴露的原生事件，以及返回输出或异常。send/note 的出处在写消息时一并保存；身份、turnId 和调用编号由框架附加，不属于模型可填写的工具参数。过期回合的工具请求会被拒绝。

Codex 的原生 turn id 和 DSH 暴露的 turn 引用单独保存，结合宿主会话理解。Claude 若没有可靠的原生回合编号，保持为空。原生事件的详细程度受各宿主输出限制，不承诺提供宿主没有暴露的内部推理或完整历史。框架 callId 总是可用，nativeCallId 仅在适配器明确取得时提供。

模型观测记录为 `framework.model` 事件，并通过 `modelObservations` 提供整轮汇总。`phase` 区分 requested、session、assistant、usage 和 verified；`source` 标明信息来自适配器配置、宿主会话、助手消息流、用量结算或宿主内部会话记录。`currentModel` 优先采用最新的 assistant 观测，再回退到 verified、session、requested，usage 不覆盖当前模型；`currentReasoningEffort` 优先采用 verified，再回退到 session、requested。Claude 在当前版本从项目 JSONL 核实 `reasoningEffort`，该格式属于宿主内部存储，升级后必须回归验证。Codex 的启动与恢复响应直接提供模型、提供方和思考强度。

每个回合还记录 `framework.session_scope`，标明逻辑策略域、Adapter 会话 key、复用的宿主 session 以及是否已存在绑定。`/api/snapshot` 的 `sessionBindings` 返回 endpoint 与各策略域物理会话的持久绑定；Codex 可出现 `communication` 和 `project` 两个 thread，Claude/DSH 默认是共享的 `default` session。

## 隐私与兼容

私聊中主动发送到群的消息可以查询，但出处仅返回 `{ "kind": "private" }`，不公开私聊 turnId、输入或过程。直接查询私聊回合和不存在的回合都返回 404。私聊内容不写入共享 history。

数据库使用增量迁移保留旧消息和旧事件，不通过正文、时间相近等方式推测旧记录的关联；没有保存出处的消息返回 unknown。框架外直接写入或没有执行元数据的管理调用也保留为 unknown。

Vue 面板通过前端适配层把这些原始记录聚合为 `TurnView` 和 `TraceStep`：合并 Codex 流式推理增量、配对统一工具调用与结果、过滤 Token 级宿主元数据，并保留原始事件视图。后端事件格式不需要修改；未知事件仍以原始 JSON 降级展示。
