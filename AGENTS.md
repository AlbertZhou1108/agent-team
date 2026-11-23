# AGENTS.md

面向在本仓库工作的 Agent 的全局入口指引。本仓库为本机单用户多 Agent 协作框架：Node ESM 后端 + `node:sqlite` 存储 + Vue 3/TS/Vite 面板 + Electron 桌面壳。目录职责、源码入口与完整脚本分别以仓库目录、`guide/architecture.md`、`package.json` 为准。

## 开发工作流（唯一事实源：`docs/dev-flow-spec.md`）

- **判档与降档权**：产生新用户可见行为或新设计/架构决策走**完整档**（默认）；调参/纯缺陷修复/局部重构可由 Agent **建议降为轻量档**，**降档权只在用户**。轻量档中途牵动设计或行为边界时，立即停下上报升档。
- **人机拍板点**：`spec.md` 定稿、`contract.md` 定稿（涉新 UI 决策时；仅复用既有组件可确认跳过）、`git commit`、`git push` 与 GitHub Release 创建须经**用户确认**。
- **设想出入即停**：实现期发现现状、接口或效果与 `spec.md` / `contract.md` 不符，**立即停下上报分歧点**，先修订上游产物再继续。
- **产物落点**：完整档落 `docs/flows/<YYYY-MM-DD>-<topic>/`（`spec.md` / `contract.md` / `tasks.md` / `verify.md`，在 `docs/` 下不入库）；轻量档不建文档文件，直接在回复汇报。→ 六阶段细则、上下文包与最小骨架见 `docs/dev-flow-spec.md`。

## 全局硬红线（跨分支不变式）

- **术语与权限**：以 `GLOSSARY.md` 为基线；严禁引入已退役概念（`Goal`、`Contract`、`Work Item`、`Preparation`、`Closing`、`closing/closed`、`team_finish`、`next_goal_request`）。`ask` 互动卡与 charter 只作上下文征询，权限由群策略与宿主沙箱决定。
- **数据与运行边界**：保留 `work/` 用户运行数据不清理、不篡改。`messages`、`turns`、`conversations` 只经 `src/aggregates/` 写入，事务统一走 `store.transaction()`；保持单一归属（`member_id` / `panel_agent_id` 二选一，`(executor_kind, executor_id)`）与单字段单一语义（待投递 / 等待回复 / 已读不复用）。改表必配 `SCHEMA_VERSION` + 逐级迁移 + `src/tests/internal/` 迁移用例。
- **端与样式边界**：`web/src` 保持纯 Web（原生能力只经 `globalThis.agentTeam?.xxx?.()` 可选注入并保留 HTTP 回退）；`web/src/styles/globals.css` 材质规则刻意非 `@layer` 化，禁止重构进 `@layer`。
- **文档与本机文件**：`docs/` 默认 gitignore，持久资产（`docs/adr/**`、`docs/DESIGN.md`、`docs/dev-flow-spec.md`）通过 `.gitignore` 白名单入库；`.agents/`、`.zcode/`、`.claude/`、`.idea/` 与过程脚本为本机文件，不入库。

## 工具、门禁与测试

- **优先 WebStorm MCP**（`http://127.0.0.1:64542/stream`）：启动前后端用 `execute_run_configuration`（`dev` / `run` / `desktop:dev`），执行终端命令用 `execute_terminal_command`，查配置/模块/符号用 `get_run_configurations` / `get_project_modules` / `search_symbol`；MCP 不可用时回退 `npm` 脚本并在回复注明。
- **提交前门禁**：`npm run check` 与 `npm test` 须全绿；Conventional Commits，实现与对应测试同提交。自动化测试须三平台中性并用 fake stub 替代宿主 CLI；真宿主手工验收走 `scripts/verify-collaboration.mjs`。
- **写后自查**：改完 `web/src` 立即跑 `node scripts/check-design.mjs`（约 0.2s），改完 `src/` 或 `web/` 跑 `node scripts/check-layering.mjs`（约 0.1s）当场修复违例；写时 hook 注册表在 `scripts/agent-checks.mjs`。
- **测试分层与留存**：
  - `src/tests/`：`unit/`（纯内存，无进程/端口/临时目录）、`contract/`（只断言公共入口行为，受 `check-layering` ratchet 约束，迁移后运行 `node scripts/check-layering.mjs --update-baseline`）、`internal/`（断言表结构/迁移/内部表示）、`process/`（真实进程/服务，给足 ~30s 握手预算）；共用辅助放 `support/`。
  - `web/tests/`：按 `web/src/` 结构分目录（共用辅助放 `web/tests/support/`），统一经 `@/` 别名引用源码。
  - 留存铁律：开发期临时验证脚本放 `docs/flows/.../scratch/`（不入 `scripts/`）；新用例优先并入所属模块既有测试文件，不建单用例碎片（详情见 `docs/dev-flow-spec.md`）。

## 实测优先与完成标准

自动化门禁通过 ≠ 功能可用。凡改动触及用户可见页面、HTTP/MCP/RPC 端点、宿主生命周期或桌面壳，**汇报前必须实机验证**（内置浏览器页面操作与截图 / 真实服务进程请求 / 真实目录 shell / 手动 `scripts/verify-*.mjs`）。最终回复必须分开陈述：

1. **自动化门禁结果**（改动后实跑的命令与结果）；
2. **实机验证方式与观测事实**（截图、请求响应、进程输出）；
3. **未实测项与原因**（无法实测时明确说明，不笼统声称“已验证”）。

## 按需读取路由表（Context Pointers）

| 当你处理或改动…… | 先读取 / 遵循 |
| --- | --- |
| `web/src/` 页面、组件、样式、主题、动效 | `docs/DESIGN.md` + `skills/design-system/SKILL.md`；执行 `shadcn-vue` CLI 时工作目录设为 `web/`（先跑 `npx shadcn-vue@latest info --json`） |
| 投递恢复、读水位、遥测与聚合细节 | `src/tests/unit/delivery-recovery.test.mjs`、`src/aggregates/read-state.mjs`、`docs/adr/0001`–`0006` |
| 宿主适配、无头控制、外部桌面宿主集成 | `guide/host-adapters.md`、`guide/headless-control-plane.md`、`docs/adr/0007`–`0013` |
| `electron/` 桌面壳、服务托管、托盘与构建 | `guide/development.md` 桌面壳段落（独立 `launcher.mjs` 进程、`loadURL(instance.url)`、`src/runtime.mjs` `nodeRunner()` 带 `ELECTRON_RUN_AS_NODE=1`、不做签名/自动更新/发布渠道） |
| 工具面、权限、消息路由、Skill 或发布 | `skills/agent-team/`（同步维护，入口规范见 `guide/development.md`）与 `guide/development.md` |
| 系统全貌、模块入口与完整命令 | `guide/architecture.md`、`guide/development.md`、`package.json` |
