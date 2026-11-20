# ADR 0013：Phase 7 适配层收敛拆分方案

- 状态：提议
- 日期：2026-11-20
- 前置：三个桌面切片真机通过，发布门 10/10

## 背景

三家桌面切片（Codex / DSH / Claude）已完成真机验收，`desktopControlMcpSpec` 已收敛 MCP 配置构造（commit `d4c6f6d`）。Phase 7 还剩两项：

1. `surface` 元数据归位；
2. controller conversation / member engine / native host runtime 三层拆分。

**原则**：纯重构，不改变任何用户可见行为；独立分支；每一步可独立回滚。

## 现状规模

| 模块 | 行数 | 职责 |
| --- | --- | --- |
| `src/control-plane.mjs` | 1309 | 外部主控工具面、协议版本、能力过滤、唤醒门、工具定义 |
| `src/bus.mjs` | 280 | 总线、事件、调度入口 |
| `src/desktop/*.mjs` | 2845 | 三家检测/验证/安装/状态/管理 |
| `src/hosts/**` | 6058 | 四家引擎适配器 + 生命周期/策略/探针/子进程 |

## A. `surface` 元数据归位（低风险）

### 现状

`surface` 表示「连接是 cli 还是 desktop」，当前散落在 `desktop/manage.mjs`、`desktop/detect.mjs`、`desktop/codex.mjs`、`desktop/dsh.mjs`、`desktop/claude.mjs`、`control-plane.mjs`，都是字符串字面量。

它影响三件事：

- 桌面主控省略 `workspace` 时团队跟随会话 cwd（CLI 必须显式传）；
- 唤醒模式（`app-server` / `dsh` / 无）；
- 能力过滤（read-only 工具集）。

### 目标

把 `surface` 明确定义为**连接属性**，收口到一处常量与默认值，消灭散落字面量。

### 步骤

1. 梳理 `surface` 的全部读写点（6 个文件），列成清单；
2. 在 `src/hosts/definitions.mjs` 或新建 `src/desktop/surfaces.mjs` 定义 `SURFACES` 常量与 `defaultSurface(host)`；
3. 逐文件替换字面量，保持行为不变；
4. 加契约测试：CLI 连接必须显式 workspace，桌面连接跟随 cwd。

### 风险与验收

风险低（字符串替换）。验收：`npm run check` + 全量测试 + 一次桌面会话冒烟。

## B. 三层拆分（高风险，分三步）

### 目标边界

| 层 | 职责 | 现在在哪 |
| --- | --- | --- |
| controller conversation | 主控会话、协议、能力、工具面 | `control-plane.mjs` |
| member engine | 成员回合执行、工具桥、会话复用 | `hosts/*/index.mjs` 的 `run`/`close` |
| native host runtime | 进程、唤醒、生命周期、探针 | `hosts/subprocess.mjs`、`process.mjs`、`lifecycle.mjs`、`probe.mjs`、`wake-drivers.mjs`、`*/wake.mjs` |

### 步骤（每步独立提交、独立验证）

**B1：抽 `src/runtime/`**
移动 `subprocess.mjs`、`process.mjs`、`lifecycle.mjs`、`probe.mjs`、`wake-drivers.mjs`，修正 import。不改逻辑。

**B2：抽 `src/member/`**
把 `hosts/*/index.mjs` 中「成员回合执行」的部分（`run`、`close`、工具桥）与「宿主进程管理」分开；后者已在 B1 抽出。

**B3：收口 `src/control/`**
`control-plane.mjs` 拆分：协议/能力/工具定义 vs 业务动作。工具定义表（约 100 行）单独成文件。

### 风险与验收

风险高（文件移动 + 大面积 import 改动）。每步验收：`check` + `test:core` + **一次真实成员回合**（codex 单成员即可）。

## 不建议做的事

- **合并三家 desktop 的验证策略**：Codex 用隔离 `CODEX_HOME`、DSH 用 patch 文件、Claude 用 `-p`，差异是本质的，强行抽象只会增加分支判断。
- **把 `hosts/*` 合并成单文件**：四家引擎的协议不同（app-server / headless JSON / `-p` 流），合并会失去边界。

## 分支与顺序

```
refactor/phase7-adaptation
├── A  surface 归位        （1 个提交）
├── B1 抽 runtime          （1 个提交）
├── B2 抽 member           （1 个提交）
└── B3 收口 control        （1 个提交）
```

A 先做；B 每步合并前跑一次真机成员回合。任何一步回归失败，单独 revert 该提交即可，不影响其余。

## 不做的理由（如果决定停在这里）

当前 503 后端 + 389 前端用例全绿、发布门 10/10。上述两项只影响可维护性，不影响功能与安全。若近期有功能迭代压力，可长期停留在当前结构，等下一次大改时顺带做。
