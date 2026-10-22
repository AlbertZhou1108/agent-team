# shadcn-vue × DSH 集成方案：Skills、MCP 与 AI Elements

> 调研时间：2026-10-22（Asia/Shanghai）
> 环境：DSH `0.2.0-rc.2`（Electron desktop profile）、shadcn-vue CLI `2.8.2`、工作区 `/Library/Development/Projects/AgentProjects/agent-team`（Vue 前端在 `web/`）
> 说明：调研过程材料（文档盘点、DSH 实测、探测脚本、补丁样例）为本地临时产物，不随仓库提交；本文保留结论与可直接执行的配置。

---

## 0. 结论速览

1. **shadcn-vue 的 Agent 相关内容只有三块**：`/docs/skills`（技能包）、`/docs/mcp`（MCP Server）、`/docs/ai-elements`（Agent 前端 UI patterns）。`/docs/components` 是组件总览，其中 `Trace`、`Message`、`Message Scroller`、`Bubble`、`Code Block`、`Attachment` 等是 AI Elements 的底座。
2. **DSH 的三种接法完全不同**：
   - **Skills → 原生支持，本仓库已经生效**。技能已在 `.agents/skills/shadcn-vue/`，DSH 自动扫描（rank 200）。缺口只有两个：技能里 1 处 Claude Code 专属的 `` !`npx shadcn-vue@latest info --json` `` 动态注入 DSH 不执行；以及 `components.json` 在 `web/` 而不是仓库根目录。
   - **MCP → 无官方客户端，但可手工接入**。通过 `@deepseek-ai/dsh-mcp-client` 插件写一条 profile patch 即可；已用 DSH 同款 SDK 实测跑通 **7 个工具**，协议协商到 legacy `2025-11-25`。关键约束：新增行必须写成 `- insert:`、`cwd` 必须指向含 `components.json` 的 `web/`、建议固定版本（`@latest` 冷启 ~42s，逼近 SDK 60s 初始化超时）。
   - **AI Elements → 不是 DSH 配置项**。它是 Vue + Vercel AI SDK 的前端展示层 pattern（复制代码，无包、非 registry item）。DSH 自己的 Web 客户端是 React，不能直接复用；它的正确用法是让 DSH 在你的 Vue 项目里安装底座组件并落 pattern 代码。
3. **建议落地顺序**：① 在仓库根加 `AGENTS.md`，把「项目在 web/、先跑 `info --json`」变成 DSH 每轮可见的工作区指令；② 追加 MCP 补丁（固定 `2.8.2`）并验证；③ 需要 AI 聊天界面时再按 AI Elements 流程加组件。

---

## 1. shadcn-vue 文档里到底有什么

### 1.1 三个正式入口

| 栏目 | URL | 形态 | 一句话定位 |
|---|---|---|---|
| **Skills** | <https://www.shadcn-vue.com/docs/skills> | `SKILL.md` + 规则文件的技能包，装入 `.agents/skills/` | 给 AI 助手项目感知的 shadcn-vue 知识 |
| **MCP Server** | <https://www.shadcn-vue.com/docs/mcp> | stdio MCP server（`shadcn-vue mcp`） | 让 AI 助手通过工具查/装注册表组件 |
| **AI Elements** | <https://www.shadcn-vue.com/docs/ai-elements> | 21 个可复制的前端 pattern | 用 shadcn-vue 组件搭 Agent 交互界面 |

> `/docs/components`（用户给的 URL）是组件索引页，不含 Agent 专属说明；Agent 相关内容都在这三个栏目与它们的子页里。

### 1.2 Skills：装了什么、怎么工作

安装命令（skills.sh / vercel-labs `skills` CLI）：

```bash
pnpm dlx skills add unovue/shadcn-vue
```

装入位置：`.agents/skills/shadcn-vue/`，并在仓库根生成 `skills-lock.json`（记录 source / skillPath / computedHash）。本仓库**已经装好**，8 个文件与上游 `dev` 分支逐一 SHA-256 一致：

| 文件 | 内容 |
|---|---|
| `SKILL.md` | 入口：frontmatter、项目上下文注入、4 条 Principles、Critical Rules（样式/表单/组合/图标/CLI）、Key Patterns、组件选型表、9 步工作流 |
| `cli.md` | 全部 CLI 命令（`init`/`add`/`search`/`view`/`docs`/`diff`/`info`/`build`）、presets、templates、smart merge |
| `customization.md` | CSS 变量、OKLCH、暗色模式、变体，Tailwind v3/v4 差异 |
| `mcp.md` | MCP 搭建、5 种编辑器配置、7 个工具、registries 与鉴权 |
| `rules/{styling,forms,composition,icons}.md` | 强制规则与 Incorrect/Correct 代码对 |

