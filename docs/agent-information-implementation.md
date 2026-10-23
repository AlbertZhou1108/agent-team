# Agent 信息投影阶段一实施说明

日期：2026-10-23
状态：阶段一代码与测试已实施；独立审查与用户接受尚未完成

本说明对应 `docs/agent-information-design.md` 的阶段一：确定性投影、固定规则与动态事实分离、当前目标/工作项定向读取、有界消息与数据库正文引用、输入测量及新旧会话兼容。设计与实验仍以 `docs/agent-information-design.md` 和 `experiments/information-cost/` 为准；本文只记录实施取舍与验证入口。

## 实施位置

- `src/information.mjs`：新的宿主无关信息投影层。纯函数负责契约/工作项/消息投影、预算与引用；`Information` 类负责会话 schema 记录、数据库正文读取和测量写入。只读 `Store`/`Collaboration` 的权威对象，不修改它们。
- `src/bus.mjs`：成员规则装配、回合输入、`read`/`collaboration_read`、Panel `team_read`/`team_collaboration_read`/`team_snapshot`、测量接入。授权、回合来源校验、历史/审计顺序保持在投影之前。
- `src/tools.mjs`、`src/panel-tools.mjs`：在既有工具上增加可选的 `itemId`、`messageId`、`hash`、`offset`、`bodyLimit`，没有新增常驻工具，也没有改动工具名称。
- `src/store.mjs`：未改。新表由 `Information` 构造时以 `CREATE TABLE IF NOT EXISTS` 增量创建。
- `test/information.test.mjs`：投影不变量、新旧会话、Unicode 正文范围、撤权/跨团队/过期哈希、测量，以及 RPC/MCP/Panel/Codex 动态工具入口一致性。
- 未改业务权威对象、Web 观测 API、私聊隔离、审查结构、收尾语义、认证、全局模型配置或用户实验文件。

## 数据与兼容

新增四张表：

- `endpoint_context_formats`：成员端点按 `session_key` 记录 `schema_version`。已有原生会话（绑定或 `endpoint.session` 存在）记录为 `0`/`legacy-detected`；首次运行的新会话记录为 `1`/`new-session`。升级不会删除或重建宿主会话。
- `panel_session_context_formats`：Panel 会话同样区分 `0`/`1`；已有原生 Panel 会话继续旧视图。首次运行的会话记录为新格式。
- `turn_context_schemas`：每个回合的 `scope`（member/panel）与 schema，诊断时能判断该回合实际使用的路径。
- `information_measurements`：规则、回合输入、工具返回的字节数、schema、目标/契约/状态 revision 和按白名单挑选的元数据。**不保存消息正文或敏感正文**。

`resetSession` 是显式重建入口：它删除对应 `session_key` 的 schema 记录，下一次首次运行按新会话处理。除此之外没有静默迁移、静默删除历史或自动重建会话。

## 规则与回合输入

新格式会话的固定规则只包含身份、消息/私聊语义、权限与责任边界、独立审查/审查者只读、审查/收尾、交接和唤醒规则；不再包含成员目录、全局模型策略或完整协作快照（有模型规划职责的 lead coordination/private 规则附带模型策略）。旧格式会话保留原文规则。

新格式回合输入是独立的动态事实对象，至少包含：

- `contextSchemaVersion`、团队与目标身份、`goalVersion`/`contractVersion`/`stateRevision`、实际 `policy`；
- 完整契约、当前目标工作项（含 revision/state/artifact/evidence/reviews）、未决/阻塞及非当前目标未闭环工作项；
- 待决请求、未处理正式消息（有界摘要 + 稳定引用）、未知运行和运行计数；
- 相关记录（当前目标，按预算显式分页）、当前目标输出；
- 触发消息、合并的 `additionalMessages` 与 `notes` 的完整正文及引用。

本阶段优先保证“当前任务材料直接提供、旧历史可定位”。没有按关键词推断相关性，也没有把模型摘要当成权威来源。

## 消息与状态读取

`read`/`team_read` 在新格式会话默认返回有界列表：`id`、`seq`、作者、接收者、`kind`、`replyTo`、`created`、`workItemId`、完整性、`ref{id,sha256,length,unit}` 和有界预览。`nextAfter`、`hasMore`、`complete` 明确说明游标与范围完整性；预览不构成消费或处理。

正文通过同一工具的 `messageId + hash + offset + bodyLimit` 展开，单位固定为 Unicode code point（默认 1024，最大 4096）。读取时重新按当前团队和当前成员身份查询数据库；删除、跨团队、撤权、哈希变化、越界分别返回明确错误。引用由数据库消息 id 与内容哈希组成，不复制到通用磁盘内容库，也不向 communication 会话开放任意路径读取。

