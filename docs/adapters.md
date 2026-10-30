# CLI 宿主适配器接口

> 注:ADR 0004([通信内核优先](./adr/0004-revert-to-communication-core.md))已移除契约、工作项与目标生命周期等框架流程机制。本文中相关描述已过时,仅保留仍在实现的通信、遥测与宿主接入部分;流程相关段落以 ADR 0004 与 [README](../README.md) 为准。

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

## 状态检查与安装

`GET /api/hosts/installations` 仅读取内存中的安装阶段，不启动 CLI。安装期间前端只轮询该接口；进入设置页、手动检测和安装结束时才调用 `/api/hosts` 进行实际检查。

内置 CLI 适配器额外提供 `checkStatus()` 与 `install()`，设置页通过 `GET /api/hosts` 和 `POST /api/hosts/:name/install` 调用。安装请求只允许空 JSON 对象，不接受前端传入命令、包名或脚本。

- `available`：界面显示“已安装”，表示已定位到命令且 `--version` 成功。适配器只负责安装和安装状态检查；API Key、登录和模型配置由用户在宿主中自行完成，不提供连接测试或凭据管理。
- `missing`：未找到命令，界面显示安装按钮。
- `error`：定位或启动失败，展示原因。
- 安装进行中附带 `installing: true`，重复请求复用同一适配器实例的安装操作。失败允许重试，成功后再次检测。
- `installation.phase` 展示 `checking`（检查安装条件）、`installing`（执行安装）、`verifying`（确认安装结果）、`completed`（完成）或 `failed`（失败）。前端安装期间每两秒查询，不估算百分比；结果在服务进程内保留，服务重启后清空。

安装以服务运行环境为准：Windows 使用本机命令，WSL 使用 Linux 命令。Codex 和 DSH 使用 npm 全局安装，并启用 `--engine-strict`；Claude Code 使用官方 PowerShell（Windows）或 Bash（macOS/Linux）原生安装脚本。不自动安装 npm/curl、不自动提权，也不执行登录或模型调用。

检测复用宿主配置中的 command；自定义命令缺失时要求修正配置，不通过默认安装掩盖配置错误。安装结束后查询 npm 全局前缀或 Claude 用户安装目录，更新该适配器后续业务调用使用的命令，避免服务进程持有旧 PATH 导致安装后仍无法使用。

安装策略来源：[Codex 官方说明](https://github.com/openai/codex#installation)、[Claude Code 官方说明](https://code.claude.com/docs/en/setup)、[DSH CLI 包](https://www.npmjs.com/package/@deepseek-ai/dsh)。版本和平台依赖由安装器及 npm engine 检查决定；安装命令退出成功后仍必须通过本地启动检查。

## 回合上下文

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
| onReasoningDelta(text, metadata) | 可选；转发宿主已产生的思考过程增量（Claude `thinking_delta`、Codex `item/reasoning/textDelta`、DSH `llm/stream` 的 `reasoning-delta`）。只表示流式观察，不能替代历史中的思考记录；没有思考增量的宿主仍可正常完成回合 |
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

思考增量沿用同一 observer 通道：DSH observer 将 `llm/stream` 的 `reasoning-delta` 映射为 `framework.reasoning.delta` 帧并转发（2026-10 起的产品决定，覆盖早期"模型思考视为私有"的过滤；headless `thinking` 整块行不进 `onReasoningDelta`，只随原始事件落库供 trace 还原，避免与流式重复）。Bus 将思考增量累积进流记录的 `reasoning` 字段，经 panel/team 流以 `reasoning-delta` 事件实时发布，前端在流式气泡内以可折叠"思考过程"区展示。团队 reply 流覆盖协调会话响应用户输入的回合与全部双人会话回合（双人流的 `pairKey` 为双方成员、`recipientName` 为对端；最终文本不经 `publishOutput` 持久化，完成事件不带 messageId，由前端在消息落地后移除预览）。

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