工作原理（文档 “How It Works”）：检测 `components.json` → 运行 `npx shadcn-vue@latest info --json` 注入项目上下文 → 用 Critical Rules 约束生成 → 用 `docs`/`search`/MCP 先查文档再写代码。

**frontmatter 字段**：`name`、`description`（必填）、`user-invocable: false`（Claude Code 扩展）、`allowed-tools`（Agent Skills 规范字段，本条限定 npx/pnpm dlx/bunx 三种 runner）。

**唯一的 Claude Code 专属注入**（`SKILL.md:17`）：

````markdown
```json
!`npx shadcn-vue@latest info --json`
```
````

Claude Code 会在模型看到技能正文前执行并把该行替换为输出；**其他宿主不执行，会保留字面命令**——这是 DSH 适配的关键点（见 §2.1、§3.1）。

### 1.3 MCP Server：7 个工具、5 种客户端、没有 DSH

```bash
shadcn-vue mcp        # 启动 stdio MCP server
shadcn-vue mcp init   # 写编辑器配置
```

- 传输：`StdioServerTransport`；`serverInfo = { name: "shadcnVue", version: "1.0.0" }`；capabilities 声明 `resources`/`tools`，但**只实现 tools**（无 prompts，resources 是空壳）。
- `mcp init --client` 硬编码枚举：**claude / cursor / vscode / codex / opencode** —— **没有 DSH**；文档也只列这 5 个客户端。
- 7 个工具（原始名，无前缀）：

| 工具 | 参数 | 用途 |
|---|---|---|
| `get_project_registries` | 无 | 读 `components.json` 的 registries（无文件时回退内置 `@shadcn`） |
| `list_items_in_registries` | `registries[]`、`limit?`、`offset?` | 列出注册表条目（含建议 add 命令） |
| `search_items_in_registries` | `registries[]`、`query`、`limit?`、`offset?` | 按名称/描述模糊搜索 |
| `view_items_in_registries` | `items[]` | 查看条目详情，**含完整文件内容** |
| `get_item_examples_from_registries` | `registries[]`、`query` | 查用法 demo 的完整源码与依赖 |
| `get_add_command_for_items` | `items[]` | 返回建议的 CLI 安装命令 |
| `get_audit_checklist` | 无 | 组件检查清单（imports/依赖/lint/TS） |

- registries 配在 `components.json`：名字必须以 `@` 开头、URL 必须含 `{name}`；私有注册表用 `headers` + `${VAR}`，MCP 启动时加载 `.env.local` 等。
- 工具内部用**子进程 `process.cwd()`** 读 `components.json`，**不向上查找**；`mcp --cwd` 只影响 `.env` 加载，不能替代进程工作目录。
- 能力边界：MCP 只覆盖 registry 的 search/view/install/audit；项目配置（aliases/framework/Tailwind 版本）只能跑 CLI `info`（技能原文：“there is no MCP equivalent”）。工具描述提到的 `init_project` 在 2.8.2 中并不存在。
- `mcp init` 有写盘副作用：合并客户端配置文件，并把 `shadcn-vue@latest` 写进项目依赖。

### 1.4 AI Elements：21 个 pattern，不是包、也不是 registry item

官方定义：“AI Elements are patterns for building agentic interfaces… **There is no package to install. The code is yours.**”

- 21 个 pattern（按用途归类）：

| 分类 | Patterns |
|---|---|
| 会话与输入 | Chat、Message、Prompt Input、Suggestion、Model Selector、Context、Checkpoint |
| 推理与计划 | Reasoning、Chain of Thought、Plan、Task、Queue |
| 工具与执行 | Tool、Confirmation、Terminal、File Tree、Stack Trace、Test Results、Subagent |
| 引用与来源 | Sources、Inline Citation |

