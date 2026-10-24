# 宿主用量与会话统计设计

> 注:ADR 0004([通信内核优先](./adr/0004-revert-to-communication-core.md))已移除契约、工作项与目标生命周期等框架流程机制。本文中相关描述已过时,仅保留仍在实现的通信、遥测与宿主接入部分;流程相关段落以 ADR 0004 与 [README](../README.md) 为准。

本文定义当前产品使用的适配器采集与统计契约。Codex、Claude 和 DSH 通过 `context.onTelemetry()` 报告宿主观察，Bus 统一归属并写入 `telemetry_observations`；查询 API、团队页和全局概览读取同一份去重观测。查询响应字段与身份口径见[宿主遥测查询 API 契约](host-telemetry-api-contract.md)。

## 指标准入

统一产品指标必须至少有两种受支持宿主能够提供同义数据，或能够依据可靠数据计算。类型定义存在不能代替实际返回验证。宿主升级、模型路由或认证方式变化后，应重新验证能力。

指标准入与单条数据可用性分开：已纳入的指标仍可能在某次执行中缺失。缺失、部分和未知不能补零；明确报告的零是有效数据。没有可靠计算条件时不生成派生值。

## 统一指标

| 字段 | 定义 | 来源与计算 |
| --- | --- | --- |
| inputTokensTotal | 含缓存读写的完整输入 token | Codex inputTokens；Claude input_tokens + cache_read_input_tokens + cache_creation_input_tokens；DSH inputTokens + cacheReadTokens + cacheWriteTokens |
| uncachedInputTokens | 未缓存输入 token | Claude input_tokens、DSH inputTokens；Codex 完整输入减缓存读写 |
| cacheReadTokens | 缓存读取输入 token | 各宿主对应读取计数 |
| cacheWriteTokens | 缓存创建输入 token | Codex cacheWriteInputTokens、Claude cache_creation_input_tokens、DSH cacheWriteTokens |
| outputTokens | 宿主报告的输出 token | 包含宿主已计入的推理 token，不额外叠加 |
| totalTokens | 完整输入与输出之和 | 优先核对宿主 total；仅输入输出完整时可计算 |
| lastRequestInputTokens | 最近已完成模型请求的完整输入 token | Codex last.inputTokens；Claude assistant.message.usage；DSH assistant/message.usage 的输入三桶之和 |
| contextWindowTokens | 对应模型路由的上下文容量 | Codex modelContextWindow；Claude modelUsage.contextWindow；DSH route.context/contextPressure |
| lastRequestInputRatio | 最近请求输入相对上下文容量的比例 | lastRequestInputTokens / contextWindowTokens；须模型路由匹配、容量大于零且采样可关联 |
| cacheReadRatio | 缓存读取 token 占完整输入 token 的比例 | 同一统计范围 cacheReadTokens / inputTokensTotal；输入为零时无定义 |
| executionWallMs | 框架执行经过时间 | 从适配器 run 调用至 resolve/reject，以单调时钟测量；不包含调用前队列等待 |
| hostTurnWallMs | 宿主原生回合经过时间 | Codex turn.durationMs；Claude result.duration_ms；DSH turn/end.time 减 turn/start.time |

统一字段名以 `inputTokensTotal` 为 API 出口；宿主原始字段名（Codex `inputTokens`、DSH `inputTokens`、Claude `input_tokens`）保持原名，仅在归一化映射时使用。

比例内部使用 0–1 数值，展示时转百分比。不平均各回合比例；汇总缓存比例应使用汇总分子除汇总分母，并使用相同完整样本集合。输入占窗口比例是采样值，不跨 session 求和，也不对不同模型容量相加。它不是下一次请求占用预测。

宿主回合耗时与框架执行耗时分别保存。宿主内部包含的阶段不同，宿主耗时不解释为 API 净耗时。并发执行的耗时之和表示累计执行时间，不表示用户实际等待时间。

## 能力映射

| 能力 | Codex | Claude Code | DSH |
| --- | --- | --- | --- |
| token 与缓存 | thread/tokenUsage/updated | result.usage/modelUsage | status.step_end.usage；插件 tokenUsage 会话投影 |
| 最近请求输入 | tokenUsage.last | assistant.message.usage，按消息身份去重并更新最终值 | 插件 session/event 的 assistant/message.usage |
| 上下文容量 | tokenUsage.modelContextWindow | result.modelUsage，按模型匹配 | 插件模型路由与 contextPressure |
| 宿主回合耗时 | turn/completed 的 durationMs | result.duration_ms | 插件回合起止事件 time |
| 框架执行耗时 | 框架测量 | 框架测量 | 框架测量 |

DSH 插件属于适配器实现的一部分。未经插件采集的 CLI 输出不承诺包含上述所有指标。Claude assistant 输入值可能在多个事件中重复出现，不能逐事件累加；不以其尚未结算的输出值代替 result 最终输出。

