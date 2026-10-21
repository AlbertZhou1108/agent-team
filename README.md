# Agent Team

本机、单用户的 CLI Agent 协作框架。你只与主 Agent 聊天；Agent 通过群工具协作，主 Agent负责目标契约、统一调度、工作项、独立审查、成果接受和运行收尾。群可以长期复用，但同一时间只执行一个当前目标；目标版本、契约版本和宿主运行状态分别记录。

当前接入 Codex CLI/app-server、Claude Code CLI、DSH CLI。桌面应用适配后续再做，不把 CLI 接入算作桌面接入。

## 开始使用

要求 Node.js >=22.13，并已安装、登录需要的 CLI。首次使用需要安装前端构建依赖；运行数据仍保存在本机 SQLite，不依赖外部数据库。

```bash
cd /Library/Development/Projects/AgentProjects/agent-team
npm install
npm start -- --lead codex --members 配色=dsh,质感=claude --workspace /你的项目目录
```

这条命令启动本地群总线、输出只读面板链接，并进入“建群准备”对话。先告诉主 Agent 任务目标，主 Agent整理目标、范围、授权边界、确认事项、交付方式和可检查的完成条件。输入 `/contract` 查看当前草案；核对无误后输入 `/approve` 并明确确认。确认绑定具体草案版本和内容摘要，之后群、契约与初始成员原子建立，成员才开始自述能力并加入协作。

命令中的成员列表就是你的明确选择，不会偷偷替换失败的宿主。可将 `--lead` 改为 `claude` 或 `dsh`；成员也可使用相同宿主的多个独立实例。

第一次可先选一个成员以减少调用：

```bash
npm start -- --lead codex --members 助手=dsh --workspace /你的项目目录
```

输入自然语言，例如：“请让助手检查配色，并要求审查者独立复核证据。”成员发给主 Agent的汇报进入该群统一的调度会话，普通成员之间仍按双人上下文运行。用户私聊不自动进入团队上下文；成员回复也不会直接塞进用户私聊。主 Agent依据共享契约和工作记录继续、等待、返工、接受或收尾。

成员入群会调用模型自述能力，因此启动有正常的模型调用消耗。认证、模型可用性与模型额度仍由各宿主决定。框架不会静默切换模型。

## 协作闭环

| 阶段 | 用户或主 Agent 的动作 | 实际证据 |
| --- | --- | --- |
| 建群准备 | 主 Agent整理契约；用户确认具体 revision 与摘要 | preparation、契约版本、确认摘要 |
| 组织工作 | 主 Agent创建多人工作项并派发 | 参与成员、职责、策略、revision |
| 执行与审查 | 成员用 `send` 汇报；审查者独立提交意见 | 原消息编号、作者、成果版本 |
| 接受 | 主 Agent引用实际汇报和审查后接受成果 | 工作项状态、成果、证据与审查引用 |
| 完成目标 | 主 Agent覆盖完成条件、处理剩余消息并调用 `team_finish` | 当前目标版本进入 `closed`，最终交付进入历史；群保持开放 |

工作项状态为 `pending`、`in_progress`、`blocked`、`pending_decision`、`accepted`、`cancelled`。主 Agent管理写入需要 revision 和 `operationId`；过期写入会被拒绝，重复操作按同一操作编号幂等。取消必须说明责任覆盖或与目标无关。必要独立审查不得由成果作者自己提供。

收尾工具遇到尚未处理的正式消息会拒绝进入 `closing`，并返回需处理的序号和消息编号；主 Agent用 `dispositions` 逐条说明处理去向后可原子完成当前目标。完成请求在调用它的回合真正结束后、且没有未处理消息或待核实运行时才变为 `closed`。

这里的 `closed` 只表示当前目标已经结束，不表示团队被关闭。成员、会话、消息历史和最终交付继续保留，主 Agent与群成员仍可继续沟通、解释结果或追问；没有消息时不运行。后续回合默认仅沟通，不读写项目、不重新派工、不重开旧工作项，也不能改写历史交付。

