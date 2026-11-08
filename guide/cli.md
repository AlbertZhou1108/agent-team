# CLI 使用参考

[返回产品介绍](../README.md) · [开发环境](development.md) · [通信模型](architecture.md)

普通用户可优先使用[发行包和页面](quick-start.md)。本页适合从终端启动、指定混合宿主成员或查询团队的用户。

## 外部主控连接

无头控制面通过稳定的 stdio MCP shim 接入。首次连接使用一次登记命令；日常协作不需要打开 Agent Team 页面：

```bash
npm start -- connect --data /你的框架数据目录 \
  --host codex --client codex-main --principal 本机用户 \
  --workspace /允许创建团队的工作目录
```

命令会为 Codex/Claude 安装或更新 Skill，并输出 principal、binding、有效能力、Skill 内容哈希和可直接写入宿主 MCP 配置的 `mcp.agent_team` 配置。重复执行同一 `--principal` + `--client` 会轮换连接凭据，旧 Skill 目录保存在同级 `.backup-*` 路径。未知宿主用 `--skill-root` 指定安装目录，或用 `--no-install-skill` 跳过。

`--workspace` 是可创建团队的根目录；当前连接默认允许 communication/read-only/workspace-write，但每次 `team_create` 仍要显式选择策略。外部主控不能指定该根目录之外的团队工作区。

外宿主 Skill 应在会话开始时调用 `control_protocol`；需要领取成员回复或决策请求时调用 `control_inbox`。MCP shim 只有在宿主 thread 可确认时才会自动记录 Codex session：顶层会话的 `CODEX_THREAD_ID` 与 `CODEX_SESSION_ID` 相同；Codex multi-agent 子会话两者不同，不自动绑定唤醒 session，保持 pull-only。外围启动器仍可对 `thread.started` 调用受凭据保护的 `bind_client_session`；显式设置 `AGENT_TEAM_HOST_SESSION` 可声明可恢复 session，`AGENT_TEAM_DISABLE_ACTIVE_WAKE=1` 可禁止自动绑定并清理旧 session；外围启动器后续显式绑定仍可恢复唤醒。其他宿主当前采用持久收件箱，不承诺主动唤醒。

控制协议版本不兼容时，MCP 只暴露状态和读取工具。写操作会返回明确错误，要求更新 Skill 并新建或重连宿主会话。

## 启动与连接

在仓库根目录安装依赖后执行；`npm start` 会先构建前端。下面的路径都是示例，请替换为自己的目录。

```bash
# 独立启动总线
npm start -- serve --data /你的框架数据目录

# 在该总线上创建团队
npm start -- new --name 方案讨论 \
  --workspace /你的工作目录 \
  --lead codex --members 策划=claude,审阅=dsh \
  --policy workspace-write --data /你的框架数据目录

# 连接某个团队的私聊入口
npm start -- chat --group 团队编号 --data /你的框架数据目录

# 单次私聊
npm start -- chat --group 团队编号 --text '读取群记录并汇总' --data /你的框架数据目录
```

也可使用 `npm start -- --lead codex --members 助手=dsh --workspace /你的工作目录`，在同一个终端启动服务、建群并进入私聊。退出这个入口会停止它启动的服务；独立 `serve` 的生命周期另行管理。

`--charter 文件` 加载可选的纯文本团队说明，随每回合注入；它只提供上下文，不授予权限。`--hosts 文件` 指定框架的宿主别名和命令，见[适配说明](host-adapters.md)。原开发 CLI 默认数据为当前目录下的 `work/local`，与用户启动器的系统数据目录不同。

## 聊天命令

| 命令 | 用途 |
| --- | --- |
| `/members` | 查看成员、宿主与能力自述 |
| `/state` | 查看沟通状态与待核实运行 |
| `/direct 文本` | 向团队调度会话发送明确共享的用户指令 |
| `/resolve 运行ID 核实依据` | 核实不确定运行已停止；必须先有实际依据 |
| `/archive`、`/restore` | 归档或恢复团队 |
| `/add 名称=宿主` | 添加新角色和新会话；名称在团队历史中唯一 |
| `/remove 名称` | 永久结束角色，撤销访问并停止会话 |
| `/stop 名称` | 尽力打断该成员当前回合 |
| `/retry` | 手动重试未成功发送的输入，保留原指令编号 |
| `/groups`、`/use 团队编号` | 查看团队、切换私聊所处的团队 |
| `/delete` | 确认后删除团队配置与消息；保留工作文件和宿主历史 |
| `/quit` | 离开当前交互入口 |

普通私聊输入与 `/direct` 的消息可见范围不同。不要把私人消息当作已经共享给团队，也不要把消息编号当作任务执行成功的证明。

## 用户启动器

```bash
npm run launch -- --data /独立数据目录
npm run launch -- --data /独立数据目录 --status
npm run launch -- --data /独立数据目录 --stop
```

`--no-open` 启动服务而不打开浏览器，`--hosts` 可指定宿主配置。启动器会通过 IPC 验证实例后复用，不依据旧 URL 或 PID 文件盲目打开页面或停止进程。

模型目录查询：`npm start -- models --data /你的框架数据目录`。探测不应当作真实模型推理或额度验证。
