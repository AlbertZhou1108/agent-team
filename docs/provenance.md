# 消息与执行过程关联

框架在每次调用宿主前生成 `turnId`，独立于消息编号和宿主会话编号。同一消息恢复发送时保留消息编号，每次尝试生成不同的 turnId。

## 读取接口

沿用本机面板启动链接建立的 Cookie；所有接口只读。

- `GET /api/message-trace?message=<消息编号>`：返回 `source` 和 `inputAttempts`。
- `GET /api/turn?turn=<框架回合编号>&after=<事件序号>`：返回回合、原生回合引用、输入消息编号、输出消息及发送锚点、顺序事件。事件每页最多 200 条，用 `nextAfter` 继续读取。
- 原有 `/api/history` 每条事件增加 `turn_id`，旧事件为 null。

`source.kind` 为 group、private、system 或 unknown。group 包含 turnId、endpointId、eventSeq、框架 callId，以及可用时的 nativeCallId。eventSeq 精确指向框架收到 send/note 的调用事件；原生事件另外保留。一个回合发出多条消息时，各条消息共享 turnId，但发送锚点不同。

`inputAttempts` 表示框架发起调用的尝试，不能直接当成宿主已接受。查看该回合的 `framework.input_accepted` 事件判断适配器是否确认接受；Codex 在 turn/start 返回后确认，Claude/DSH 当前保守地在成功结束后确认。进程崩溃可能没有结束事件，这不证明宿主没有执行。

## 框架记录

框架记录输入、工具调用及结果、适配器暴露的原生事件，以及返回输出或异常。send/note 的出处在写消息时一并保存；身份、turnId 和调用编号由框架附加，不属于模型可填写的工具参数。过期回合的工具请求会被拒绝。

Codex 的原生 turn id 和 DSH 暴露的 turn 引用单独保存，结合宿主会话理解。Claude 若没有可靠的原生回合编号，保持为空。原生事件的详细程度受各宿主输出限制，不承诺提供宿主没有暴露的内部推理或完整历史。框架 callId 总是可用，nativeCallId 仅在适配器明确取得时提供。

## 隐私与兼容

私聊中主动发送到群的消息可以查询，但出处仅返回 `{ "kind": "private" }`，不公开私聊 turnId、输入或过程。直接查询私聊回合和不存在的回合都返回 404。私聊内容不写入共享 history。

数据库使用增量迁移保留旧消息和旧事件，不通过正文、时间相近等方式推测旧记录的关联；没有保存出处的消息返回 unknown。框架外直接写入或没有执行元数据的管理调用也保留为 unknown。

本次未修改面板样式和交互；未来 Vue 面板可组合这两个接口展示消息下的执行过程。
