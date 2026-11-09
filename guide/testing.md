# 测试体系与 Agent 测试流程

[返回产品介绍](../README.md) · [开发、测试与发行构建](development.md) · [前端设计](../DESIGN.md)

本文是本项目**测试的唯一权威规范**，面向两类读者：

- **项目负责人**：不需要读懂源码，也能知道「有哪些测试、跑什么命令、CI 会拦什么、红灯怎么办」。看第 1、2、6、7 节即可。
- **在本仓库写代码的 Agent**：必须遵守第 3、4、5 节的编号规则。本文入库，任何机器、任何 Agent 工具、CI 都能读到；本机 `AGENTS.md` 只是本规范的索引与本机补充，**规范冲突时以本文为准**。

> 定稿日期：2026-11-09。文中「现状」数据为当日实测，不是引用历史文档。

---

## 1. 现状盘点（2026-11-09 实测）

### 1.1 测试文件分布

全仓库自动化套件共 **141 个测试文件 / 776 个用例**，只有两个合法根目录：

| 位置 | Runner | 文件数 | 用例数 | 行数 | 用途 |
| --- | --- | ---: | ---: | ---: | --- |
| `test/contract/` | `node:test` | 43 | 279 | 9732 | 对外契约：Bus 方法、HTTP、RPC、MCP 的可观察行为 |
| `test/internal/` | `node:test` | 20 | 79 | 2128 | 内部实现：表结构、迁移、聚合不变式、平台分支 |
| `test/process/` | `node:test` | 13 | 32 | 957 | 真实子进程 / 本地服务 / 启动与协议握手 |
| `test/support/` | — | 3（辅助） | — | 320 | `fixture.mjs` / `wait.mjs` / `legacy-v1.mjs`，**不是测试** |
| `web/tests/` | Vitest 5 | 65 | 382 | 7294 | 前端：SSR 冒烟、组件交互、composable、纯函数 |
| `web/tests/support/ssr.ts` | — | 1（辅助） | — | 58 | SSR 渲染与 `vi.stubGlobal` 共用辅助，**不是测试** |

`web/src/`、`src/`、`scripts/`、`electron/`、`guide/` 下**没有** `*.test.*` / `*.spec.*`。

### 1.2 运行机制（现状，已生效）

| 命令 | 实际内容 |
| --- | --- |
| `npm run check` | 7 段串联：`check.mjs`（语法 + 相对导入 + 文档死链）→ `check-design.mjs`（设计治理）→ `check-layering.mjs`（规则 A ratchet / 规则 B 纯 Web 红线）→ `check-version-consistency.mjs` → `vue-tsc` → `tsc -p tsconfig.backend.json` → `eslint src test scripts electron` |
| `npm test` | `node --test test/{contract,internal,process}/*.test.mjs && vitest run --config web/vite.config.ts`，用 `&&` 串联，后端失败则前端不跑 |
| `npm run test:core` / `test:web` | 分开跑后端 / 前端 |
| `npm run coverage` | 后端 Node 内建 `--experimental-test-coverage` + 前端 Vitest v8，**无阈值、不阻断** |
| `npm run build` | Vite 构建到 `web/dist` |

- 后端：`node:test` + `node:assert/strict`，**无自研 runner、无 setup 文件**；`test/support/` 因不是 `.test.mjs` 不被执行。
- 前端：Vitest 配置内嵌在 `web/vite.config.ts` 的 `test` 段，`environment: 'node'`、`include: ['tests/**/*.test.ts']`、**没有 setupFiles**；仅 3 个文件用 `// @vitest-environment happy-dom` 单独开 DOM。产品代码一律经 `@/` 别名引用。
- 隔离：几乎所有后端用例在 `os.tmpdir()` 建独立 SQLite 数据目录，`t.after` 清理；宿主一律用 `fakeHost` / 临时目录里的假 CLI，**不调用真实 codex / claude / dsh，不消耗模型额度，不依赖外网**。

### 1.3 当日实测基线