- 安装方式：先 `add` 底座 registry item（如 `npx shadcn-vue@latest add trace code-block`），再把 pattern 页面的代码复制进项目；每个 pattern 页有 Installation（CLI/Manual）与 “Copy prompt”（可直接丢给编码 agent）。
- 底座组件（属于 registry item）：`Trace`、`Code Block`、`Bubble`、`Message`、`Message Scroller`、`Attachment`、`Hover Card`、`Spinner`、`Typography`、`Marker`、`Kbd` 等（均在 `/docs/components` 里）。
- 数据形状对齐 **Vercel AI SDK**：`UIMessage.parts`、`@ai-sdk/vue` 的 `Chat`，是纯前端展示层，不提供 agent 运行时/协议。

### 1.5 三条产品线的区别

| 内容 | 解决什么 | 对 DSH 的接入方式 |
|---|---|---|
| Skills | 「怎么写对」的知识与规则 | 技能目录，DSH 原生扫描 |
| MCP Server | 「查/装什么」的工具通道 | profile patch 挂 MCP client |
| AI Elements | 「长什么样」的前端代码 | 无 DSH 运行时配置；经 skill/MCP 在 Vue 项目里落地 |

---

## 2. DSH 侧的对应机制

### 2.1 Skills：目录扫描 + frontmatter，不执行内嵌命令

DSH 的 `dsh-skill-filesystem` 按 rank 扫描 5 个根目录（数字小的优先，同名技能低 rank 胜出）：

| Rank | Source | 路径 |
|---|---|---|
| 100 | project-dsh | `<projectRoot>/.dsh/skills` |
| 200 | project-agents | `<projectRoot>/.agents/skills` |
| 300 | custom | `customSkillDirs`（配置） |
| 400 | user-dsh | `<dshHome>/skills`（默认 `~/.dsh/skills`） |
| 500 | user-agents | `<agentsHome>/skills`（默认 `~/.agents/skills`） |
| 600 | bundled | `bundledSkillDir` |

- 格式：`<name>/SKILL.md`（或顶层 `<name>.md`），YAML frontmatter 必填 `name`（kebab-case）、`description`；可选 `whenToUse`、`metadata`、`disable-model-invocation`、`user-invocable`。**未知字段被忽略**（`allowed-tools` 在 DSH 不产生权限语义）。
- 项目根 = 最近的含 `.git` 的祖先目录；本仓库根即工作区根。
- 目录被 watch，技能变更会自动刷新下一轮 catalog；技能正文每次 load 重新读取。
- **DSH 不实现 `` !`command` `` 动态注入**：`skill` 工具返回的是 `SKILL.md` 原文，注入行会作为字面命令出现（本会话已实测）。
- 另有 `dsh-agent-instructions`（base 默认启用，64KB 预算）：加载用户级 `$DSH_HOME/AGENTS.md` 与项目链（项目根 → 会话 cwd）的 `AGENTS.md`/`CLAUDE.md`，以及 `AGENTS.local.md`/`CLAUDE.local.md`。**这是 DSH 里放项目级适配说明的正确位置**。

### 2.2 MCP：一条 profile patch，工具名带命名空间

- 桥接插件：`@deepseek-ai/dsh-mcp-client`，每个实例连一个 server，配置项：

```yaml
- insert:
    - id: mcp-shadcn-vue
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: shadcn-vue
        transport: stdio
        command: npx
        args: ['-y', 'shadcn-vue@2.8.2', 'mcp']
        cwd: /Library/Development/Projects/AgentProjects/agent-team/web
        failOnStartupError: false
```

- **新增行必须放在 `- insert:` 里**。`~/.dsh/profiles/desktop/cordis.patch.yml` 是顶层 YAML 数组：只有 `insert` 会 push 新行；顶层直接写 `- id: ...` 只会按 id 覆盖已有行，找不到就打印 `patch: entry ... not found` 并跳过（已用临时 `DSH_HOME` + `dsh --dump-config` 实测两种写法）。
- 工具命名：`mcp__<serverName>__<rawName>`，即 `mcp__shadcn-vue__get_project_registries` 等 7 个。
- `cwd` 默认空串（≈ Electron 主进程 cwd），**必须显式写绝对路径**；`env` 不是完整继承（会丢弃 `*TOKEN*`/`DSH_*` 等），需要时显式配置。
- 生命周期：首轮对话前完成连接与工具发现；失败不阻断 harness 启动（`failOnStartupError: false`），默认指数退避重连（500ms→30s，10 次）；**编辑配置行会就地重载连接**。
- 本机已有活例子：`dsh-computer-use-win` 插件通过自带 `cordis.patch.yml` 挂了一个 MCP server，所以本会话能看到 `mcp__wincu__*` 工具——说明桥接链路是通的。
- desktop profile 由 Electron 独占，`dsh --profile desktop --dump-config` 会被拒绝；GUI 也没有 MCP 专用设置页，配置入口就是 profile 的 `cordis.patch.yml`。
- 修改 `cordis.patch.yml` 预计由 `dsh-hmr` 热重载（base 默认启用；Chokidar 有 2s 写入稳定窗口，建议等 5–10s；不生效则重启应用兜底）。