独立推理 token、费用金额、API 净耗时、模型最大输出能力、下一请求预测占用、上下文组成均未满足至少两种宿主的同义实测条件，不纳入统一指标和产品展示。DSH 默认请求输出预算不等同于模型最大输出能力。首文本可见事件不能直接解释为模型首 token 延迟，亦不纳入。

## 归属与统计范围

适配器报告当前执行成员的数据。A 发消息触发 B 的宿主执行，消耗归 B；消息发送者是触发来源，不改变执行归属。

基础身份由框架绑定：groupId、memberId（Panel Agent 使用其自身稳定身份）、endpointId/session endpoint、sessionKey、hostSessionId、frameworkTurnId。原生 nativeTurnId、requestId、stepId、messageId 仅在宿主明确提供时记录。物理 session 标识须与宿主实例/命名空间共同构成身份，不能跨宿主按字符串合并。

累计数据绑定物理 session。一个 endpoint 可因执行域绑定多个 session；reset-session 后不得延续旧 session 的累计基线。框架只采集了部分会话时，派生累计必须标注采集起点，不能冒充宿主全量累计。

每条观测声明 scope（request、step、turn、session）、aggregation（delta、cumulative、snapshot）、source、observedAt，以及各字段的 quality（host_reported、derived、measured）与 completeness（complete、partial、unknown）。计算值保留依赖记录和公式。宿主报告容量不代表已独立验证上游真实容量。

## 回合输入与合并投递

框架通过 turn_inputs 或 panel_turn_inputs 将回合关联至实际投递消息，保留 message、additionalMessages 与 notes 的角色、消息编号和发送者。历史上下文中的成员消息不作为本回合新投递来源。

单一来源回合记录总消耗及消息来源。合并投递回合记录整批总消耗与全部消息/成员集合，不平均分摊、不拆分、不向每个成员重复计入全额。批次主消息不享有独占归因。

双人对话汇总双方明确关联到该对话的执行消耗。主 Agent coordination 会话中跨多个来源的合并批次独立展示，不纳入各对话独占小计。成员总消耗按执行成员统计；按消息来源的分析视图与执行归属统计分开，不相加。

## 去重、累计与完整性

1. Codex total 是累计快照，last 是最近请求，不保证覆盖整个多请求框架回合。相同快照重复到达只更新记录；恢复 session 时重发的旧 nativeTurnId 数据必须路由至原回合，不能归到当前活动回合。
2. Claude assistant 事件按宿主消息身份更新，不重复累计输入。result 是运行汇总，不能再与该运行内 assistant 统计相加。
3. DSH step_end 包含该步骤尝试的汇总；不能再叠加 assistant/message 或 session tokenUsage。某次尝试缺失用量时，步骤可能不提供完整汇总。
4. 累计差值仅在同一物理 session、顺序和回合边界明确、基线完整且计数未回退时使用。乱序、旧回合重发、计数重置或归属不明时保留原始观测，不强行生成回合值。
5. session 总量与回合总量是同一消耗的不同视图，不能相加。失败或取消不代表零消耗；保留已报告部分用量与完整性状态。
6. 输入总量、缓存子集和输出的归一化必须保持同一范围。计算得到负值或宿主 total 与输入输出不一致时标记异常，不修正为零或静默覆盖原值。

## 适配器接口与存储

适配器通过可选 `context.onTelemetry(observation)` 报告观测，保留 `run()` 返回最终文本的接口。由框架固定归属身份，适配器只能报告本次绑定宿主的观测。统一观测写入 `telemetry_observations`，指标事件不作为业务完成或接受的判断条件。

适配器声明每项指标为 direct、derived 或 unsupported，并描述所需事件、采样范围与完整性条件。支持能力不代表每条记录都有值。存储保留可更新的去重观测及派生关联，统计视图选取互不重叠的数据来源。

raw 仅保留与指标有关的白名单字段，不记录凭据、环境、提示词、消息正文或完整配置。模型标识、身份和输入消息关联复用框架已有来源记录。

## 验收要求

- 三种宿主的成功回合能产生归一化指标；直接值、派生值、零值和缺失值正确区分。
- 同一 session 连续回合、恢复后的旧回合通知、重复/乱序事件和 session 重置均不重复计数。
- 验证非零缓存读写的归一化；缺失缓存桶不擅自按零参与计算。
- 多请求/多步骤回合、重试、失败、取消与部分用量验证聚合边界。
- 单一来源与合并投递的输入关联可回查；共同批次不重复归因。
- 模型切换后最近请求输入与窗口容量不错误配对。
- 当前已有实测覆盖最小成功回合、DSH 请求/会话投影及 Codex 连续回合恢复和非零缓存读取；其他验收场景仍需验证。