无法完成时应由用户明确终止，保留阻塞、未完成工作和失败结果。失败目标同样只结束本轮执行，群仍可沟通和诊断，但不能自动恢复旧目标。

用户明确要求下一项执行任务时，主 Agent使用 `next_goal_request` 提交完整新契约；用户批准后，目标版本增加并重新进入 `active`。新目标拥有独立工作项、证据、审查和最终交付，上一版记录只读。聊天不会自动创建新目标。

## 继续已有群

默认数据位于运行目录的 `work/local`；可用 `--data /路径` 指定。停止进程不删除群。

```bash
npm start -- --group 启动时输出的群编号
```

Ctrl+C 或 `/quit` 会停止本次总线及其正在运行的回合。配置、消息和恢复发送进度留在本机；被中断或结果不确定的回合保留为失败或待核实，不会因为重启就自动重放。宿主自己的会话历史不删除。

## 本地命令

| 聊天命令 | 用途 |
| --- | --- |
| `/members` | 查看成员、宿主与能力自述 |
| `/state`、`/requests` | 查看契约、工作项、审查接受记录、运行与待用户决定 |
| `/direct 文本` | 向团队调度会话发送一条明确共享的用户指令 |
| `/decide 请求ID yes\|no` | 确认或拒绝契约变更、下一版目标、新增成员等待决定事项 |
| `/terminate 原因` | 用户明确终止未完成团队并保留责任与证据 |
| `/reopen 原因` | 撤回尚未关闭的收尾请求 |
| `/resolve 运行ID 核实依据` | 用户核实不确定运行已经停止 |
| `/add 名称=宿主` | 创建新角色及其新会话；名称在团队历史中必须唯一 |
| `/remove 名称` | 永久结束该角色，撤销访问并停止会话；名称和成员身份不会恢复 |
| `/stop 名称` | 尽力打断该成员的当前回合；不移除成员 |
| `/retry` | 手动重试尚未成功发送的输入 |
| `/groups`、`/use 群编号` | 查看群、切换私聊所处的群 |
| `/delete` | 确认后删除本群配置与消息，保留工作文件和宿主历史 |
| `/quit` | 离开当前交互入口 |

Agent 也可通过管理工具提议建群、加人。建群前契约与契约变更都由可信用户入口确认；无人值守的 `serve` 不替用户批准这些提议。用户私聊不自动转进群。

角色与会话采用永久绑定：删除角色后不提供恢复操作。后续如需同类职责，必须创建新的角色名称、成员 ID 和宿主会话。旧角色消息、可见共享历史和双人会话保留为只读记录。

## 独立运行总线与对话入口

如果需要在另一个终端保留总线：

```bash
# 终端一
npm start -- serve --data work/local
# 终端二：创建待确认的建群准备记录
npm start -- new --lead codex --members 助手=dsh --workspace /项目目录 --data work/local
# 准备与批准也可分步执行
npm start -- prepare --contract /路径/contract.json --data work/local
npm start -- approve --preparation <准备编号> --revision <版本> --hash <摘要> --data work/local
# 用返回的群编号聊天
npm start -- chat --group 群编号 --data work/local
# 或单次私聊
npm start -- chat --group 群编号 --text '读取群记录并汇总' --data work/local
```

群总线和 CLI 通过仅本用户可访问的 Unix socket 通信；面板只绑定 127.0.0.1，必须先打开启动时提供的带入口 key 链接。除当前团队的模型策略设置外，面板没有聊天、确认、角色管理或工作流写入口。

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

通过 `--hosts /路径/hosts.json` 加载。Claude、Codex 可额外设置 `model` 和 `reasoningEffort`；Claude 支持 `low`、`medium`、`high`、`xhigh`、`max`。DSH 本版使用其 headless profile 的模型，不编造未经验证的覆盖参数。`command` 可指定 CLI 的绝对路径。