### 2.3 AI Elements 为什么不接进 DSH

- AI Elements 是 **Vue** 组件 pattern；DSH 的 Web 客户端插件是基于 **React** 的（client bundle 使用 `react`/`react-dom`/`createElement`），无法直接复用。
- 它也不提供运行时、协议或工具，没有「配置到 DSH」的接口。能做的就是让 DSH 在你的 Vue 项目里生成/维护这些 UI 代码（见 §3.3）。

---

## 3. 推荐配置方案

### 3.1 Skills：保持上游技能，用 AGENTS.md 补 DSH 适配（推荐）

**现状**：`.agents/skills/shadcn-vue/` 已被 DSH 自动发现（rank 200），无需任何操作。

**缺口**：
1. DSH 不执行 `SKILL.md:17` 的 `` !`npx ... info --json` ``，模型可能误以为上下文已注入；
2. 技能假定项目根含 `components.json`，但本仓库的 `components.json` 在 `web/`，在仓库根跑 `info --json` 会得到 `config: null`（实测）。

**方案 A（推荐，零侵入）**：在仓库根新增 `AGENTS.md`（DSH 每轮自动加载），写入项目级适配：

```markdown
## shadcn-vue 工作约定

- 前端项目根目录是 `web/`（`components.json` 所在）。运行任何 shadcn-vue CLI 时，workdir 设为 `web/`。
- 加载 `shadcn-vue` 技能后，先执行 `npx shadcn-vue@latest info --json` 获取项目上下文；DSH 不会执行 SKILL.md 里的 `!`...`` 动态注入。
- 若已启用 shadcn-vue MCP：工具名为 `mcp__shadcn-vue__*`，先 `search_items_in_registries`/`view_items_in_registries` 再 `add`；项目配置类信息仍用 `info --json`。
```

优点：不动 vendor 文件、可随项目提交、对所有 DSH 会话生效；缺点：每次会话多约 0.2KB 上下文。

**方案 B（硬覆盖，适合团队固化）**：把技能复制到项目级高优先级目录并改注入行：

```bash
mkdir -p .dsh/skills
cp -R .agents/skills/shadcn-vue .dsh/skills/shadcn-vue
# 编辑 .dsh/skills/shadcn-vue/SKILL.md 第 14-20 行：
#   把 !`npx shadcn-vue@latest info --json` 代码块替换为：
#   “先运行 `npx shadcn-vue@latest info --json`（workdir=web/）后再开始。”
```

`.dsh/skills`（rank 100）会覆盖 `.agents/skills`（rank 200）的同名技能。代价：重复 8 个文件、上游更新需重新同步；若直接改 `.agents/skills` 里的文件，`skills-lock.json` 的 hash 会失配（`skills add` 更新时可能提示/覆盖）。

**方案 C（全局可用，可选）**：给其他项目也能用时，把技能放进用户级目录（需写 workspace 之外，DSH 会请求授权）：

```bash
mkdir -p ~/.dsh/skills
cp -R .agents/skills/shadcn-vue ~/.dsh/skills/shadcn-vue
```
注意：项目内同名技能 rank 更高，会覆盖用户级版本。

### 3.2 MCP：追加一条 profile patch（固定版本）

**最终配置**：

```yaml
- insert:
    - id: mcp-shadcn-vue
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: shadcn-vue
        transport: stdio
        command: npx
        args: ['-y', 'shadcn-vue@2.8.2', 'mcp']
        cwd: /Library/Development/Projects/AgentProjects/agent-team/web
        failOnStartupError: false
```

关键决策：

- **固定版本**：`@latest` 每次启动要解析 npm dist-tag，实测单进程 ~26s、DSH 双进程协商 ~42s，已接近 SDK 60s 初始化超时；固定 `2.8.2` 后 ~2.7s。先验证链路时可用 `@latest`，跑通后改固定版本。
- **`cwd` 静态**：shadcn-vue MCP 只用 `process.cwd()` 找 `components.json`，不向上查找；切项目必须改这一行（HMR 会重载）。
- **PATH 兜底**：若 desktop 由 Finder/Spotlight 启动、PATH 不含 node/npx，会 `spawn npx ENOENT` 或 `env: node: No such file or directory`；改用绝对 node + `npx-cli.js` 并显式 `env.PATH`（备选 B 见 patch 文件）。