```
npm run check    → EXIT 0（规则 A 33 处存量告警在基线内；规则 B 扫描 428 文件 0 违规）
npm run test:core→ EXIT 0，394 用例：393 pass / 1 skip（win32 平台守卫）/ 0 fail，约 41s
npm run test:web → EXIT 0，65 文件 / 382 用例全过，约 97s
```

前端耗时的 86% 花在 65 个 worker 的启动（isolate），不是用例本身；这是后续提速的首要目标。

### 1.4 CI/CD 现状

| Workflow | 触发 | 做了什么 |
| --- | --- | --- |
| [compatibility.yml](../.github/workflows/compatibility.yml) | 任意 `push` / `pull_request` | `test` job：3 OS 矩阵（ubuntu / macos / windows）跑 `npm ci → check → build → build-release --dry-run → npm test`，ubuntu 额外跑 `npm run coverage`；`desktop-smoke` job：macOS 跑 Electron 启动冒烟 |
| [release.yml](../.github/workflows/release.yml) | `v*` tag push / `workflow_dispatch` | 3 OS 跑 `check → build → tag 与 package.json 版本校验 → npm test → package`，归档 + SHA-256 + 上传 Actions artifact（保留 30 天）；**不自动创建 GitHub Release**，由人工下载并发布 |

**已有的硬门禁**（机器可判定的部分）：语法 / 悬空导入 / 文档死链、设计治理、`check-layering` 规则 B 与「规则 A 新增违规」、版本一致性、双端 typecheck、ESLint、`npm run build`、打包 dry-run、`npm test`、tag 与版本号一致。

**明确不阻断的**：覆盖率（无阈值）、规则 A 的 33 处存量（ratchet 只拦新增）、README 版本漂移（只提示）、`desktop-smoke`（CI 设了 `ELECTRON_SMOKE_OPTIONAL=1`，Electron 二进制下载不到时直接 SKIP 变绿）、真实宿主验收、浏览器 UI 验收、安装包实际安装验收、对外发布本身。

### 1.5 「看起来像测试」但不进套件的散落脚本

这是「测试分散」的真正来源，必须先分清身份：

| 位置 | 规模 | 身份 | 是否入库 |
| --- | --- | --- | --- |
| `scripts/` 顶层 | 16 个 `.mjs` | **工程门禁**（`check-*.mjs`、`coverage-core.mjs`、`build-release.mjs`）与 **手动真宿主验收**（`verify-*.mjs`、`smoke.mjs`、`probes/`、`perf-*.mjs`） | 是 |
| `docs/` | 40 个 `.mjs` + 9 个 `.log` + 63 个 fixture 文件 | **一次性开发过程草稿 / 实机验收脚本**，头部多注明「一次性、仅手动、不进 CI」 | 否（`docs/*` 已 gitignore，`adr/` 例外） |
| `work/` | 86 个 `.mjs`（另有 12 个第三方 vendored `*.test.*`） | **运行数据与验证产物**，含 e2e / seed / probe / CDP 脚本 | 否（`work/` 已 gitignore） |

其中 `work/` 里那 12 个 `*.test.*` 是采集的真实宿主家目录快照中第三方插件自带的测试，**不属于本项目**，任何统计与门禁都必须排除。

### 1.6 三个结构性缺口（本规范要解决的）

1. **规范不入库**：`AGENTS.md` 被 `/AGENTS.md` gitignore，`docs/` 的过程文档、交接报告、以及本机工作记录里的「六层闸门讨论稿」也都不入库。新克隆、CI、换一个 Agent 工具时，所有「必须遵守」的规则都看不见——等于只有这台机器上的口头约定。
2. **没有单一入口**：负责人和 Agent 都要记住一串命令；`git commit` 不触发任何检查（`.git/hooks` 全是 `.sample`，无 husky / lint-staged），所以「提交前门禁」靠自觉。
3. **身份与位置没有强制**：Agent 每次验收随手在 `docs/` 或 `work/` 新建一个 `*.mjs`，越积越多；`*.test.*` 只能放在哪、命名怎么取、什么算「测试」什么算「手动脚本」，目前只是文字约定，没有脚本阻断。

### 1.7 当前工作区状态（重要，非故障）

工作区有一批**尚未提交**的「清理冗余测试 + 前端测试统一目录」改动：

