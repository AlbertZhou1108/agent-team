# AGENTS.md

面向在本仓库工作的 Agent 的全局入口指引。本仓库为本机单用户多 Agent 协作框架：Node ESM 后端 + `node:sqlite` 存储 + Vue 3/TS/Vite 面板 + Electron 桌面壳。目录职责、源码入口与完整脚本分别以仓库目录、`guide/architecture.md`、`package.json` 为准。

## 开发工作流（唯一事实源：`docs/dev-flow-spec.md`）

- **单一自适配流程（无档位、无降档请示）**：按客观条件决定是否落档拍板：
  - **必须先写 `docs/flows/<YYYY-MM-DD>-<topic>/spec.md` 经用户拍板再开工**：① 新增/改变用户可见功能、交互或外部接口契约；② 涉及架构、数据模型、新设计 token 或组件原语取舍；③ 需求存在歧义或跨多模块协同。
  - **直接动手（不强建 `docs/flows/`）**：纯文档、根因唯一的缺陷修复、改法已明确的局部样式/文案/参数微调。
- **原型与契约默认跳过**：仅涉及新的 UI 视觉/布局/交互决策（或用户要求画原型）时才进入原型阶段并产出 `contract.md` 拍板；纯后端/文档/复用既有组件与 token 时直接跳过，无需请示。
- **设想出入即停**：实现期发现现状、接口或效果与既定设想/`spec.md`/`contract.md` 不符，**立即停下上报分歧点**，先对齐再继续。
- **人机拍板点**：`spec.md` 定稿（触发时）、`contract.md` 定稿（触发时）、`git commit`、`git push` 与 GitHub Release 创建须经**用户确认**。

## 全局硬红线（跨分支不变式）

- **术语与权限**：以 `GLOSSARY.md` 为基线；严禁引入已退役概念（`Goal`、`Contract`、`Work Item`、`Preparation`、`Closing`、`closing/closed`、`team_finish`、`next_goal_request`）。`ask` 互动卡与 charter 只作上下文征询，权限由群策略与宿主沙箱决定。
- **数据与运行边界**：保留 `work/` 用户运行数据不清理、不篡改。`messages`、`turns`、`conversations` 只经 `src/aggregates/` 写入，事务统一走 `store.transaction()`；保持单一归属（`member_id` / `panel_agent_id` 二选一，`(executor_kind, executor_id)`）与单字段单一语义（待投递 / 等待回复 / 已读不复用）。改表必配 `SCHEMA_VERSION` + 逐级迁移 + `src/tests/core/store-migrations.test.mjs` 迁移用例。
- **端与样式边界**：`web/src` 保持纯 Web（原生能力只经 `globalThis.agentTeam?.xxx?.()` 可选注入并保留 HTTP 回退）；`web/src/styles/globals.css` 材质规则刻意非 `@layer` 化，禁止重构进 `@layer`。
- **文档与本机文件**：`docs/` 默认 gitignore，持久资产（`docs/adr/**`、`docs/DESIGN.md`、`docs/dev-flow-spec.md`）通过 `.gitignore` 白名单入库；`.agents/`、`.zcode/`、`.claude/`、`.idea/` 与过程脚本为本机文件，不入库。

## 工具、门禁与测试（详见 `docs/adr/0016-lightweight-guardrail-testing.md`）