**应用步骤**：

```bash
cd /Library/Development/Projects/AgentProjects/agent-team

# 1) 备份
cp ~/.dsh/profiles/desktop/cordis.patch.yml \
   ~/.dsh/profiles/desktop/cordis.patch.yml.bak-$(date +%Y%m%d%H%M%S)

# 2) 追加 insert 条目（注意是 - insert:，不能写成顶层 - id:）
cat >> ~/.dsh/profiles/desktop/cordis.patch.yml <<'YAML'

- insert:
    - id: mcp-shadcn-vue
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: shadcn-vue
        transport: stdio
        command: npx
        args: ['-y', 'shadcn-vue@2.8.2', 'mcp']
        cwd: /Library/Development/Projects/AgentProjects/agent-team/web
        failOnStartupError: false
YAML
```

3. 等 **5–10 秒**（HMR 写稳定窗口 + 重载 + MCP 启动），或重启 DSH 应用兜底。
4. **验证**：新开会话，让模型调用 `mcp__shadcn-vue__get_project_registries`，应返回 `- @shadcn`；再试 `mcp__shadcn-vue__search_items_in_registries`（registries=`["@shadcn"]`，query=`button`）确认联网检索正常。
5. **回滚**：删除追加的 `- insert:` 块，或恢复 `.bak-*`；desktop 启动失败时也会自动把坏配置重命名为 `.bak-<ts>`。

**按项目使用**：DSH 没有项目级 `.mcp.json`，MCP 配置只有 profile 级。多项目时可：改 `cwd`（HMR 重载，最轻）；或为每个项目建独立非 desktop profile（可 `--dump-config` 校验，但 desktop GUI 要切换 profile）；或只在需要时临时改。

### 3.3 AI Elements：不配置 DSH，按前端任务落地

在 `web/` 里：

```bash
# 1) 装每个 pattern 需要的底座组件（示例）
cd web
npx shadcn-vue@latest add trace code-block

# 2) 让 DSH 落 pattern 代码（它会先查文档再适配现有组件）
#    “把 https://www.shadcn-vue.com/docs/ai-elements/reasoning 的 Reasoning pattern 加到我的聊天页”
```

若已启用 MCP，DSH 可以用 `search_items_in_registries`/`view_items_in_registries` 找底座组件；但 **21 个 pattern 本身不在注册表里**（`/r/index.json` 只有基础组件），必须复制页面代码或让模型读文档后生成。

---

## 4. 落地清单（按顺序）

| # | 动作 | 是否必需 | 产物/命令 |
|---|---|---|---|
| 1 | 确认技能可用：新会话看 skill catalog 是否有 `shadcn-vue` | 已满足 | 本仓库 `.agents/skills/shadcn-vue/` |
| 2 | 加 `AGENTS.md`（web/ 约定 + info --json 提示） | 推荐 | 见 §3.1 方案 A |
| 3 | 追加 MCP profile patch 并验证 | 可选（需要结构化工具时） | 见 §3.2 |
| 4 | 需要 AI 聊天界面时装 AI Elements 底座 + 落 pattern | 按需 | 见 §3.3 |

**不建议**：把 AI Elements 当 DSH 插件配置、或把 `shadcn-vue mcp init` 直接跑在仓库里（它会改项目依赖并写 5 种客户端的配置文件，而 DSH 不在支持列表）。

---