契约保存团队最大授权；工作项保存实际访问需求和是否允许命令。回合默认 `communication`，执行者/协作者按工作项策略运行，审查者自动收窄到只读，主 Agent普通协调始终仅沟通。只有主 Agent被列为具体执行参与者时，相关回合才获得项目权限。工作项和实际回合都不能超过契约上限。

框架把有效策略归入 `communication` 与 `project` 两个逻辑域，但物理会话由 Adapter 决定。Claude/DSH 可跨域复用同一 session；Codex 的沟通和项目域使用不同 thread，项目 thread 内再切换只读和可写沙箱。框架持久保存 endpoint 与宿主会话域绑定，并记录复用或切换事实。

Codex 每回合明确 `readOnly`/`workspaceWrite` 沙箱策略，并裁剪原生命令、文件、浏览器和集成工具；Claude 通过内置工具集合和严格 MCP 配置限制入口；DSH 使用 invocation-only overlay、会话权限与 Agent scope 工具裁剪。三者都显式记录请求策略和实际配置。宿主无法支持所需策略时，工作项在写入前被拒绝。

框架不接受宿主原生子 Agent 越过团队身份和调度。Codex 若发起原生 `spawn/wait/agent` 类协同调用，适配器会请求中断并让该回合失败，而不是让团队回合长期等待。

宿主策略的覆盖范围是“该回合向模型暴露并经宿主执行的工具”，不是整台电脑的绝对隔离。文件策略不等于网络策略；DSH headless 的日志和字符串也可能被宿主自身截断。升级宿主版本后必须重新运行策略验证。

每轮观测会分别记录请求配置、宿主会话别名、助手消息实际报告的模型和结算标识。Claude 的思考强度在回合结束后从其项目会话记录核实；Codex 从启动或恢复响应核实。模型变化会追加新的 `framework.model` 事件。

### 模型目录发现

框架可按需读取每个宿主当前可选择的模型，不调用业务模型。Codex 使用 app-server 的 `model/list`；Claude 使用 stream-json 会话中的 `/model` 和 `/effort`；DSH 通过 invocation-only Cordis probe 调用 `modelCatalog`。Claude 和 DSH 的探测均不修改用户 profile。

```bash
# 需要已有 serve 或 start 总线
npm start -- models --data work/local
```

只读面板接口为 `GET /api/model-catalog`，结果缓存 30 秒；`?refresh=1` 强制重新探测。返回结构按宿主隔离失败，包含模型选择名称、展示名称、可用思考强度和默认值。Claude 的 CC Switch 或代理映射不参与目录命名，框架直接使用 Claude Code 暴露的名称；实际回合使用的模型仍由 `framework.model` 单独记录。

团队模型策略保存为 `mode` 和自然语言 `rules`。`mode=smart` 使用智能策略，`rules` 明确性能优先或成本优先及角色规则；`mode=user` 同样用自然语言描述用户规则。启动时可用 `--model-mode` 和 `--model-rules` 设置，未提供时使用平衡的用户配置规则。

首次建群时，准备会话的主 Agent通过 `model_catalog` 和 `team_plan_update` 为普通角色提出模型计划；框架校验目录、provider 和思考强度。若契约已提出但角色计划缺失，框架会让同一宿主的主 Agent执行一次严格 JSON 规划并自动纠正一次校验错误。主 Agent自身继承准备会话最后一轮成功运行的模型名称和核实强度。

每个角色分别保存 `model_provider`、`model` 和 `reasoning_effort`。普通角色按团队规则解析，主 Agent继承会话模型；不保存模式、规则匹配或选择理由。模型不存在或强度不受支持时，建群被拒绝，不静默回退。

新宿主可通过 `{"module":"/绝对路径/adapter.mjs"}` 导出 `createHost(options)` 接入，无需修改群路由核心。接口见 [适配器说明](docs/adapters.md)。

## 消息语义