- `web/src/**/*.test.ts`（70 个）已删除，65 个迁入 `web/tests/`（扁平命名，import 全改 `@/` 别名），`web/src/test/ssr.ts` 迁到 `web/tests/support/ssr.ts`；`web/vite.config.ts`、`web/tsconfig.json`、`scripts/check-layering.mjs` 规则 B、`guide/development.md`、本机 `AGENTS.md` 已同步。
- **有意删除 5 个冗余测试，不是漏迁**：`routes.test.ts`、`Button.test.ts`、`message-context.test.ts` 及其源文件 `message-context.ts`（死代码）、`test/internal/message-awaiting.test.mjs`（并入 `aggregates.test.mjs`）；`telemetry.test.mjs` 的 4 个重复用例合并进 `manager-conversation.test.mjs`，独有断言已迁移。
- **风险**：`web/tests/` 的 66 个文件目前**全是 untracked**，删除也只在工作区。若此时换机器 clone、或 `git stash` / `git checkout`，前端测试会全部丢失，而 `vite.config.ts` 已只认 `tests/**`，新克隆上 `npm run test:web` 会变成 0 个用例。
- 本次实测是在这套未提交状态下跑的，结果全绿，说明迁移本身是好的；缺的只是**把它提交进仓库**。

---

## 2. 统一目录：只允许两个根、三种身份

### 2.1 唯一合法位置

| 身份 | 唯一位置 | 命名 | 由谁执行 |
| --- | --- | --- | --- |
| 后端契约测试 | `test/contract/` | `<主题>.test.mjs` | `npm run test:core` |
| 后端内部测试 | `test/internal/` | `<主题>.test.mjs` | `npm run test:core` |
| 后端进程测试 | `test/process/` | `<主题>.test.mjs` | `npm run test:core` |
| 后端共用辅助 | `test/support/` | `<用途>.mjs`，**禁止 `.test.` 后缀** | 不被 runner 执行 |
| 前端测试 | `web/tests/` | `<主题>.test.ts`，扁平、全仓唯一 basename | `npm run test:web` |
| 前端共用辅助 | `web/tests/support/` | `<用途>.ts` | 不被 runner 执行 |
| 门禁 / 手动验收工具 | `scripts/`（手动真宿主脚本集中到 `scripts/acceptance/`） | `check-*.mjs` / `verify-*.mjs` | 手动或 `npm run check` |
| 一次性草稿 / 运行产物 | `work/`（数据）、`docs/`（过程材料） | 任意，**禁止 `.test.` / `.spec.` 后缀** | 手动，不进 CI |

**硬规则**：除 `test/{contract,internal,process}/` 与 `web/tests/` 外，全仓库（排除 `node_modules/`、`dist/`、`coverage/`、`work/`、`docs/`、`.git/`）不得出现 `*.test.*` / `*.spec.*`；`work/` 与 `docs/` 里也不得新建 `.test.` 文件，避免和真实套件混淆。

### 2.2 三类身份的判定（Agent 新建文件前必须先回答）

1. **能不能在所有人的机器上、无网络、无真实 CLI、无模型额度地自动跑完并给出稳定结论？** → 能，是 **CI 测试**，放第 2.1 节的四个测试目录，必须进 `npm test`。
2. **需要真实宿主 / 浏览器 / 人工观察 / 消耗额度，但结论需要长期复用？** → 是 **手动验收脚本**，放 `scripts/acceptance/`，入库，文件头必须写明「不进 CI、前置条件、预期结论、产物位置」，并在本文第 6 节登记。
3. **只为一次性调试或本次交付取证？** → 是 **过程草稿**，放 `work/` 或 `docs/`，不入库、不命名成测试、交付后由负责人决定清理。**禁止把它提交进仓库**。

### 2.3 新增门禁 `scripts/check-test-layout.mjs`（设计，待接入）

接入 `npm run check` 后由 CI 自动执行，检测项：