## 5. 风险与限制

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| 1 | MCP `cwd` 静态、不向上查找 | 换项目不改 cwd 会静默退化为只有内置 `@shadcn`，不报错 | 按项目改 `cwd`；确认 `components.json` 在 cwd |
| 2 | `@latest` 启动 ~42s vs 60s 初始化超时 | 冷启动/慢网可能首次激活失败并进入重连 | 固定版本 `2.8.2`；预下载 npx 缓存 |
| 3 | Finder 启动的 Electron PATH 不含 node/npx | 工具不出现（spawn ENOENT） | 显式 `env.PATH` 或绝对 node + npx-cli.js |
| 4 | MCP 子进程在宿主侧、不受会话沙箱约束；`npx @latest` 执行 npm 最新代码 | 供应链/越权读写风险；普通 MCP 工具调用不会自动弹审批 | 固定版本、只接可信 server |
| 5 | 7 个工具 schema 常驻每个请求 | token 成本增加；工具集变化会短暂影响 KV 前缀 | 只在需要的 profile 开启 |
| 6 | server 声明 resources 但无 handler | 调 `list_mcp_resources` 会报错 | 只用 7 个 tools |
| 7 | desktop profile 被 Electron 独占 | CLI 不能 dump 组合结果，HMR 是否启用只能按文档推断 | 改完等 5–10s；不生效重启验证 |
| 8 | DSH 不执行 `!`cmd``、不认 `allowed-tools` | 技能项目上下文缺失；无免询问授权 | AGENTS.md / 手动 `info --json`；权限交给 DSH |
| 9 | 直接改 vendor 的 `SKILL.md` | `skills-lock.json` hash 失配，更新时可能被覆盖 | 用 `.dsh/skills` 覆盖层或只加 AGENTS.md |
| 10 | AI Elements pattern 非 registry item | MCP/`add` 找不到 pattern | 先 add 底座组件，再复制 pattern 代码 |
| 11 | 项目通过 `skills add` 重装技能 | 覆盖本地适配 | 适配放在 AGENTS.md 或 `.dsh/skills`，不要改 `.agents` 里的上游文件 |

---

## 6. 参考与产物

### 6.1 本地调研材料（不入库）

文档盘点、DSH 侧实测报告、探测脚本与补丁样例属于调研过程材料，已加入 `.gitignore`，不随仓库提交；仓库内只保留本文档。需要复核时可按 §6.4 的步骤重新验证。

### 6.2 外部链接

- shadcn-vue Skills：<https://www.shadcn-vue.com/docs/skills>
- shadcn-vue MCP Server：<https://www.shadcn-vue.com/docs/mcp>
- shadcn-vue AI Elements：<https://www.shadcn-vue.com/docs/ai-elements>
- shadcn-vue Components：<https://www.shadcn-vue.com/docs/components>
- MCP 实现源码：<https://github.com/unovue/shadcn-vue/tree/dev/packages/cli/src/mcp>
- 技能包源码：<https://github.com/unovue/shadcn-vue/tree/dev/skills/shadcn-vue>
- skills CLI：<https://github.com/vercel-labs/skills> ／ <https://skills.sh>

### 6.3 本机应用记录（2026-10-22 已执行）

| 项 | 内容 |
|---|---|
| Skills | 仓库根新增 `AGENTS.md`；DSH 已在下一轮自动加载为工作区指令（无需重启） |
| MCP | `~/.dsh/profiles/desktop/cordis.patch.yml` 末尾追加 `- insert:` 条目；备份为 `cordis.patch.yml.bak-20261022130722` |
| 热加载 | 保存后约 10s，`mcp__shadcn-vue__*` 7 个工具出现在工具列表，**无需重启 DSH** |
| 验证 | `get_project_registries` → `@shadcn`；`search_items_in_registries(@shadcn, "button")` → button / button-group（cwd 与联网均正常） |
| 已知问题 | 搜索结果的 “Add command” 显示 `[object Promise]`（shadcn-vue MCP 2.8.2 自身 bug）；安装仍用 `npx shadcn-vue@latest add` |
| 回滚 | 删除 patch 中的 `- insert:` 块，或 `cp ~/.dsh/profiles/desktop/cordis.patch.yml.bak-20261022130722 ~/.dsh/profiles/desktop/cordis.patch.yml`，等待 HMR |

### 6.4 附录：实测摘要

- MCP 协商：`protocolEra=legacy`、`protocolVersion=2025-11-25`、`serverInfo={"name":"shadcnVue","version":"1.0.0"}`。
- 工具调用：cwd=`web/` 时 `get_project_registries` 返回 `- @shadcn`；cwd 指向无 `components.json` 的目录时只返回内置 `@shadcn`（不报错）。
- 启动耗时（npm cache 已热）：`@latest` 单进程 ~26s、DSH 双进程 ~42s；`shadcn-vue@2.8.2` 双进程 ~2.7s。
- 补丁语义：`- insert:` → `dsh --dump-config` exit 0 且包含该行；顶层 `- id:` → `patch: entry "mcp-shadcn-vue" not found`，exit 1。
