# CLI 宿主适配器接口

宿主注册位于 server.mjs 的装配层；Bus 不判断宿主品牌。用户配置的 module 导出：

```js
export function createHost(options) {
  return {
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
| workspace | 本群共享工作目录 |
| instructions / prompt | 入群规则及本次输入；两者不可自动广播 |
| tools | 该成员可使用的工具定义 |
| onTool(name,args) | 在固定来源身份下执行工具，禁止模型选择来源身份 |
| onSession(id) | 尽早记录真实宿主会话引用；失败时不能静默创建另一个会话代替恢复 |
| onModel(observation) | 记录本轮请求、会话或消息报告的模型及可验证的思考强度；同一模型发生变化时再次调用 |
| onEvent(event) | 观察到的真实宿主事件；用户私聊的事件会由总线排除 |
| onAccepted() | 已验证宿主接受输入时调用；不表示工作或回合完成 |
| signal | 请求尽力停止当前回合；适配器必须让 run 最终退出 |

双人对话在双方各有一个宿主上下文，端点 context 为 pair:对方成员编号；主 Agent 用户入口为 private，入群自述为 profile。成员身份跨这些端点共享，私聊与双人上下文互不替代。

模型观测统一保存为 `framework.model` 事件。建议 observation 包含 `phase`、`model` 或 `models`、可用的 `reasoningEffort`、`provider` 以及 `source`；`phase: "assistant"` 表示执行中消息所报告的模型变化。没有可靠来源的字段保持缺省，不从模型自述或 token 数推测。Claude 的 `source: "claude.project_transcript"` 来自 Claude Code 项目会话 JSONL，属于当前 CLI 版本的内部存储格式，升级后需重新验证。

Claude/DSH 使用框架生成的 MCP 启动配置。MCP 端点通过环境接收随机来源 key，调用时仅能在对应成员与群中执行；成员移除后，每次调用重新校验。随机 key 是内部接入信息，不是任务、绑定或凭据业务实体。

投递输入及其留言组合在调用宿主前持久化。恢复时重用完全相同的消息编号与内容。已接受标记、错误信息和消息附着关系只用于内部恢复，不表示任务状态，不对用户生成已读/已投递看板。

桌面适配器后续可遵循同一接口，但必须另外验证来源身份、活动会话控制与历史范围，不能复用 CLI 的通过结论。