- 位置白名单：扫描到的 `*.test.*` / `*.spec.*` 必须落在第 2.1 节四个目录；`web/tests/` 下不得有子目录嵌套（除 `support/`）。
- 命名：`*.test.mjs`（后端）/ `*.test.ts`（前端），basename 全仓唯一；`test/support/`、`web/tests/support/` 内禁止 `.test.`。
- 禁止遗留标记：测试文件内不得出现 `.only` / `describe.only` / `it.only` / `test.only`；`.skip` 只允许平台守卫（如 win32），且必须在同一行有平台条件说明。
- 禁止外部依赖：测试文件不得 `import` / `spawn` 真实 `codex` / `claude` / `dsh` CLI，不得出现 `http://` 外部域名、不得写 `work/dev` 等用户数据目录（只允许 `mkdtemp` 临时目录）。
- 引用规范：前端测试引用产品代码只能用 `@/` 别名；`test/contract/` 新增「断言直读 store 行」仍由 `check-layering.mjs` 规则 A 的 ratchet 拦截。
- 任一失败 `exit 1`，打印文件路径与行号。

> 这条门禁把「统一管理」从文字约定变成机器可判定；它是整个方案里最优先落地的一项。

---

## 3. G0–G5 六层闸门（流程主干）

| 闸门 | 内容 | 命令 | 规模 / 实测耗时 | 触发条件 | 失败处置 |
| --- | --- | --- | --- | --- | --- |
| **G0** 静态门禁 | 语法、相对导入、文档链接、设计治理、分层红线、测试位置、版本、双端类型、ESLint | `npm run check` | ~29s | **任何改动**（含纯文档） | 必须修复，禁止绕过；豁免只加在 `check-design.mjs` 的 `EXEMPT_PATHS` |
| **G1** 契约 | `test/contract/` | `node --test test/contract/*.test.mjs` | 43 文件 / 279 用例 | 任何 `src/` 改动、公共行为变更 | 契约红 = 行为变了，先确认是有意变更还是回归 |
| **G2** 内部 | `test/internal/` | `node --test test/internal/*.test.mjs` | 20 文件 / 79 用例 | `src/store.mjs`、schema、聚合、迁移、平台分支 | 允许随实现重写测试，但必须同步改，不允许删 |
| **G3** 前端 | `web/tests/` | `npm run test:web` | 65 文件 / 382 用例 / ~97s | 任何 `web/src/` 改动 | 组件改名 / 移动后必须同步 SSR 冒烟的 marker 断言 |
| **G4** 进程与集成 | `test/process/` + `npm run desktop:smoke` | `node --test test/process/*.test.mjs` | 13 文件 / 32 用例 | `src/launcher.mjs`、`src/runtime.mjs`、`electron/`、CLI 入口 | 握手预算按 30s 量级给足；本地 smoke 硬失败 |
| **G5** 平台矩阵与发布 | 3 OS CI + tag 打包 + 人工真宿主验收 | GitHub Actions | — | `push` / `PR` / `v*` tag | 三平台任一红不得发布；人工验收不通过不得对外分发 |

补充规则：

- **G0 是唯一无条件闸门**，其余按第 4.2 节的改动类型选层；提交前必须全绿的是「本次改动应选的层」，不是每次穷举全量。
- **覆盖率永不设阈值**，只作为观察数据。理由：本项目大量契约测试用 SSR 冒烟与假宿主，行覆盖率与行为可信度不成正比；设阈值会诱导 Agent 写凑数断言。
- **flaky 不降级、不忽略**。已知 `information.test.mjs` 的 MCP capture、`attachments.test.mjs` 的临时目录清理、`test/process/subprocess.test.mjs` 的后代进程 pid 读取偶发不稳（2026-11-09 全量并发下出现 1 次 `assert.ok(descendant > 0)` 失败，单文件连跑 5 次全过，判定为并发资源竞态，非本次迁移引入，已登记 P3 待修）。正确处理是**修复竞态**，或在 `npm test` 显式加 `--test-concurrency=2` 并登记原因。禁止「连跑 3 次取一次绿」「降级为条件闸门」「标 skip 了事」；偶发失败必须在交付记录里如实写明，不得隐藏后声称「一次全绿」。
- **迁移链、崩溃恢复、win32 平台分支三类用例无条件保留**，不参与任何精简讨论。

