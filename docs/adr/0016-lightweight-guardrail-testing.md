# Lightweight guardrail testing and CI-first regression

Status: accepted

Supersedes [ADR 0005](0005-layering-ratchet.md). ADR 0005 为后端 `src/tests/contract/` 层引入了 `store.get/all/run` 断言的 ratchet 基线监管（`scripts/layering-baseline.json`）。随着后端测试收敛为 `core/` + `smoke/` 两层，该基线与四层目录一并退役；前后端纯 Web 隔离边界（原规则 B）保留在 `scripts/check-layering.mjs` 中继续严格阻断。

## Context

本仓库为单人维护 + AI Agent 主力开发的本地多 Agent 协作框架。人类维护者既不手写也不阅读测试文件，测试体系的唯一价值是作为**约束 Agent 的自动化护栏**（防破坏核心不变式与外部契约、防历史缺陷复发）。

此前仓库累积了 180 个测试文件 / 32,508 行测试代码（占生产代码 47.4%，后端高达 84%）、后端 4 层目录（`unit` / `contract` / `internal` / `process`）与 ratchet 基线、29 个依赖 Vue `mount()` / SSR HTML 字符串 / CSS 类名断言的脆弱前端测试、44 个仅 1–2 用例的碎片文件，以及每次本地改动都全量运行 8 项静态检查 + 180 个测试文件的沉重门禁。结果是：
- 改几行代码甚至只改文档也会触发大量无关测试，拖慢迭代节奏；
- 脆弱的 UI DOM/SSR 测试在样式与布局演进时频繁误报，反而增加 Agent 维护负担；
- 覆盖率报告、历史性能探针与写死本机路径的特定宿主脚本无人消费却持续制造漂移成本。

## Decision

1. **高杠杆护栏定位，剥离脆弱 UI/DOM 测试。**
   - 后端测试聚焦核心领域不变式、SQLite 逐级迁移、投递恢复与并发状态机、公开契约（HTTP / MCP / RPC / 权限与能力路由），以及少量核心进程冒烟。
   - 前端测试聚焦纯 TypeScript 业务逻辑、状态机、流式归约、主题解析与插件契约；**不再编写和维护 Vue DOM 挂载（`mount()`）、SSR HTML 渲染、CSS 类名与布局结构测试**，UI 视觉与交互交由 `vue-tsc` + `check-design.mjs` + 实机浏览器验证兜底。
2. **后端测试从 4 层压为 2 层。**
   - `src/tests/core/`：快速核心与契约测试（内存 / 临时 SQLite），支持按单文件定向运行；
   - `src/tests/smoke/`：少量必须拉起真实子进程或端口的关键端到端冒烟（服务与 Launcher、MCP 入口、宿主子进程生命周期、唤醒链路）；
   - `src/tests/support/`：共用测试夹具。
3. **本地极简定向验证，全量回归交由 CI 集中兜底。**
   - 本地开发与提交前只跑**改动所在端的静态检查**（`check:docs` / `check:web` / `check:backend`，`.githooks/pre-commit` 按暂存区分域触发）+ **与本次改动直接相关的定向测试文件**（纯文档跑 0 个测试）。
   - 远端 CI（`.github/workflows/compatibility.yml`）在每次 `push` / PR 时于 Ubuntu / macOS / Windows 三平台集中跑全量 `check + build + test` 与 macOS `desktop-smoke`，移除无人阅读的覆盖率采集步骤。
4. **控增与清理外围冗余。**
   - 新增回归用例优先并入所属领域既有测试文件，不建单用例碎片文件；
   - 保留 `scripts/check-design-hook.mjs`（~0.2s 写时拦截）、`scripts/verify-collaboration.mjs`（主链路真宿主手工验收）与 `scripts/electron-smoke.mjs`（桌面壳冒烟）；移除 `scripts/coverage-core.mjs`、`scripts/layering-baseline.json`、特定宿主脚本（`verify-headless-control.mjs` / `verify-dsh-host.mjs` / `verify-zcode-host.mjs`）及早期性能探针（`perf-baseline.mjs` / `perf-browser.mjs`）。

## Considered options

- **保留全量存量测试，仅靠本地脚本按 `git diff` 自动路由跑半套测试**：拒绝。随代码演进维护 180+（甚至更多）含脆弱 UI 挂载测试的文件与一套复杂路由脚本，本身就会持续放大维护负担。
- **保留 Vue 组件 `mount()` / SSR 冒烟测试**：拒绝。这类测试高度耦合模板结构与 mock 壳，对真实视觉/交互缺陷拦截率低，却在正常 UI 调整时频繁制造噪音；静态类型 + 设计令牌检查 + 实机浏览器验证信噪比更高。
- **本地提交前仍全量运行 `npm test`**：拒绝。本地频繁等待历史回归（尤其慢速进程测试）显著拖慢小步迭代；三平台全量回归由 CI 集中兜底更合理。

## Consequences

- 测试文件规模由 180 个（32,508 行）大幅收敛至约 34 个高杠杆领域文件（后端 `core/` 14 + `smoke/` 4，前端纯逻辑 ~16），降低 Agent 修改代码时的测试噪音与维护成本。
- 后续 Agent 不应把“缺少 Vue 组件 `mount()` 测试”或“本地未跑全量 `npm test`”误判为遗漏；UI 交互与视觉以 `check-design.mjs` 与对应级别的实机验证为准，跨模块历史回归以 CI 结果为准。
- [ADR 0005](0005-layering-ratchet.md) 正式标记为由本 ADR 取代；`docs/dev-flow-spec.md` 与 `AGENTS.md` 同步更新为唯一执行口径。
