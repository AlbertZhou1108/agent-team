# Agent Team 协作机制

日期：2026-10-24
状态：当前实现

依据：[产品概念](./concept.md)、[协作责任模型](./collaboration-concept.md)、[技术设计](./collaboration-technical-design.md)、[宿主执行策略](./host-execution-policies.md)。

## 实现范围

| 能力 | 实现位置 |
| --- | --- |
| 建群前契约、revision/hash 确认、幂等建群 | `src/collaboration.mjs`、`src/bus.mjs`、`src/cli.mjs` |
| 多成员工作项、证据、独立审查、接受和收尾 | Collaboration、Bus、框架工具 |
| Team、Goal、Work Item 分层生命周期 | `src/team-goal-lifecycle.mjs`、Store、RPC/HTTP |
| 主 Agent 统一 coordination | Bus、Store、各宿主适配器 |
| 用户私聊与共享记录隔离 | Bus、Server、Panel Agent |
| 策略域会话绑定与宿主策略映射 | Bus、`src/hosts/*` |
| 团队观测与用户指令 | Vue 面板、`/api/teams/:id/*`、SSE |
| 角色永久身份与会话绑定 | Collaboration、Bus、Store |
| 重启恢复、运行核实和通信边界 | Collaboration、Lifecycle、Bus |
| 信息投影与宿主遥测 | `src/information.mjs`、`src/telemetry.mjs` |

## 协作不变量

- 同一 Team 最多一个 Current Goal，Current Goal 状态为 `active` 或 `finalizing`。
- Main Agent 权限属于 Team，不随 Goal 创建或结束而伪造新身份。
- Work Item 属于一个 Goal；证据、审查、运行和交付显式绑定目标版本。
- Goal Contract 是权限上限，Work Item 继续收窄；reviewer 运行时最多 `read-only`。
- coordination、profile 和 private 默认使用 `communication`；项目执行只由工作项策略授权。
- 普通发送成功只证明消息记录或宿主接受，不证明执行、审查或目标完成。
- `closed` 表示当前 Goal 结束，Team 仍开放通信。新的项目执行必须通过新 Goal 契约并获得用户确认。
- 删除角色会永久结束该角色身份和宿主会话；历史名称不复用。

## 策略域

框架区分逻辑策略域和宿主物理会话：

| 域 | 用途 | 默认策略 |
| --- | --- | --- |
| `communication` | 私聊、调度、消息、工作项管理 | 仅沟通 |
| `project` | 工作项执行与独立审查 | 工作项策略，受 Goal Contract 上限约束 |
| Panel private | 用户与 Panel Agent 的私人会话 | 用户设置的 `read-only` / `workspace-write` / `full-access` |
| Panel coordination | Panel Agent 主控团队 | `communication` |

Codex 使用独立的 communication/project thread；Claude 和 DSH 在同一 session 内按每次调用重新应用工具和沙箱配置。适配器必须报告 `framework.policy`，且不能把配置已应用解释为整机或全网隔离。

## HTTP 与面板

面板只绑定 `127.0.0.1`，不要求密钥或 Cookie。请求校验包括：

- 精确 Host；
- `Sec-Fetch-Site` 不得为跨站；
- 写请求必须声明 JSON Content-Type；
- 请求存在 Origin 时必须与当前面板同源；
- 只开放命名写接口，不提供通用 RPC。

当前写接口类别：

- `/api/teams/:id/directives`：用户向当前 Main Agent 发送幂等团队指令；
- `/api/teams/:id/goal-drafts/:draftId/*`：确认或删除 Goal Draft；
- `/api/teams/:id/goals/:goalId/*`：取消、撤回收尾或终止 Goal；
- `/api/teams/:id/*`：队列重排、归档、恢复、接管和交还；
- `/api/panel-agent/*`：Panel Agent 身份、私聊、停止和运行核实；
- `/api/preparations/:id/approve`、`/api/panel-actions/:id/decide`：用户确认入口；
- `/api/model-policy` 和目录选择等本地设置接口。

团队页通过 `/api/teams/:id/events` 接收回复和成员消息草稿；Panel Agent 页通过 `/api/panel-agent/events` 接收私人会话增量。输入、草稿、排队和投递状态与私聊隔离。

## 宿主策略

- communication 关闭项目文件、命令和原生协同工具。
- workspace-write 只在 Goal Contract、Work Item 和宿主能力同时允许时开放。
- reviewer 收窄为只读；必要命令也需契约和工作项同时允许。
- Codex 原生 `collabAgentToolCall` 出现时立即中断，团队等待由框架消息唤醒完成。
- Claude/DSH 尚无单独验证的持久入队回执，成功回合返回后才确认输入；崩溃窗口仍可能重发同一消息编号。

三宿主具体映射见 [宿主执行策略](./host-execution-policies.md)。带日期的宿主验证记录只描述对应版本和能力矩阵。

## 验证

```bash
npm run check
npm test
npm run build
node --disable-warning=ExperimentalWarning scripts/verify-collaboration.mjs
```

真实宿主验收应在独立数据目录和项目工作区执行，覆盖讨论、文件实现、独立审查、返工、阻塞终止、重启恢复、通信保持和目标收尾。构建或测试通过不等于生产服务已重启或运行版本已切换。