### 3.1 单一入口（设计，待落地）

| 命令 | 作用 | 面向 |
| --- | --- | --- |
| `npm run verify` | 串行 `check → test:core → test:web → build`，任一失败即停并打印分层结论 | 负责人验收、Agent 提交前、发布前 |
| `npm run verify:fast` | 读 `git diff --name-only`，按第 4.2 节映射只跑应选的层 | Agent 日常迭代，目标 ≤60s |
| `npm run verify:report` | 生成结构化验证记录（命令、退出码、用例数、未覆盖项） | 交付取证 |

负责人**只需要记住 `npm run verify` 一条命令**；如果它是绿的，说明 G0–G4 全过。

---

## 4. Agent 必须遵守的规则

### 4.1 编号硬规则

- **A1** 写代码前先读本文第 2、3 节，判断改动落在哪一层；不确定时按「影响面更大的一层」处理。
- **A2** 规范只认本文件。`AGENTS.md` 与 `docs/` 过程材料若与本文冲突，以本文为准；发现冲突必须提出更新本文，不得自行沿用旧约定。
- **A3** 行为变更**先改契约测试再改实现**；重构内部结构时 `test/contract/` 必须全绿才算行为没变。改投递语义前先改 `test/contract/delivery-recovery.test.mjs`。
- **A4** 新增用例先判断「测的是承诺还是实现」：断言公共返回值 / HTTP / RPC → `test/contract/`；断言表内容 / schema → `test/internal/`；起真实进程 → `test/process/`；前端一律 `web/tests/`。
- **A5** 测试与实现**同一次提交**，提交信息用 Conventional Commits（`feat:` / `fix:` / `chore:` / `test:`），标题一行说清意图。
- **A6** 禁止在四个测试目录与 `scripts/acceptance/` 之外新建任何 `*.test.*` / `*.spec.*`；一次性验证脚本放 `work/` / `docs/` 且不得命名成测试，**不得提交进仓库**。
- **A7** 测试不得依赖真实宿主 CLI、模型额度、外网、固定端口、用户数据目录；宿主行为用 `fakeHost` 或临时目录里的假 CLI，数据目录用 `mkdtemp` + `t.after` 清理，路径拼接必须三平台中性。
- **A8** 禁止 `.only`；`.skip` 只允许带平台守卫条件；禁止为让门禁变绿而删除断言、放宽断言、下调 `layering-baseline.json`（下调只能因为存量违规被真实迁移掉）。
- **A9** 禁止绕过门禁：不修改 `check-*.mjs` 的豁免清单来掩盖违规，不删 workflow step，不给失败步骤加 `continue-on-error` 来「消红」，不改 `web/vite.config.ts` 的 `test.include` 来少跑测试。
- **A10** 交付时必须在回复中附一段**验证记录**（模板见 4.3），逐条列出实际跑过的命令与退出码；没跑的层要写明「未跑 + 原因」，**不允许把历史全绿当成当前版本的验收**。
- **A11** 覆盖率数字不参与测试价值判断，也不作为交付质量结论；报告只写观察值，不写「覆盖率达标」。
- **A12** 真宿主 / 浏览器 / 安装包验收是人工闸门（G5），Agent 不得代跑后宣称「已验收」；只能写「已执行脚本，结论见产物」，并注明消耗额度与隔离数据目录。

### 4.2 按改动类型选层（必跑表）

