# Agent 信息投影实现

> 注:ADR 0004([通信内核优先](./adr/0004-revert-to-communication-core.md))已移除契约、工作项与目标生命周期等框架流程机制。本文中相关描述已过时,仅保留仍在实现的通信、遥测与宿主接入部分;流程相关段落以 ADR 0004 与 [README](../README.md) 为准。

日期：2026-10-24
状态：当前实现；已接入成员、Panel Agent、MCP、Codex 动态工具和本地生产服务

本文件记录 [Agent 信息访问与上下文投影](./agent-information-design.md) 的代码落点、数据边界和验证入口。

## 模块

- `src/information.mjs`：宿主无关的投影、消息引用、预算、schema 记录和测量实现。
- `src/bus.mjs`：成员与 Panel 回合装配、工具读取投影、规则预算、测量和会话重置接入。
- `src/tools.mjs`、`src/panel-tools.mjs`：在现有工具上暴露 `itemId`、`messageId`、`hash`、`offset`、`bodyLimit`。
- `src/store.mjs`：继续保存权威契约、工作项、消息、回合和执行记录；投影不修改权威对象。
- `test/information.test.mjs`：投影不变量、兼容、授权、分页和入口一致性回归。

## 运行时数据

`Information` 以增量建表保存：

| 表 | 用途 |
| --- | --- |
| `endpoint_context_formats` | 成员端点与物理 session 的上下文格式 |
| `panel_session_context_formats` | Panel 会话的上下文格式 |
| `turn_context_schemas` | 每个成员或 Panel 回合实际使用的 schema |
| `information_measurements` | 规则、输入和工具结果的字节/元数据测量 |

旧原生会话记录为 schema `0` 并继续原路径。新会话使用 schema `1`。`resetSession` 删除对应格式记录，使下一次运行按新会话处理；不会自动清空历史。

## 读取行为

新 schema 会话的消息和协作读取使用有界视图。预览可定位内容，不构成消费或处理证据。正文通过同一工具按数据库 ID、内容哈希和 Unicode code point 范围展开。

投影在授权和业务读取之后执行。每次读取重新检查当前团队、端点身份、成员状态、回合来源和引用哈希。错误、revision、权限和幂等回执完整保留。

成员 MCP、Codex 动态工具和 Panel `team_*` 工具最终进入同一 `Information` 投影函数。工具 schema 保持固定，只有新 schema 会话默认使用新的返回形状。

## 测量

框架记录规则、回合输入和工具返回的序列化字节数，以及 schema、目标、契约、状态 revision、消息展开次数和显式 omissions。测量是观察数据，不得改变宿主回合或工具结果。

测量不保存消息正文、凭据、环境或完整宿主配置。原始 history 与投影测量表职责不同，不重复相加。

## 失败边界

- 必要事实超预算：明确失败，不截断、不吞错。
- 可选材料超预算：返回 `omissions`、`complete=false` 和续读入口。
- 旧 hash、跨团队、已删除消息或失去访问权：拒绝读取。
- 旧会话格式：保留原规则和原返回形状。
- 投影测量失败：不影响业务结果。

## 验证

```bash
node --disable-warning=ExperimentalWarning --test test/information.test.mjs
npm test
npm run check
npm run build
```

回归覆盖新旧会话、规则预算、当前目标与工作项投影、Unicode 正文、100/101 条分页边界、撤权与跨团队拒绝、过期哈希、测量白名单，以及 RPC/MCP、Panel 和 Codex 动态工具的一致性。

`experiments/information-cost/` 保存方案探索阶段的合成与真实模型实验。它们说明设计取舍，不替代当前产品入口、真实宿主兼容和全量回归的验收。