- `send(to,text)`：一位接收者。发给普通成员时唤醒对应双人会话；所有发给主 Agent的正式汇报进入该群统一调度会话。
- `note(to,text)`：不唤醒；按接收成员积累，随它下一条正式消息合并为一次输入，发送者可不同。
- `read(after,limit,sender)`：按需分页读本群记录；`members()` 读取当前成员资料。
- `profile_set(text)`：只改调用者自己的能力自述。它不是能力等级或授权。
- 最终文本与群工具发言分开。沉默可以是一个回合的正常结果。
- 输入重发保留原消息编号；相同编号就是同一条消息。框架不保证副作用绝对不重复。
- 普通发送失败不自动重试，会记录系统通知；重启恢复未发送输入，或由用户 `/retry`。
- 同一双人会话串行，忙碌期间积压的消息按顺序合并到下一次输入；不同双人会话可并行，主 Agent调度回合始终串行。没有工作区文件锁，成员需协调文件修改。
- 需要等待新汇报时，主 Agent结束当前回合；不得调用原生子 Agent、`wait` 或阻塞式协同工具，框架会在新输入到达后启动同一个调度会话的新回合。

## 面板与当前限制

面板展示群、成员、自述、消息和群内宿主会话事件，按对话过滤并分页读取。会话页显示 `communication`、`project` 或宿主共享的 `default` 会话域。协作页展示有效契约、工作项状态、参与职责、权限与命令需求、成果版本、审查与接受、用户决定、目标结果、收尾状态、未处理消息和待核实运行。侧栏设置菜单可以切换主题并保存当前团队的模型策略；策略只影响之后创建的角色。面板没有聊天、确认、重试或角色管理写入口，也不会展示用户私聊。

事件视图来自实际观察到的宿主事件流。尤其 DSH headless 对部分字符串有自身截断，它**不等同于宿主原生完整历史查看器**。宿主历史仍以各宿主为准。

本版不直接接管已经在其他终端或桌面窗口运行的会话。CLI 对话由框架创建，并按宿主会话编号恢复。它们使用真实 CLI，但交互入口是本项目的终端对话界面，不是给现有官方交互式 CLI 窗口自动挂接。

Claude/DSH 的 print/headless 模式尚未验证独立的持久入队回执，因此本版保守地在成功回合返回后确认输入；崩溃窗口可能因此重发原编号。Codex 在 turn/start 返回后确认宿主已接受输入，不把它当成事情完成。

## 面板开发与构建

面板使用 Vue 3、TypeScript、Vite、Vue Router、Pinia、TanStack Vue Query、shadcn-vue 风格组件和 Reka UI。生产构建仍在同一个 Node 进程中与 `/api/*` 同源提供。

```bash
npm run build       # 构建 web/dist
npm run typecheck   # Vue 与 TypeScript 类型检查
npm run test:web    # 前端适配器测试
npm run dev         # Node API :62048 + Vite :5173
```

开发脚本会设置 `AGENT_TEAM_DEV_NO_AUTH=1`，因此可以直接打开 `http://127.0.0.1:5173/`，不需要在每次重启后重新设置 Cookie。该开关只影响开发启动脚本；直接启动 `src/cli.mjs`、执行 `npm start` 或运行生产构建时仍要求启动链接鉴权。开发模式仍保留 Host、跨站、请求方法和 `127.0.0.1` 绑定检查；唯一允许的 POST 是团队模型策略保存。

`npm start` 会先运行生产构建。若直接用其他进程启动 `src/cli.mjs`，请先执行 `npm run build`。Vue Router 使用 History 模式；Node 会先完成鉴权和 API 路由，再对非 API、非静态资源的页面路径回退到 `web/dist/index.html`。

## 验证

```bash
npm run check
npm test
# 使用真实 Codex/Claude/DSH 认证与模型；在独立项目和数据目录完成讨论、实现审查、阻塞终止与收尾
node --disable-warning=ExperimentalWarning scripts/verify-collaboration.mjs
# 打开结果中的 panelUrl，核对协作页后检查 API 与页面均保持只读
```

测试数据与报告在 `work/`，不提交到 Git。不使用或修改旧 collab-scene 的运行环境。

消息与宿主执行过程的双向关联、只读查询接口及隐私边界见 [docs/provenance.md](docs/provenance.md)。
