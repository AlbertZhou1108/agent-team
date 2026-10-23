# Panel Agent 当前实现

日期：2026-10-24
状态：当前实现

依据：[Panel Agent 设计](./panel-agent-design.md)、[团队指令与消息流](./team-directives.md)、[三档权限验证记录](./panel-agent-access-verification-20261024.md)。

## 身份与关系

- 每个数据目录最多一个 Panel Agent。
- Panel Agent 不写入普通成员表，也不能承担 Work Item 执行或独立审查。
- 对每个 Team 只存在 `observer` 或 `main` 关系。
- 每个 Team 同一时间只有一个 active Main Agent；Panel Agent 可主控多个 Team，上下文彼此隔离。
- Panel Agent 使用一条全局私人会话和每个 Team 独立的 coordination 会话。

## 创建与团队准备

Panel Agent 在 `/agent` 页面惰性创建，持久保存名称、宿主、模型、思考强度、私人工作区和访问级别。

创建团队复用标准 preparation：

1. 私人会话创建 preparation；
2. 生成完整 Goal Contract 和普通角色模型计划；
3. 面板展示精确 revision/hash；
4. 用户通过确认接口批准；
5. 团队创建、Panel Agent `main` 绑定和继续事件在同一事务提交；
6. 后续回合在已绑定 Team 中创建 Goal Draft、确认后执行。

模型不能自行批准契约、接管或交还。

## 接管与交还

接管前要求 Team 空闲、控制 revision 匹配且原 Main Agent 没有未核实运行。接管后原 Main Agent 暂停，Panel Agent coordination 获得管理写权限；交还后恢复原 Main Agent 并回到 observer。

接管、交还和用户决定均使用 revision 与幂等 operation。无法确认旧回合停止时，Team 进入交接注意状态，不允许双主控写入。

## 私人会话权限

Panel Agent 私人会话与团队契约分离：

| 访问级别 | 文件效果 |
| --- | --- |
| `read-only` | 工作区内、工作区外和临时目录写入被文件策略拒绝 |
| `workspace-write` | 私人工作区内可写，工作区外写入被拒绝 |
| `full-access` | 关闭文件沙箱，不代表网络或进程隔离 |

`workspace-write` 与 `full-access` 必须设置有效私人工作区；工作区不能等于或位于数据目录内。私人权限不成为 Team 执行授权，coordination 始终使用 `communication`。

Codex、Claude 和 DSH 的映射由适配器 `supportsPanelAccess` 声明，并通过带日期的真实宿主验证记录维护。修改 host、model、workspace 或 access 时重建对应宿主 session，保留框架聊天记录。

## API

```text
GET  /api/panel-agent
POST /api/panel-agent
POST /api/panel-agent/update
GET  /api/panel-agent/conversation
POST /api/panel-agent/messages
POST /api/panel-agent/stop
POST /api/panel-agent/resolve-runtime
GET  /api/panel-agent/teams
GET  /api/panel-agent/events
POST /api/preparations/:id/approve
POST /api/teams/:id/takeover
POST /api/teams/:id/handback
POST /api/panel-actions/:id/decide
```

浏览器 API 无需 Cookie 或密钥。写请求只开放命名操作，并校验精确 Host、`Sec-Fetch-Site`、JSON Content-Type、同源 Origin、team/controller revision 和业务权限。

## 流式消息

Panel Agent 私人回复通过 `/api/panel-agent/events` 推送 SSE 增量。团队 coordination 对用户的回复通过 `/api/teams/:id/events` 推送。

Agent 对任意成员调用 `send`、`note`、`team_send` 或 `team_note` 时，宿主公开的工具参数增量也形成独立消息草稿：

- DSH、Claude 的 `mcp__agent_team__*` 名称统一归一化；
- 不完整 JSON 由确定性解析器提取 `to` 和 `text`；
- 完整工具参数替换增量拼接，避免重复；
- 并行同名调用按 `callId` 与参数匹配；
- `note`/`team_note` 保持留言语义；
- 工具失败立即发布 `error` 并清理草稿；
- `complete` 携带持久 `messageId`/`messageSeq`，前端在查询缓存尚未追上时继续显示完成态，随后按 ID 去重。

隐藏推理和内部工具参数不进入用户或团队消息流。

## 持久化

主要表：

| 表 | 内容 |
| --- | --- |
| `panel_agents` | 身份、宿主/模型、工作区、访问级别 |
| `panel_sessions` | 私人或 Team coordination 的宿主绑定 |
| `panel_messages` | 私人及 coordination 的框架消息 |
| `panel_turns` | Panel Agent 框架回合 |
| `panel_history` | 私人或 coordination 的宿主事件 |
| `panel_team_bindings` | observer/main 关系 |
| `team_lead_controllers` | Team 当前控制者与 revision |
| `panel_updates` | coordination 到私人会话的持久更新 |
| `panel_action_requests` | 等待用户确认的接管/交还 |

## 验证

```bash
node --disable-warning=ExperimentalWarning --test test/panel-agent.test.mjs
node --disable-warning=ExperimentalWarning --test test/panel-agent-http.test.mjs
node --disable-warning=ExperimentalWarning --test test/panel-access.test.mjs
node --disable-warning=ExperimentalWarning --test test/panel-streaming.test.mjs
npm test
npm run check
npm run build
```

真实宿主验证使用 Codex、Claude 和 DSH 的当前已登录 CLI，在隔离目录测试三档权限、工具调用、会话恢复和产品 API。宿主升级或用户配置变化后重新运行验证。

## 已知限制

- Panel Agent 拥有文件/命令能力时，在 OS 用户权限内可以读取框架数据目录和其他宿主 session 文件；私人会话隔离不是 OS 用户隔离。
- `read-only` 不是整机只读，宿主 state/temp 仍可能写入。
- `full-access` 只表示关闭文件沙箱，不承诺网络或进程隔离。
- Claude 的 Write/Edit 必须使用路径规则，不能只依赖 Bash 沙箱。
- DSH 恢复 session 时必须在每次调用显式设置 sandbox mode。