| 改动文件 | 必跑闸门 | 备注 |
| --- | --- | --- |
| `src/bus/`、`src/http/`、`src/aggregates/`、`src/tools/` 等公共入口 | G0 + G1 + G2 | 契约红优先排查 |
| `src/store.mjs` / schema / 迁移 | G0 + G1 + G2 + G4 | 迁移用例与崩溃恢复必须全过 |
| `src/hosts/`、`src/launcher.mjs`、`src/runtime.mjs`、`src/cli.mjs` | G0 + G1 + G4 | 用假 CLI，不调真实宿主 |
| `web/src/**`、`web/vite.config.ts`、`web/tsconfig.json` | G0 + G3 + `npm run build` | 组件改名后查 SSR marker |
| `electron/**` | G0 + G4 + `npm run desktop:smoke` | 本地 smoke 不得带 `ELECTRON_SMOKE_OPTIONAL` |
| `test/**`、`web/tests/**` 本身 | G0 + 对应层 | 只改测试也要跑 |
| `scripts/check-*.mjs`、`.github/workflows/**` | G0 + 全量 `npm test` | 门禁/流水线改动影响全局 |
| 仅 `*.md`（`README.md`、`DESIGN.md`、`guide/`、`skills/`） | G0 | 文档链接门禁会抓死链 |
| `package.json` 版本 / 发布相关 | `npm run verify` 全量 + `node scripts/build-release.mjs --dry-run` | tag 必须等于 `v` + 版本号 |

### 4.3 验证记录模板（Agent 交付必填）

```
改动范围：<文件/目录>
选中闸门：G0 + G1 + G3（依据：改了 web/src 与 src/http）
执行结果：
  npm run check        EXIT 0
  node --test test/contract/*.test.mjs  EXIT 0（279 用例）
  npm run test:web     EXIT 0（65 文件 / 382 用例）
未跑：G2 / G4 —— 原因：未改存储层与进程入口
未覆盖 / 待人工：真实宿主协作验收（G5，不进 CI）
遗留问题：<无 / 具体说明>
```

负责人核对时只需看：选中闸门是否与改动范围匹配、每个 EXIT 是否为 0、未跑项是否有合理原因。

---

## 5. CI/CD 流程设计

### 5.1 现状的六个问题

1. `npm run check` 是纯文本检查，平台无关，却在 3 个 OS 上重复跑 3 次（约 87s 冗余）。
2. `desktop-smoke` 与 `test` 并行、无依赖，且 CI 设了 `ELECTRON_SMOKE_OPTIONAL=1`，二进制缺失时静默 SKIP 变绿，注释却写「硬门禁」，名实不符。
3. `npm run coverage` 内联在 ubuntu 的 `test` job 里：没有阈值却可能因自身报错把 job 变红；报告不上传，负责人在 Actions 上看不到。
4. 两个 workflow 没有 `concurrency` 组，连续 push 会重复排队；`compatibility.yml` 没有 `paths` 过滤，纯文档改动也跑满三平台。
5. 没有测试位置 / 命名门禁，Agent 把测试写散不会被 CI 拦下。
6. 没有失败证据留存：job 红了只有日志，没有测试报告 artifact；GitHub 侧是否配置了 branch protection / required checks **仓库内无法确认**，若未配置，CI 变红也不阻止合并。

### 5.2 目标流水线

```
本地（Agent / 负责人）          GitHub Actions（push / PR）                 发布（v* tag）
─────────────────────          ─────────────────────────────              ──────────────
npm run verify:fast             gates(ubuntu, 一次)                       release.yml
  └ 按改动选层                   └ npm run check（含新门禁）                 └ needs: 三平台全绿
npm run verify                  test(3 OS, needs: gates)                  └ check + test + package
  └ 提交前全量                   └ build + dry-run + npm test                └ 归档 + SHA-256 + artifact
                                coverage(ubuntu, 独立, 不阻断)             人工：下载 → 真宿主/安装验收
                                  └ 上传覆盖率 HTML artifact                      → 创建 GitHub Release
                                smoke(macos, needs: test)
                                  └ Electron 启动冒烟（本地为硬，CI 为软并明示）
```

### 5.3 `compatibility.yml` 改造草案（待替换）

```yaml
name: Platform compatibility
on:
  push:
    branches: ['**']
  pull_request:
concurrency:
  group: compat-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
permissions:
  contents: read
jobs:
  gates:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: npm }
      - run: npm ci
      - run: npm run check          # 含 check-test-layout：测试位置/命名/.only/.skip/外部依赖
  test:
    needs: gates
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: npm }
      - run: npm ci
      - run: npm run build
      - run: node scripts/build-release.mjs --dry-run
      - run: npm test                # G1+G2+G3+G4，三平台
  coverage:
    needs: test
    runs-on: ubuntu-latest
    timeout-minutes: 15
    continue-on-error: true         # 观察数据，不是质量门禁
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: npm }
      - run: npm ci
      - run: npm run coverage
      - uses: actions/upload-artifact@v4
        with: { name: coverage-report, path: coverage/, retention-days: 14 }
  desktop-smoke:
    needs: test
    runs-on: macos-latest
    timeout-minutes: 15
    env:
      ELECTRON_SMOKE_OPTIONAL: '1'  # 明示：CI 为软门禁；本地 npm run desktop:smoke 为硬失败
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: npm }
      - run: npm ci
      - run: npm run build
      - run: node scripts/electron-smoke.mjs
```

