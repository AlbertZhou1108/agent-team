# Unified member capability routing by explicit capability cards

Status: accepted

Supersedes [ADR 0008](0008-member-execution-policy.md). ADR 0008 把成员有效能力等同于「Group policy 天花板 × 宿主执行能力交集」；本 ADR 把定义扩展为「模型 × 宿主与策略」两维，统一三处派工入口的门禁，并增加执行前二次复核。其“天花板与安全降级必须可见、绝不替换更宽权限或备用模型”的规则继续作为执行维规则生效。

## Context

成员能否接住一次派工，取决于两类来源不同、更新节奏也不同的实时事实。**模型维**：成员当前生效模型在宿主实时 `modelCatalog` 中的 `inputModalities` / `contextWindow` / `reasoningEfforts`，随 `member_model` 或无头配置变更即时变化，且目录探测未执行或上游未返回字段时只能是未证实。**执行维**：Group policy 天花板经宿主执行方式与沙箱收敛后的授权结果（`exec.read` / `exec.write` / `exec.shell` / `tool.browser`），随群策略、宿主与沙箱变化。把两者压成一个策略标签，会让“只读策略下的视觉模型”和“可写策略下的纯文本模型”无法区分，也会让“模型能看图吗”“上下文够不够”这类派工成败只剩自由文本 `profile` 可猜。

派工入口有三个：群内成员 `send`、Panel Agent `team_send`、无头外部主控 `team_send`。此前只有无头入口按 `requiredCapabilities` 做入库前检查，另外两处凭正文与 `profile` 派工；检查也只在写库时发生，排队期间通过 `member_model` 换模或群策略收敛不会被发现，宿主进程仍会被拉起。能力缺失需要作为显式事实交给发送方与主控处置，而不是靠框架猜正文或悄悄换人。

## Decision

1. **两维有效能力，不做主观推断。** 成员有效能力 = 模型维（当前生效模型在实时目录中的 `inputModalities` / `contextWindow` / `reasoningEfforts`）∩ 执行维（Group policy 天花板 × 宿主支持 × 沙箱）。`profile` 继续只承载专长描述，不参与能力计算。`modal.image` 仅在 `inputModalities` 明确包含 `'image'` 时为 `true`，明确声明而不含时为 `false`，目录未返回或模型不在实时目录中为 `'unknown'`；`contextWindow` 未知为 `null`。模型维与执行维分开描述，是因为一边是宿主上报的事实、一边是授权结果：来源、刷新时机与失败模式都不同，合并会同时丢失两者。主控（lead 成员、Panel Agent、外部桌面主控）各自生成同构的只读能力视图，外部主控未声明的能力同样标为未证实。

2. **显式能力名片，调度者可见。** `members` / `team_members` / `team_snapshot` 在保留旧字段的同时返回只读能力名片（模型摘要、`effectivePolicy`、`effectiveCapabilities` 与主控块）；lead 与 Panel 协调回合的动态输入附精简 `teamCapabilities`。调度者据此决定是否附加能力要求，框架不解析聊天正文猜测需求。

3. **三入口统一门禁。** 群内 `send`、Panel `team_send`、无头 `team_send` 统一支持可选参数 `requiredCapabilities`（字符串数组，受枚举与长度校验，旧 `file.*` 别名归一化为 `exec.*`）与 `minContextWindow`（正整数）；未知能力 ID 按参数无效拒绝。`to: 'user'` 与未声明要求的普通 `send` / `note` 不受影响；若派工携带结构化图片附件，则自动并入 `modal.image` 要求，且不从正文推断。

4. **写库前首检 + 执行前二次复核。** 首检在写入 `messages` 之前计算目标成员此刻的有效能力，缺失或 `'unknown'` 立即报错（含目标成员、缺失项与真实原因），不落库、不入投递队列；无头入口保留 `error.code = 'capability_required'` 与 `details.missingCapabilities` 语义。要求随消息持久化（复用 `required_capabilities`，新增 `min_context_window`，`SCHEMA_VERSION` 24 → 25，逐级迁移，历史消息行无约束）。投递泵真正拉起宿主前，用最新模型选择、实时目录与最新生效策略重算一次；不再满足则绝不启动宿主，按既有 `delivery-failure` 落账并通知主控，同批满足要求的消息继续投递，不连坐整批。

5. **保守拒绝，失败显式可处置。** 未证实即不满足：`'unknown'` / `null` 逢显式强需求一律拒绝，并给出真实原因（模态未声明、上下文未知或小于门槛、策略只读、宿主未放行工具）。失败只回到发送方与主控，由主控用 `ask` 提出 `member_model` 切换、`group_add` 引入成员或交由有能力主控等方案；框架不自动换人、不静默换模，也不把一条派工改派给别的成员。

## Considered options

- **从自然语言或 `profile` 文本推断能力需求**：拒绝。关键词猜测既会漏判也会误判，同一句话在不同上下文下结论不同，失败原因无法复现；框架只认结构化字段与结构化媒体事实。
- **失败时自动改派给有能力成员或自动切到备用模型**：拒绝。隐藏的代选会同时破坏工作归属与用户授权，与“失败不触发隐式宿主切换”的既有原则冲突。
- **只在写库前检查一次**：拒绝。换模、目录刷新与策略收敛都发生在排队期间，二次复核正是为堵这个竞态。
- **把未声明的能力当作可用**：拒绝。乐观放行等于伪造能力声明；只在显式提出需求时保守拒绝，普通通信保持零摩擦。
- **要求所有宿主完成目录探测后才允许建队**：拒绝。目录缺失是正常状态，不应阻塞建队与日常通信。
- **保留纯策略定义，把模型能力写进 `profile` 文本**：拒绝。自由文本会与实时目录脱节，且无法参与机械校验。

## Consequences

- 能力计算的唯一事实源是实时模型目录与生效执行策略；上游未返回的字段保持未声明，界面与错误原因不得补猜。
- `messages` 新增 `min_context_window` 列并逐级迁移到 `SCHEMA_VERSION` 25，`src/tests/internal/` 需覆盖 v24 → v25；`required_capabilities` 复用现有列。
- 派工失败成为可观测事实：错误原因与主控通知进入既有投递与遥测链路，框架不做隐式修复。
- `GLOSSARY.md` 的 Member execution policy / Work dispatch / Capability degradation 三词条同步为本定义；专项规格与验收基线见 `docs/flows/2026-11-23-capability-cards-and-dispatch-guard/spec.md`。