`collaboration_read`/`team_collaboration_read` 在新格式会话默认返回当前目标概况、工作项和必要未决责任；`itemId` 可按任意历史/当前工作项定向读取，保留其 `goalVersion`/`revision` 与对应记录。旧格式调用原样返回 `Collaboration.read()`。

`Collaboration.read()` 的 records 页现在多取 1 行再返回最多 100 行，并显式给出 `recordsHasMore`；因此记录数恰为 100 的整数倍时不会误报“还有更多”。投影使用该权威标志，按预算/目标过滤后的 `complete` 也只在该标志为 false 且无 omissions 时为 true。

## 预算与测量

默认预算集中在 `src/information.mjs`：固定规则 16 KiB、回合输入 512 KiB、协作状态 256 KiB、正文预览 512 code point、正文单页 4096 code point。这些是按本地测试负载设置的起始值，不是生产 token/费用结论。

- 必要事实超预算时抛出明确错误，不截断契约、工作项、未决责任或触发消息；回合输入失败会按既有 outbox 错误路径通知发送者。
- 可选记录/输出超预算时写入 `omissions`（字段、数量、原因、`nextAfter`），`complete=false`；记录只按游标续读，不跳过未交付内容。
- 规则预算在创建回合、启动宿主之前校验：新格式规则超过 16 KiB 时明确失败，经既有 outbox 错误路径通知发送者，宿主不运行，规则不会被截断。旧格式会话保留原文规则，不按新预算裁剪（兼容优先）。被拒绝的超限尝试不生成回合，因此不会产生该回合的 rules 行；`measureRules` 在诊断/回归直接调用时记录 `overBudget` 标记，便于确认预算判断本身。
- 每次成员/Panel 回合记录规则、回合输入、工具返回的字节数与 schema；`information_manifest`/`Bus.informationManifest(turnId)` 聚合工具调用数与正文展开次数。测量只记录字节，不宣称 token 或金额。

## 入口一致性

成员工具、MCP stdio、Codex 动态工具和 Panel 工具最终都调用同一 `Information` 投影函数：

- MCP 通过真实总线 `rpc` 进入 `Bus.tool`，沿用端点 key、组合回合来源和审计；
- Codex 动态工具由适配器调用同一 `Bus.tool`，工具 schema 仍由 `toolsFor` 固定生成；
- Panel 的 `team_*` 工具经 `Bus.panelTool` 使用同一投影与正文读取，保留 Panel 会话 key、团队关系和写权限检查；
- 新范围读取每次都重新认证并按团队查询，不因持有旧引用而永久可读。

## 验证

针对性：

```sh
node --disable-warning=ExperimentalWarning --test test/information.test.mjs
```

覆盖：投影必留事实与预算失败；固定规则包含独立审查/审查者只读语义且跨回合不变，动态事实更新；旧会话保持旧规则/旧读取形状且不重置；records 恰好 100 与 101 条的分页边界；规则超预算时宿主不启动并给出明确错误（不截断、不吞错）；Unicode code point 完整恢复与游标不跳读；过期哈希、删除、跨团队、撤权、错误 key 拒绝；测量字节/schema/revision/展开次数且明细不含正文；真实 RPC/MCP 返回与直接投影一致；Panel 工具读取与成员读取结构一致；模拟 Codex 动态工具协议返回同一有界投影。

完整核心回归（含既有实验测试）：

```sh
node --disable-warning=ExperimentalWarning --test test/*.test.mjs experiments/information-cost/*.test.mjs
```

本次结果：124/124 通过（116 项既有测试 + 8 项新增信息投影测试），无失败、跳过或取消。另 Web 单元测试 47/47 通过，`node scripts/check.mjs` 通过。该结果证明本地生产入口的投影/兼容/测量路径可用，不等于真实宿主模型行为或所有宿主配置都已验收。

## 已知限制

- 预算阈值来自本地测试负载，尚未用真实目标规模调参；也不代表费用优化幅度。
- 原生 Codex 动态工具入口用模拟宿主协议进程验证，未调用真实 Codex 模型；真实宿主若拒绝动态 schema 变化仍按既有 `reset-session` 入口处理。
- Panel 的固定说明仍包含当前团队上下文（coordination 会话固定；private 的 `activeTeamId` 同时出现在回合输入里），本阶段没有重写 Panel 说明结构。
- 既有 `history` 审计仍会保存工具调用的完整结果；测量表本身不重复保存正文。两者职责分开，未改变既有审计顺序。
- 未实现持久状态增量协议、摘要服务、UI 改动或生产发布启用；旧目标事件只按明确 identity/ID 读取，不自动推断跨项依赖。
- 最终成果仍需独立审查和用户接受；以上测试通过不替代审查结论。
