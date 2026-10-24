# Agent Team

本机、单用户的 CLI Agent 通信框架。核心是一条多 Agent 消息总线：你与主 Agent 聊天，成员之间通过 `send/note/read` 在双人会话和统一调度会话中协作。框架只负责消息路由、回合调度、宿主接入和投递安全；任务分工、进度和完成标准由 Agent 在群消息里自行组织，不做框架级流程约束。当前接入 Codex CLI/app-server、Claude Code CLI、DSH CLI。

设计决策见 [ADR 0004 — 通信内核优先](./docs/adr/0004-revert-to-communication-core.md) 与 [减负方案](./docs/deload-plan.md)。

## 开始使用

要求 Node.js >=22.13，并已安装、登录需要的 CLI。运行数据保存在本机 SQLite，不依赖外部数据库。

```bash
cd /Library/Development/Projects/AgentProjects/agent-team
npm install
npm start -- --lead codex --members 配色=dsh,质感=claude --workspace /你的项目目录
```

这条命令启动本地群总线、输出面板链接、直接建群并进入对话。可选项：

- `--charter 文件`：一段纯文本团队说明（目标、边界、交付要求等），随每回合注入各成员上下文。它只是上下文，不是授权门禁。
- `--policy communication|read-only|workspace-write`：群执行策略，默认 `workspace-write`。主 Agent 的调度会话始终只有沟通权限；普通成员的双人对话按群策略获得宿主沙箱内的项目访问。

成员入群会调用模型自述能力，产生正常的模型调用消耗。认证、模型可用性与额度由各宿主决定，框架不静默切换模型。

## 通信模型

- `send(to,text)`：发给一位成员并唤醒对应上下文。所有成员发给主 Agent 的正式汇报进入该群唯一的调度会话，串行处理；忙碌期间的输入按顺序合并。
- `note(to,text)`：不唤醒，随接收者下一条正式消息合并交付。
- `read`：按需分页读取群记录；`members()` 查看成员；`profile_set` 只能写自己的能力自述。
- 普通成员之间是独立双人上下文，不同双人会话可并行。
- 主 Agent 需要等待新信息时结束当前回合；框架在新消息到达后用同一会话开启新回合。原生子 Agent 和阻塞等待工具被宿主侧裁剪。
- 输入重发保留原消息编号；普通发送失败不自动重试，可用 `/retry` 明确重试。
- 分工与质量把关没有框架状态机：主 Agent 用消息组织工作，用真实消息编号引用证据；审查是否充分由主 Agent 和用户判断。

## 执行策略与安全

策略域分 `communication` 与 `project` 两个逻辑域，物理会话由 Adapter 决定：Claude/DSH 可复用同一 session，Codex 的沟通域与项目域使用不同 thread，项目 thread 内再按策略切换只读/可写沙箱。每回合记录请求策略与实际配置；宿主无法支持所需策略时回合被拒绝。

框架保留的硬性安全机制只有四项：

1. **待核实运行闸门**：崩溃或中断的回合标记为 `unknown`，阻塞后续投递，需用户 `/resolve` 核实宿主已停止，绝不自动重放。
2. **指令幂等编号**：用户指令通过持久请求编号防网络重发重复派发。
3. **重启恢复语义**：配置、消息和未发送输入留在本机；停止进程不删除群。
4. **宿主沙箱策略域**：按群策略裁剪宿主工具与文件权限。

## 本地命令

| 聊天命令 | 用途 |
| --- | --- |
| `/members` | 查看成员、宿主与能力自述 |
| `/state` | 查看沟通状态与待核实运行 |
| `/direct 文本` | 向团队调度会话发送一条明确共享的用户指令 |
| `/resolve 运行ID 核实依据` | 核实不确定运行已经停止 |
| `/archive`、`/restore` | 归档或恢复群；归档停止投递，可随时恢复 |
| `/add 名称=宿主` | 创建新角色及其新会话；名称在团队历史中唯一 |
| `/remove 名称` | 永久结束该角色，撤销访问并停止会话 |
| `/stop 名称` | 尽力打断该成员的当前回合 |
| `/retry` | 手动重试尚未成功发送的输入 |
| `/groups`、`/use 群编号` | 查看群、切换私聊所处的群 |
| `/delete` | 确认后删除本群配置与消息，保留工作文件和宿主历史 |
| `/quit` | 离开当前交互入口 |

