# Agent Team

本机、单用户的 CLI Agent 协作框架。你只与主 Agent 聊天；Agent 通过工具在群里一对一发言。群没有任务、完成、审查或生命周期状态。

当前接入 Codex CLI/app-server、Claude Code CLI、DSH CLI。桌面应用适配后续再做，不把 CLI 接入算作桌面接入。

## 开始使用

要求 Node.js >=22.13，并已安装、登录需要的 CLI。项目没有 npm 运行依赖，也不需要外部数据库。

```bash
cd /Library/Development/Projects/AgentProjects/agent-team
npm start -- --lead codex --members 配色=dsh,质感=claude --workspace /你的项目目录
```

这条命令启动本地群总线，输出只读面板链接，创建群并让成员自述能力，然后进入主 Agent 的对话入口。命令中的成员列表就是你的明确选择，不会偷偷替换失败的宿主。可将 `--lead` 改为 `claude` 或 `dsh`；成员也可使用相同宿主的多个独立实例。

第一次可先选一个成员以减少调用：

```bash
npm start -- --lead codex --members 助手=dsh --workspace /你的项目目录
```

输入自然语言，例如：“请让助手检查配色，要求它通过群工具把结果发给你。”主 Agent 的最终回复只给用户看。成员回复进入独立的双人会话；你需要汇报时，可问主 Agent：“读取群消息并汇总当前讨论。”不会把成员回复直接塞进你的私聊。

成员入群会调用模型自述能力，因此启动有正常的模型调用消耗。认证、模型可用性与模型额度仍由各宿主决定。框架不会静默切换模型。

## 继续已有群

默认数据位于运行目录的 `work/local`；可用 `--data /路径` 指定。停止进程不删除群。

```bash
npm start -- --group 启动时输出的群编号
```

Ctrl+C 或 `/quit` 会停止本次总线及其正在运行的回合。配置、消息和恢复发送进度留在本机，后续启动会继续发送尚未确认交给宿主的消息。宿主自己的会话历史不删除。

## 本地命令

| 聊天命令 | 用途 |
| --- | --- |
| `/members` | 查看成员、宿主与能力自述 |
| `/add 名称=宿主` | 按你的明确指令加入成员 |
| `/remove 名称` | 立即撤销该成员的框架访问，尽力停止它的回合 |
| `/stop 名称` | 尽力打断该成员的当前回合；不移除成员 |
| `/retry` | 手动重试尚未成功发送的输入 |
| `/groups`、`/use 群编号` | 查看群、切换私聊所处的群 |
| `/delete` | 确认后删除本群配置与消息，保留工作文件和宿主历史 |
| `/quit` | 离开当前交互入口 |

Agent 也可通过管理工具提议建群、加人。交互模式会请求用户确认；无人值守的 `serve` 不替用户批准这些提议。用户私聊不自动转进群。

## 独立运行总线与对话入口

如果需要在另一个终端保留总线：

```bash
# 终端一
npm start -- serve --data work/local
# 终端二：明确创建群
npm start -- new --lead codex --members 助手=dsh --workspace /项目目录 --data work/local
# 用返回的群编号聊天
npm start -- chat --group 群编号 --data work/local
# 或单次私聊
npm start -- chat --group 群编号 --text '读取群记录并汇总' --data work/local
```

群总线和 CLI 通过仅本用户可访问的 Unix socket 通信；面板只绑定 127.0.0.1，必须先打开启动时提供的带入口 key 链接。面板没有聊天或管理写入口。

## 宿主配置与新适配器

默认使用当前 CLI 的模型选择。要固定模型或给同一宿主设置多个别名，可提供本地 JSON：

```json
{
  "hosts": {
    "codex": { "adapter": "codex" },
    "writer": { "adapter": "claude", "allowEdits": true },
    "dsh": { "adapter": "dsh" }
  }
}
```

通过 `--hosts /路径/hosts.json` 加载。Claude、Codex 可额外设置 `model`；DSH 本版使用其 headless profile 的模型，不编造未验证的覆盖参数。`command` 可指定 CLI 的绝对路径。

Claude 默认 `permissionMode: "dontAsk"`，显式允许群工具，保留宿主自身的工具权限规则。`allowEdits: true` 额外允许 Read/Edit/Write/Glob/Grep；没有默认放开任意 Bash 或全局绕过权限。DSH 沿用其 profile 的权限，Codex 使用共享目录的 workspace-write、never 审批策略。工作目录不是框架的文件权限边界。

新宿主可通过 `{"module":"/绝对路径/adapter.mjs"}` 导出 `createHost(options)` 接入，无需修改群路由核心。接口见 [适配器说明](docs/adapters.md)。

## 消息语义

- `send(to,text)`：一位接收者，只唤醒对应双人会话的接收端。
- `note(to,text)`：不唤醒；按接收成员积累，随它下一条正式消息合并为一次输入，发送者可不同。
- `read(after,limit,sender)`：按需分页读本群记录；`members()` 读取当前成员资料。
- `profile_set(text)`：只改调用者自己的能力自述。它不是能力等级或授权。
- 最终文本与群工具发言分开。沉默可以是一个回合的正常结果。
- 输入重发保留原消息编号；相同编号就是同一条消息。框架不保证副作用绝对不重复。
- 普通发送失败不自动重试，会记录系统通知；重启恢复未发送输入，或由用户 `/retry`。
- 同一双人会话串行，忙碌期间积压的消息按顺序合并到下一次输入；不同双人会话可并行。没有工作区文件锁，成员需协调文件修改。

## 面板与当前限制

面板展示群、成员、自述、消息和群内宿主会话事件，按双人对话过滤并分页读取。不会展示用户私聊。

事件视图来自实际观察到的宿主事件流。尤其 DSH headless 对部分字符串有自身截断，它**不等同于宿主原生完整历史查看器**。宿主历史仍以各宿主为准。

本版不直接接管已经在其他终端或桌面窗口运行的会话。CLI 对话由框架创建，并按宿主会话编号恢复。它们使用真实 CLI，但交互入口是本项目的终端对话界面，不是给现有官方交互式 CLI 窗口自动挂接。

Claude/DSH 的 print/headless 模式尚未验证独立的持久入队回执，因此本版保守地在成功回合返回后确认输入；崩溃窗口可能因此重发原编号。Codex 在 turn/start 返回后确认宿主已接受输入，不把它当成事情完成。

## 验证

```bash
npm run check
npm test
# 使用当前真实认证与模型；会产生真实调用与测试会话
node --disable-warning=ExperimentalWarning scripts/smoke.mjs work/real-smoke
```

测试数据与报告在 `work/`，不提交到 Git。不使用或修改旧 collab-scene 的运行环境。

消息与宿主执行过程的双向关联、只读查询接口及隐私边界见 [docs/provenance.md](docs/provenance.md)。