`release.yml` 保持现有结构（tag 校验 / 打包 / 归档 / artifact 不自动发布），只补三处：加同样的 `concurrency` 与 `permissions`、在 `npm run check` 后自动获得新门禁、把「发布前人工清单」写进本文第 6 节而不是散落在 `docs/` 交接稿里。

> GitHub 服务端还需人工确认：`Settings → Branches` 对 `main` 开启 branch protection，把 `gates` / `test` / `desktop-smoke` 设为 required status checks。**这一步仓库文件无法表达**，不做的话 CI 变红只是显示红色，仍可合并。

### 5.4 门禁矩阵（负责人看这一张表就够）

| 检查 | 本地 `verify` | push / PR | `v*` tag | 是否阻断 |
| --- | --- | --- | --- | --- |
| 语法 / 导入 / 文档链接 / 设计治理 / 分层 / 类型 / lint | ✓ | ✓（ubuntu 一次） | ✓ | **硬** |
| 测试位置与命名（新增） | ✓ | ✓ | ✓ | **硬** |
| `npm run build` + 打包 dry-run | ✓ | ✓（3 OS） | ✓ | **硬** |
| G1–G4 自动化测试 | ✓ | ✓（3 OS） | ✓（3 OS） | **硬** |
| 覆盖率阈值 | 不设 | 不设 | 不跑 | 否（仅上传报告） |
| `desktop-smoke` | 硬 | 软（明示 SKIP） | 不跑 | 本地硬 / CI 软 |
| tag = `v` + package version | — | — | ✓ | **硬** |
| 真宿主 / 浏览器 / 安装包验收 | 手动 | 不跑 | 不跑 | 人工闸门 |
| 创建 GitHub Release | — | — | — | 人工 |

---

## 6. 负责人验收指南（不需要读懂源码）

1. **本地一条命令**：`npm run verify`（待落地；在此之前用 `npm run check && npm test && npm run build`）。看到 `EXIT 0` 和用例数即通过。
2. **看 Agent 交付**：要求附第 4.3 节的验证记录，核对「选中闸门」是否与改动范围匹配，警惕「历史全绿」「应该没问题」这类表述。
3. **看 CI**：PR 页面 4 个检查（`gates` / `test` 三平台 / `coverage` / `desktop-smoke`）；`coverage` 与 `desktop-smoke` 标黄/跳过不算失败，`gates` 或任一 `test` 变红必须修。
4. **看报告**：`coverage` job 的 `coverage-report` artifact 可下载，只作观察，不设达标线。
5. **发布前人工清单**：下载三平台 artifact → 校验 SHA-256 → 隔离目录安装启动 → 真实宿主协作验收（`scripts/verify-collaboration.mjs`，**会消耗模型额度**）→ 人工创建 GitHub Release → 发布后再更新 README 下载链接。源码 CI 全绿**不等于**安装包已验收。
6. **红灯处置**：先看是「门禁红」（G0，按错误信息改代码，不要改门禁）还是「测试红」（G1–G4，判断是有意行为变更还是回归）；偶发失败按第 3 节 flaky 规则修竞态，不要重跑蒙混。

---

## 7. 落地状态与实施计划