任务的"完成"没有框架审计：主 Agent 在消息里给出结论，你决定是否归档。归档只是暂停投递，历史保留，可随时恢复继续聊。

## 独立运行总线与对话入口

```bash
# 终端一
npm start -- serve --data work/local
# 终端二：创建新群（--charter 可选团队说明文件）
npm start -- new --name 群名 --workspace /项目目录 --lead codex --members 助手=dsh --data work/local
# 用群编号聊天
npm start -- chat --group 群编号 --data work/local
# 或单次私聊
npm start -- chat --group 群编号 --text '读取群记录并汇总' --data work/local
```

群总线和 CLI 通过仅本用户可访问的 Unix socket 通信；面板只绑定 127.0.0.1，无需密钥或 Cookie。

### Panel Agent

面板根路径 `/agent` 提供独立 Panel Agent：一条全局私人会话观察全部团队，可在用户确认后接管某团队的 coordination（原主 Agent 暂停，可交还）。Panel Agent 的私人会话支持只读 / 工作区写入 / 完全权限三档；coordination 仍只协调、不读写项目文件。团队创建在私人会话中直接完成（`team_create`），没有契约确认协议。

团队页通过 SSE 显示主 Agent 回复与 `send/note/team_send/team_note` 的工具参数增量；事件只携带新增片段，重连时由完整草稿快照恢复。

## 宿主配置与新适配器

```json
{
  "hosts": {
    "codex": { "adapter": "codex" },
    "writer": { "adapter": "claude", "allowEdits": true },
    "dsh": { "adapter": "dsh" }
  }
}
```

通过 `--hosts /路径/hosts.json` 加载。Claude、Codex 可额外设置 `model` 和 `reasoningEffort`；`command` 可指定 CLI 的绝对路径。角色模型默认使用宿主当前选择；角色创建从模型目录读取默认值，不静默回退。

新宿主可通过 `{"module":"/绝对路径/adapter.mjs"}` 导出 `createHost(options)` 接入。接口见[适配器说明](docs/adapters.md)。

模型目录探测：`npm start -- models`。面板设置页可保存全局模型策略（mode + 自然语言 rules），用于新建角色时的默认模型说明。

## 面板与当前限制

面板展示群、成员、消息、宿主会话事件、沟通状态与遥测，按对话过滤并分页读取。团队输入发自公共输入组件，发往当前主 Agent；忙碌时排队，使用持久请求编号避免重复派发。归档团队不能发送。

事件视图来自实际观察到的宿主事件流，不等同于宿主原生完整历史查看器。本版不接管已在其他终端运行的会话；CLI 对话由框架创建并按宿主会话编号恢复。

Claude/DSH 的 print/headless 模式尚未验证独立的持久入队回执，本版保守地在成功回合返回后确认输入；崩溃窗口可能重发原编号。

## 面板开发与构建

面板使用 Vue 3、TypeScript、Vite、Vue Router、Pinia、TanStack Vue Query、shadcn-vue 风格组件和 Reka UI。生产构建与 `/api/*` 同源提供。`web/` 是 npm workspace；运行 shadcn-vue CLI 时进入 `web/`。

```bash
npm run build       # 构建 web/dist
npm run typecheck   # Vue 与 TypeScript 类型检查
npm run test:web    # 前端适配器测试
npm run dev         # Node API :62048 + Vite :5173
```

`npm start` 会先运行生产构建。开发前端地址为 `http://127.0.0.1:5173/`。所有模式保留 Host、跨站、请求方法及 `127.0.0.1` 绑定检查；写接口统一校验 Origin。

## 验证

```bash
npm run check
npm test
# 使用真实 Codex/Claude/DSH 认证与模型；在隔离目录完成讨论、实现审查与材料缺失三个场景
node --disable-warning=ExperimentalWarning scripts/verify-collaboration.mjs
```

测试数据与报告在 `work/`，不提交到 Git。消息与宿主执行过程的双向关联见 [docs/provenance.md](docs/provenance.md)。

## 从旧版本升级

早期版本数据库中的契约、工作项、目标生命周期表会在启动时自动清除（见 `Store.migrate()`）；消息历史、成员、会话与遥测全部保留。`closing/closed` 相位、`team_finish`、`next_goal_request` 等概念不再存在；旧群一律回到 open 状态。
