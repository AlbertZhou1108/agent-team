# 无头协作控制面

[返回产品介绍](../README.md) · [架构](architecture.md) · [宿主适配](host-adapters.md)

本文定义 Agent Team 面向外部宿主的协作控制面。文中的“目标”不表示已经上线；实现状态以当前源码和测试为准。

## 当前实现状态

已经实现：

- 外部 principal、可撤销 client binding 和能力交集校验。
- 固定 stdio MCP shim，以及跨团队工具显式携带 `teamId`。
- 外部主控创建团队、读取快照/成员/消息、发送、留言、更新计划、停止成员和归档。
- 成员回复进入持久外部收件箱；`control_inbox` 领取后不会重复投递。
- 顶层 Codex 会话可通过相同的 `CODEX_THREAD_ID` / `CODEX_SESSION_ID` 自动绑定，或由外围启动器从 `thread.started` 调用 `bind_client_session`。Codex multi-agent 子会话的两值不同，不能由父级恢复，因此自动降级为 pull-only；显式 `AGENT_TEAM_HOST_SESSION` 可声明可恢复 session，`AGENT_TEAM_DISABLE_ACTIVE_WAKE=1` 可禁止自动绑定并清理旧 session，外围启动器后续显式绑定仍可恢复唤醒。MCP shim 保存可重建的唤醒配置，有积压事件时用 `codex exec resume` 重新注入 Agent Team MCP；唤醒后仍需调用 `control_inbox`。
- 成员 `ask` 在外部主控团队中转为 pending decision request；主控答复以 user-origin 消息唤醒原成员。
- Codex 主动唤醒使用 app-server 的 `thread/queue/add`；空闲线程会自动开始，只有收到真实 `turn/started` 才把 Client binding 标为 ready。
- ZCode 主动唤醒使用 ZCode Protocol（`zcode.cjs app-server --stdio`）的 `session/resume` + `session/send`，订阅事件流并等待真实 `turn.started`/`turn.completed`。ZCode 的 MCP 子进程不注入会话 id，主控会话在会话内执行 `agent-team connect --host zcode --session "$ZCODE_SESSION_ID"` 绑定（bash 子进程带该变量）。无头协议会话里权限审批无人可点，适配层按允许类选项自动放行；工具边界仍由群策略与框架负责。`AGENT_TEAM_ZCODE_HOME` 可把唤醒实例的 ZCode 数据目录重定向到隔离环境（真宿主验收用）。
- DSH 主动唤醒无需常驻服务：headless profile 的 `--session-id` 会采用已持久化会话续聊（未知 id 报错、会话 cwd 必须与原会话一致），每唤醒一个进程、退出即回合结束；agent_team MCP server 经唤醒 overlay 注入，无需用户配置。主控会话在会话内执行 `agent-team connect --host dsh --session "$DSH_SESSION_ID"` 绑定，且**必须建在团队工作目录内**（resume 强校验 cwd）。DSH 的 MCP 子进程会擦除 `DSH_*` 变量，绑定的会话 id 不会回写。DSH headless 一次性回合禁用凭据服务，API key 须从启动环境注入（真宿主验收脚本从本机 credentials 存储读取）。技能走 `~/.agents/skills` 共享入口（DSH 五级技能发现覆盖 user-agents；`~/.dsh/skills/agent-team` 已被自带实验插件占用，勿做副本安装）。
- 无头团队创建后先处于 provisioning；主动唤醒未验证时拒绝工作派单。用户可以显式接受 binding 级 Pull-only，重测成功后恢复。
- 无头成员模型可在 `team_create` 中以结构化成员指定，也可用 `team_member_model` 显式调整；两者都使用实时模型目录。
- 群策略是能力上限，成员有效策略与宿主能力取交集。`team_send.requiredCapabilities` 在写消息前拒绝能力不匹配的派单。
- 服务重启后保留 binding、pending delivery 和 decision。
- 控制协议不兼容时只暴露只读工具，写操作明确失败。
- `connect` 会为已知宿主安装或更新 Skill；重复连接轮换凭据，并把旧 Skill 目录保留为同级备份。
- 2026-11-08 已完成一次真实 Codex ↔ Claude Code 验收：Codex 创建团队并派单，Claude 回复进入收件箱，Codex thread 被 resume 唤醒，`control_inbox` 消费回复并写回验收任务。
- 2026-11-17 已完成一次真实 ZCode 双角色验收（`scripts/verify-zcode-host.mjs`，全隔离临时目录）：ZCode 主控创建团队并派单，Claude 回复进入收件箱，ZCode 会话被 `session/resume` 唤醒并领取回复、写回验收任务；ZCode 成员宿主在独立数据目录中执行指令并回复。2026-11-18 本机 ZCode.app 升级后，脚本已适配新版入口/配置布局与 Electron 启动约束并以系统 Node 包装启动复验 PASS；适配方式见[宿主配置与适配](host-adapters.md#zcode-桌面-app-的启动与版本适配)。
- 2026-11-17 已完成一次真实 DSH 双角色验收（`scripts/verify-dsh-host.mjs`）：DSH 主控经 headless resume 建团队、派单、被唤醒后领取回复并写回任务；DSH 成员宿主执行指令并回复。

尚未完成：

- 主动注入适配器：目前 Codex、ZCode、DSH 注册了主动唤醒驱动；Claude Code 与 WorkBuddy 保持持久收件箱拉取，直到其适配器实现正式注入能力。
- 多主控交接、远程连接和完整原生 TUI。

## 产品边界

Agent Team 的核心是宿主无关、无头优先的多 Agent 协作控制面。

- 外部宿主通过 MCP 和 Agent Team Skill 接入，不需要打开第一方客户端。当前可通过 `agent-team connect` 登记 binding 并取得 stdio MCP 配置。
- 第一方客户端与外部宿主是并行入口。客户端可以提供更完整的观察和管理体验，但核心控制能力不能只存在于客户端。
- Panel Agent 是第一方客户端的可选全局助手，不属于无头核心，也不是外部主控的统一抽象。
- Codex、Claude Code、DSH、ZCode 都只是成员适配器实例；WorkBuddy 是仅主控的外部 MCP 登记。产品语义不得依赖某个宿主。

## 角色

| 角色 | 含义 |
| --- | --- |
| 用户 | Agent Team 数据的所有者，也是永久删除等不可恢复操作的最终控制者 |
| 外部主控 | 用户正在使用、由宿主自行托管的长期会话；负责协调团队 |
| 托管成员 | 由 Agent Team 启动、唤醒和记录回合的宿主成员 |
| 外部参与者 | 只能通过 bridge 收发消息，但框架不能主动向其现有会话注入消息的宿主 |
| 观察者 | 只能读取被授权团队的角色 |

产品、宿主会话和团队角色是三个独立概念。打开同一个宿主产品的新窗口，不会自动成为已有成员、主控或观察者。

## 身份与控制权

- 一个 Agent Team 用户身份可以连接多个宿主会话。
- 一个外部主控会话可以管理多个团队。
- 每个团队同时只有一个 active controller session。
- 同一用户身份可以登记多个 client binding；其他连接可以观察，但写入前必须调用 `team_activate` 显式取得该团队的 active binding 席位。
- 新会话可以恢复已有团队；旧会话随即失去写权限。
- 移除 client binding 只撤销访问，不删除团队，也不自动转交控制权。
- 所有团队工具必须显式接收 `teamId`，不依赖隐式“当前团队”。

## 主控能力

宿主必须具备以下能力，才有资格成为外部主控：

1. 稳定 session 身份。
2. 向现有会话投递新消息；空闲时启动回合，忙碌时排队。
3. 观察运行状态和回合终态。
4. 返回失败、取消和不可用状态。

只支持 MCP 工具调用、不能接收新消息的宿主不能成为主控，但可以作为外部参与者。

适配器必须同时声明理论能力和连接时实测结果。工具集由二者共同决定；不能根据宿主名称猜测能力。

## 权限天花板

团队与成员的实际权限不得超过：

```text
主控当前宿主权限
∩ 团队工作区范围
∩ 团队策略
∩ 托管成员宿主能力
```

外部主控在其宿主权限范围内是受信主控，可以创建团队、选择策略和委派成员，不再要求模型之外的二次确认。

外部主控不能通过团队获得超过自身宿主权限的能力。超出权限的请求必须直接失败，由用户调整宿主权限；不得静默降级，也不得由 Agent Team 自动提权。

永久删除团队只能由用户通过 Agent Team CLI 或第一方客户端执行。外部主控可以归档团队。

## 投递

- `send` 自动唤醒接收方：空闲时启动回合，忙碌时排队。
- `note` 不唤醒，随下一次正式输入交付。
- 主控离线时消息持久排队；成员完成安全收尾，不自动启动替代主控。
- 异步控制事件复用普通 `deliver(envelope)`；宿主原生通知是可选增强。
- 主动唤醒与领取分离：`queued/started` 只表示宿主接受了唤醒并开始回合，`control_inbox` 领取后才表示客户端接受了输入。
- 同步工具错误通过 MCP `isError` 返回；只有无法附着到工具调用的异步异常才作为控制事件主动投递。

## 用户交互

无头控制面只定义两个核心交互原语：

- `notice`：只需用户知晓，不要求回答。
- `decision_request`：需要用户选择、输入或确认，并显式返回结果。

成员需要用户决定时，先向当前主控发出决策请求。主控汇总后询问用户，再通过结构化 `decision_answer` 送回原成员并唤醒。决策请求归属团队，不绑定原宿主会话；新的主控可以继续处理。

第一方客户端可以把决策请求渲染成交互卡，但卡片不是核心协议。

## 数据与隐私

- Agent Team 记录是团队协作事实的权威来源。
- 宿主原生转录是当前主控自己的副本，可能只包含注入过的内容和部分事件。
- Agent Team 不自动读取外部主控的完整宿主聊天记录。
- 主控必须显式提交团队简报；原始用户文本只有在主控主动提供时才能保存，并标记为主控转述。
- 托管成员的原始宿主 session 不提供受支持的外部 resume 入口。
- 用户绕过框架直接恢复托管成员 session 属于不支持的高级行为；由此产生的异常按 `unknown/failed` 处理，不自动修复。

## Skill 与协议版本

- Skill 采用薄启动入口 + MCP 运行时协议指南。
- Skill 带协议范围和内容哈希；`connect` 负责版本化安装与更新，未知宿主可用 `--skill-root` 指定目录。
- 已加载旧 Skill 的会话不会被热更新。
- 版本不兼容时允许只读查询，禁止会产生错误语义的写操作。
- 错误必须明确区分 Skill 过期、MCP 不兼容和宿主能力不足。

## 连接与网络边界

- 下一阶段只支持严格本机连接：Unix socket、Windows named pipe 或回环地址。
- 每个宿主使用 stdio MCP shim 连接本机 Agent Team daemon。
- 凭据按 client binding 限权、可撤销；不能因为能启动 MCP 命令就获得所有团队。
- 局域网、远程和云连接属于远期方向，不进入下一阶段硬目标。

## 当前开放边界（2026-11-19）

- 控制协议版本为 `1`，持久化 schema 为 `18`。旧库逐级迁移；较新 schema 不能被旧程序打开，发布说明必须注明。
- 对外主控、外部投递、decision、能力交集、workspace 路径边界、协议降级、双 binding 单写席位和归档暂停已有契约测试；其中前五项另用真实 Codex/Claude/DSH/ZCode/MCP 环境复验。
- Codex、DSH、ZCode 的主动唤醒具备真实回合启动证据；Codex multi-agent 子会话只能 pull-only，Claude Code 与 WorkBuddy 当前也保持 pull-only。
- Codex 主动唤醒回合使用 `read-only` sandbox；ZCode、DSH 继续走各自的会话或 headless 权限路径。唤醒不得绕过群策略与宿主沙箱。
- 服务重启后的 pending delivery 和 binding 已有契约覆盖，尚未把“真实团队在重启后继续处理”纳入本轮发布硬门禁。
- 当前只支持严格本机连接。远程部署、多主控同时写同一团队、完整原生 TUI 嵌入、所有宿主桌面产品适配、Panel Agent 与外部主控完全对等、强制隔离托管成员原生 session 不进入当前版本。

对外发布前仍需完成跨平台 CI、真实 `workspace-write` 成功路径、多个真实成员协作和重启恢复验收。