| 项 | 当前状态 |
| --- | --- |
| 两个测试根目录、三层后端 + 一层前端分层 | **已生效**（`npm test` 与 `AGENTS.md` 约定） |
| `npm run check` 7 段门禁链 | **已生效**，CI 三平台执行 |
| `test/contract` 分层 ratchet（规则 A）与纯 Web 红线（规则 B） | **已生效**，但规则 A 存量 33 处只告警 |
| G0–G5 分层、选层表、Agent 编号规则、验证记录模板 | **本文已定稿**（入库），尚无自动强制 |
| `scripts/check-test-layout.mjs` 与接入 `npm run check` | **设计完成，待实现** |
| `npm run verify` / `verify:fast` / `verify:report` | **设计完成，待实现** |
| workflow 拆分、coverage artifact、branch protection | **草案完成，待替换 / 待 GitHub 设置** |
| 前端测试迁移成果提交进仓库 | **未提交，P0 优先处理** |

### P0 — 先保住现有资产（零代码改动）

1. 确认第 1.7 节的 5 个「有意删除」符合预期：依据 2026-11-09 的冗余测试排查记录（本机过程材料，不入库），被删的 `message-context.ts` 已确认全仓零产品引用，`telemetry.test.mjs` 的 4 组独有断言已迁到 `manager-conversation.test.mjs`。
2. 把 `web/tests/`（66 个文件）与 70 个 `web/src` 删除、配置改动一并暂存并提交，避免换机器后前端测试归零。
3. 提交前再跑一次 `npm run check && npm test`（本次已实测全绿）。

### P1 — 让规范可被强制（本次设计的主体）

- 实现 `scripts/check-test-layout.mjs`，接入 `npm run check` 成为第 8 段；用 3 个反例探针验证门禁确实会失败：把测试放错目录、加 `.only`、在测试里 `spawn('codex')`。
- 实现 `scripts/verify.mjs` 与 3 条 npm scripts；`verify:fast` 按 4.2 节映射读 `git diff --name-only` 选层。
- 在本机 `AGENTS.md` 的「提交前门禁 / 测试分层」两节加上本文指针，删掉与本文重复的表述，避免两份规范漂移。

### P2 — CI/CD 改造

- 按 5.3 节替换 `compatibility.yml`，`release.yml` 补 `concurrency` / `permissions`；观察两轮 PR 全绿后再设 branch protection。
- 覆盖率报告上传 artifact；明确 `desktop-smoke` 为软门禁并在 PR 模板里注明。

### P3 — 清理与提速（可选）

- 按第 2.2 节把 `scripts/` 里的手动验收脚本归入 `scripts/acceptance/`；`docs/` 与 `work/` 的一次性脚本保持不入库，由负责人决定是否清理（**不得自动删除用户运行数据**）。
- 前端 65 个 worker 启动占 86% 时间，评估 `isolate: false` 或合并纯函数用例，目标把 G3 压到 30s 内。
- 修 `test/process/subprocess.test.mjs` 的 pid 读取竞态：等后代进程 `'spawn'` 事件后再输出 pid、父侧按完整行解析（当前只取第一个 stdout chunk 就断言）；或显式加 `--test-concurrency=2` 并登记原因。
- 规则 A 存量 33 处逐步迁移到公共入口断言，全部清零后设 `LAYERING_STRICT_A=1` 转为全量阻断（由负责人决定，Agent 不得自行开启）。

### 验收标准

- 负责人能用一条命令得到「通过 / 不通过 + 用例数」；
- Agent 把测试写散、加 `.only`、依赖真实 CLI 时，本地 `verify` 与 CI 都会失败并指出文件行号；
- CI 的红灯能阻止合并（需 GitHub 侧配置）；
- 每一条「必须遵守」都能在入库文件里找到，且至少有一处自动检查兜底。

---

## 附：本规范与既有约定的关系

- `AGENTS.md`（本机、不入库）：保留为速查与本机补充，测试部分以本文为准。
- `guide/development.md`：面向使用者的环境 / 构建说明，测试细节指向本文。
- `DESIGN.md` §验收与演进：前端人工浏览器验收清单，属 G5 人工闸门，与本文不冲突。
- `docs/adr/0005-layering-ratchet.md`：规则 A 的决策依据，仍有效。
- `docs/phase3-coverage-baseline.md`（不入库）：历史覆盖率基线，仅作观察记录；「覆盖率不设阈值」的结论已写入本文第 3 节。
