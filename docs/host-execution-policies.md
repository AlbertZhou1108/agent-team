# 宿主执行策略

日期：2026-10-21
状态：已接入产品适配器；真实能力范围以宿主版本和验证记录为准

Agent Team 把契约和工作项转换成三种执行意图。框架负责传递策略、配置宿主、记录实际机制和运行事实；宿主的工具与沙箱负责其覆盖范围内的实际执行限制。

| 策略 | 允许 | 不默认允许 |
| --- | --- | --- |
| `communication` | 团队消息、协作读取和身份允许的管理操作 | 项目文件读取/修改、命令、浏览器和其他执行工具 |
| `read-only` | 沟通及项目读取、搜索、分析 | 项目写入、任意命令与外部操作 |
| `workspace-write` | 沟通、契约范围内的读取/修改及契约明确允许的必要命令 | Git 提交、部署、发布、外部发送等额外动作 |

策略按工作项选择，不与角色绑定。工作项只能从契约继承或收窄策略；不同策略的输入不会被合并到同一回合。

## 1. 统一记录

每个真实回合写入 `framework.policy`：

| 字段 | 语义 |
| --- | --- |
| `requested` | 契约上限、工作项需求与角色收窄后的有效 `mode` 与 `allowShell` |
| `mechanism` | 宿主工具集合、沙箱、审批及调用模式 |
| `scope` | 该机制实际覆盖的入口 |
| `verified` | 当前为 `configuration-applied`，表示请求配置已交由宿主应用 |
| `externalAccess` | 明确文件策略不等于全面网络限制 |

配置已应用不等于整台电脑绝对隔离，也不等于模拟了每个潜在绕过路径。拒绝事件、文件结果或工具不可用必须分别核实。

## 2. Codex app-server

产品适配器为每次线程启动/恢复传入：

- `readOnly` 或 `workspaceWrite` 沙箱；
- `approvalPolicy: never`；
- 关闭 shell、unified exec、apps、plugins、multi-agent、code mode、browser/computer use、image、skill search、workspace dependencies 等能力；
- 关闭用户配置中的其他 MCP 来源；
- 只注册当前角色和上下文允许的 `agent_team_*` dynamic tools。

`read-only` 与 `workspace-write` 在 `turn/start` 中再次显式指定沙箱。若旧数据或手工配置让同一 thread 绑定到不兼容签名，适配器仍会拒绝恢复并要求显式重置，不静默当作策略已切换。

Codex Adapter 对外提供两个会话域：`communication` 不含项目工具，`project` 在 thread 创建时启用项目工具。项目 thread 内的 `read-only ↔ workspace-write`通过 `turn/start` 切换沙箱；沟通域与项目域之间使用不同 thread，并由框架持久保存绑定。实测表明相同已加载 thread 的 resume、unsubscribe 或 fork 不能可靠替换完整工具配置。

Codex 仍可能向模型暴露原生 `collabAgentToolCall`。出现 spawn、wait 或 agent 管理调用时，产品适配器立即请求中断并让该回合失败；团队等待必须由框架的新回合投递完成。该防护防止第二套协调绕过团队身份，但不单独证明所有宿主内部调用路径都被禁用。

## 3. Claude Code

产品适配器使用 print 模式：

- `--strict-mcp-config` 与每回合生成的团队 MCP 配置；
- `--permission-mode dontAsk`；
- `--tools` 控制内置工具集合；
- `--allowedTools` 明确预允许框架 MCP 和策略允许的内置工具；
- `--settings` 禁用 hooks，并在允许命令时启用宿主沙箱。

| 策略 | 内置工具 |
| --- | --- |
| `communication` | 空集合，仅框架 MCP |
| `read-only` | Read、Glob、Grep |
| `workspace-write` | Read、Glob、Grep、Edit、Write |
| 任意策略且 `allowShell` | 追加 Bash，并启用 `allowUnsandboxedCommands: false` |

恢复会话时重新传入同一工具集合和权限配置。Claude 项目 JSONL 用于核实模型和思考强度，属于宿主内部格式，升级后必须回归验证。

## 4. DSH

产品适配器对每次 headless 调用生成 invocation-only patch：

- 注入团队 MCP；
- 设置专用 session 与 storage 根；
- 设置 sandbox workspace 和 `approval=never`；
- 为本次调用配置权限 preset；
- 加载 `src/hosts/dsh-policy.mjs`。

策略插件在 Agent 创建时显式设置 session sandbox，并通过 Agent scope `tools.restrict` 裁剪工具：

- `communication`：只保留本回合团队 MCP；
- `read-only`：追加读文件、图像、glob、grep；
- `workspace-write`：追加 write/edit；
- `allowShell`：追加 bash。

团队 MCP 未全部加载时策略插件拒绝启动任务。这样不依赖 profile 默认值，也不修改用户全局 DSH 配置。

## 5. 已知限制

- “沟通”和“文件只读”不等于网络、剪贴板、宿主日志或其他集成全部隔离。
- 框架数据目录及控制凭据仍与 Agent 处于同一 OS 用户边界；配置不得交给模型，但不能声称阻止所有任意本机绕过。
- DSH headless 可能截断部分事件字符串，面板不是宿主原生完整历史查看器。
- Codex 的部分内部事件（例如只读写入拒绝）不一定都出现在实时流；产品策略验证需与原始宿主会话或直接文件结果交叉核对。
- Claude/DSH 尚无独立验证的持久入队回执；成功回合结束后才确认输入。
- 宿主升级、用户设置变化或 MCP/插件来源变化后必须重跑策略和恢复验证。

隔离实验的原始命令、结果和证据见[宿主权限验证记录](./host-permissions-verification-20261021.md)。产品集成证据由真实三宿主验收和面板验收补充。