- **优先 WebStorm MCP**（`http://127.0.0.1:64542/stream`）：启动前后端用 `execute_run_configuration`（`dev` / `run` / `desktop:dev`），执行终端命令用 `execute_terminal_command`，查配置/模块/符号用 `get_run_configurations` / `get_project_modules` / `search_symbol`；MCP 不可用时回退 `npm` 脚本并在回复注明。
- **本地极简门禁 + CI 集中全量兜底**：
  - **写时自查（~0.2s）**：改完 `web/` 跑 `node scripts/check-design.mjs` 与 `node scripts/check-layering.mjs` 当场修复（写时 hook 注册表在 `scripts/agent-checks.mjs`）。
  - **本地提交前静态检查（按改动端）**：纯文档跑 `npm run check:docs`；改前端跑 `npm run check:web`；改后端/脚本/桌面壳跑 `npm run check:backend`；跨端或改公共配置跑 `npm run check`。
  - **本地测试（只跑本次直接相关文件）**：纯文档跑 **0** 个测试；代码改动只跑与本次新功能/修复直接对应的测试文件（`node --disable-warning=ExperimentalWarning --test src/tests/core/<file>.test.mjs` 或 `npx vitest run --config web/vite.config.ts web/tests/<file>.test.ts`）。全量回归 `npm test` 与三平台兼容交由 push 后的 CI 集中兜底（仅发版前或用户要求时本地全量跑）。
  - **提交规范**：Conventional Commits；真宿主手工验收走 `scripts/verify-collaboration.mjs`。
- **高杠杆测试架构与留存**：
  - `src/tests/` 分两层：`core/`（快速核心领域不变式、迁移、投递/策略/HTTP/MCP 公共契约）与 `smoke/`（少量关键子进程/端口冒烟，日常交 CI）；共用夹具放 `support/`。
  - `web/tests/` 只放纯 TypeScript 业务逻辑/状态机/流式/主题单测（经 `@/` 引用）；**不编写脆弱的 Vue `mount()` / SSR 渲染 / CSS 类名测试**（UI 交由 `vue-tsc` + `check-design` + 实机浏览器兜底）。
  - 留存铁律：开发期临时脚本放 `docs/flows/.../scratch/`（不入 `scripts/`）；新回归用例优先并入所属模块既有测试文件，不建单用例碎片文件。

## 分级实机验证与汇报标准

自动化门禁通过 ≠ 功能可用，但验证与汇报尺度应匹配改动风险：

- **L0 非运行态改动**（纯文档、注释、纯测试）：免实机、免三段式模板，简述实际跑过的静态检查/定向测试即可。
- **L1 局部小改**（单点样式/文案、局部缺陷修复、单一接口微调）：对改动点做最小定向实机确认（对应界面截图或单次接口请求），简述检查结果与观测事实。
- **L2 功能级 / 高风险改动**（新功能、复杂交互/响应式/动效、宿主生命周期、桌面壳）：完成端到端实机走查，并分开陈述：**1. 自动化门禁结果**；**2. 实机验证方式与观测事实**；**3. 未实测项与原因**（不笼统声称“已验证”）。

## 按需读取路由表（Context Pointers）

| 当你处理或改动…… | 先读取 / 遵循 |
| --- | --- |
| `web/src/` 页面、组件、样式、主题、动效 | `docs/DESIGN.md` + `skills/design-system/SKILL.md`；执行 `shadcn-vue` CLI 时工作目录设为 `web/`（先跑 `npx shadcn-vue@latest info --json`） |
| 投递恢复、读水位、遥测与聚合细节 | `src/tests/core/delivery-and-read-state.test.mjs`、`src/aggregates/read-state.mjs`、`docs/adr/0001`–`0006` |
| 宿主适配、无头控制、外部桌面宿主集成 | `guide/host-adapters.md`、`guide/headless-control-plane.md`、`docs/adr/0007`–`0013` |
| `electron/` 桌面壳、服务托管、托盘与构建 | `guide/development.md` 桌面壳段落（独立 `launcher.mjs` 进程、`loadURL(instance.url)`、`src/runtime.mjs` `nodeRunner()` 带 `ELECTRON_RUN_AS_NODE=1`、不做签名/自动更新/发布渠道） |
| 工具面、权限、消息路由、Skill 或发布 | `skills/agent-team/`（同步维护，入口规范见 `guide/development.md`）与 `guide/development.md` |
| 系统全貌、模块入口与完整命令 | `guide/architecture.md`、`guide/development.md`、`package.json` |
