# CLI 宿主适配器接口

宿主用量、缓存、上下文与耗时的待实现采集契约见[宿主用量与会话统计设计](host-telemetry-design.md)。该设计定义统一指标准入、物理 session 归属、合并投递统计与累计去重；不代表当前接口已实现 `onTelemetry`。

宿主注册位于 server.mjs 的装配层；Bus 不判断宿主品牌。用户配置的 module 导出：

```js
export function createHost(options) {
  return {
    sessionKey({ policy }) { return 'default'; },
    async listModels() { return { /* 模型目录 */ }; },
    supportsPolicy({ policy }) { return { supported: true }; },
    async run(context) { /* 驱动一个宿主回合，返回该宿主最终文本 */ },
    async close() { /* 可选；释放本适配器启动的进程 */ }
  };
}
```

`options` 包含本机数据 directory、群总线 socketPath 和用户提供的配置。

`context` 包含：

| 字段 | 契约 |
| --- | --- |
| endpoint | 固定来源端点；id、group_id、member_id、context、peer、session、key。key 不可交给模型 |
| turnId | 本次框架运行尝试编号；工具调用必须与活动回合一致 |
| workspace | 团队成员回合为本群共享工作目录；Panel Agent 私人回合为私人工作区 |
| instructions / prompt | 入群规则及本次输入；两者不可自动广播 |
| tools | 该成员可使用的工具定义 |
| policy / previousPolicy | 本回合有效执行策略，以及上次已应用的策略签名 |
| modelSelection | 角色的 `model_provider`、`model`、`reasoning_effort`；Adapter 必须据此覆盖宿主默认选择 |
| onTool(name,args) | 在固定来源身份下执行工具，禁止模型选择来源身份 |
| onSession(id) | 尽早记录真实宿主会话引用；失败时不能静默创建另一个会话代替恢复 |
| onNativeTurn(ref) | 记录宿主明确暴露的原生回合引用 |
| onModel(observation) | 记录本轮请求、会话或消息报告的模型及可验证的思考强度；同一模型发生变化时再次调用 |
| onSelection(selection) | 报告可复用的宿主选择名称和核实强度；用于主 Agent继承，不能使用代理实际模型覆盖选择名称 |
| onPolicy(observation) | 记录请求策略、实际宿主机制、覆盖范围和验证状态 |
| onEvent(event) | 观察到的真实宿主事件；用户私聊的事件会由总线排除 |
| onAccepted() | 已验证宿主接受输入时调用；不表示工作或回合完成 |
| signal | 请求尽力停止当前回合；适配器必须让 run 最终退出 |

普通双人对话在双方各有一个宿主上下文，端点 context 为 `pair:对方成员编号`；成员发给主 Agent 的正式消息统一使用主 Agent 的 `coordination` 上下文。主 Agent 用户入口为 `private`，入群自述为 `profile`。成员身份跨这些端点共享，私聊、统一调度和双人上下文互不替代。

模型观测统一保存为 `framework.model` 事件。建议 observation 包含 `phase`、`model` 或 `models`、可用的 `reasoningEffort`、`provider` 以及 `source`；`phase: "assistant"` 表示执行中消息所报告的模型变化。没有可靠来源的字段保持缺省，不从模型自述或 token 数推测。Claude 的 `source: "claude.project_transcript"` 来自 Claude Code 项目会话 JSONL，属于当前 CLI 版本的内部存储格式，升级后需重新验证。

选择值另存为 `framework.model_selection`。Claude 等代理可能在 assistant 消息中报告映射后的实际模型，但角色和主 Agent继承的是 system init 暴露的选择名称。

Claude/DSH 使用框架生成的 MCP 启动配置。MCP 端点通过环境接收随机来源 key，调用时仅能在对应成员与群中执行；成员移除后，每次调用重新校验。随机 key 是内部接入信息，不是任务、绑定或凭据业务实体。

投递输入及其留言组合在调用宿主前持久化。恢复时重用完全相同的消息编号与内容。已接受标记、错误信息和消息附着关系只用于内部恢复，不表示任务状态，不对用户生成已读/已投递看板。

适配器必须报告宿主真实会话、回合结束和可核实的中断结果。内存中已无运行 Promise 不能证明进程停止；不确定状态应抛错并交由 Bus 标记为 `unknown`，不能伪造完成。

文本输出使用可选 `onTextDelta(text, metadata)` 回调。它只表示宿主已经产生的可见文本增量，不能替代 `run()` 的最终返回值；Bus 以最终文本校准并持久化消息。Codex 映射 `item/agentMessage/delta`；Claude 在 `stream-json` 中启用 `--include-partial-messages` 并映射 `content_block_delta/text_delta`；DSH 通过 invocation-only observer 拦截 `llm/stream`，只转发普通对话的 `text-delta`，并过滤 `session-title` / `compaction`，最后对 committed `text` 只补发尚未转发的后缀。没有增量的适配器仍可正常完成回合。

`sessionKey({policy})` 是可选能力，用于声明物理会话域。返回相同 key 表示同一宿主 session 可复用；不同 key 会持久绑定到不同 session/thread。Claude、DSH 默认复用 `default`，Codex 对 `communication` 与 `project` 返回不同 key。

`supportsPolicy({member,policy})` 可在工作项写入前声明能力。返回 `{supported:false,reason}` 时，工作项事务回滚，不会出现先派发再静默降级。运行前还会再次校验，防止旧工作项或宿主配置变化绕过。

`supportsPanelAccess({access})` 是可选能力，用于声明宿主是否支持 Panel Agent 私人会话的三档文件效果策略：`read-only`、`workspace-write`、`full-access`。Panel Agent 私人回合的 `policy` 带 `domain: 'project'`、`allowShell: true` 与 `access` 字段，`workspace` 是私人工作区；coordination 回合仍是 `communication`。三档的宿主等价映射与已验证限制见[Panel Agent 三档权限验证记录](panel-agent-access-verification-20261024.md)。

`listModels()` 是可选的零业务调用目录发现接口。每次返回一个宿主目录：

```js
{
  version: 1,
  host: 'host-alias',
  source: 'host-native-discovery',
  defaultModel: 'model-key',
  reasoningEfforts: [{ id: 'low', label: 'Low' }],
  models: [{
    key: 'unique-within-host',
    id: 'selection-id',
    label: 'Display name',
    reasoningEfforts: [{ id: 'low', label: 'Low' }],
    defaultReasoningEffort: 'low',
    isDefault: true
  }]
}
```

`id` 必须能作为该宿主的选择值；`key` 只要求在同一宿主的目录中唯一。模型可以直接使用宿主暴露的别名，不要求解析到厂商真实模型。目录发现不保存到团队数据库，也不产生 `framework.model` 业务回合事件。

若宿主暴露的额外工具会创建子 Agent、阻塞等待或绕过团队来源身份，适配器必须移除该工具，或在不安全调用出现时中断回合并返回明确错误。Codex 的 `collabAgentToolCall` 当前采用后一种防护。

桌面适配器后续可遵循同一接口，但必须另外验证来源身份、活动会话控制与历史范围，不能复用 CLI 的通过结论。
