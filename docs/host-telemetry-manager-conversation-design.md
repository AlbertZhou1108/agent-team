# 成员 ↔ 主 Agent 用量视图设计

状态：**定稿（W1，2026-10-23；待主 Agent 与观测界面确认后冻结）**。现行契约仍为 `docs/host-telemetry-api-contract.md` 的 a54a62（683 行）；本文不修改该契约。下一次增量接口形状见 `docs/host-telemetry-manager-conversation-contract.md`（base=a54a62）。

## 1. 背景与问题

现有「双方会话」只接受两个**群成员**。当团队由 Panel Agent 主控时，成员与主 Agent 的会话对端是 Panel Agent（非群成员），因此：

- 成员 ↔ Panel Agent 的 pair 端点无法进入「双方会话」，界面报“成员不属于该群”（已在前端以提示兜底）；
- 数据本身并未丢失：成员侧在「成员概览」按执行归属可见，管理者侧在「主 Agent 协调会话」可见；
- 但缺少一个把两边并排看清楚的只读视图，尤其在 Panel Agent 主控团队里，这几乎是全部沟通。

**已确认的产品决策：**

1. 管理者侧**包含**管理者主动发出、由用户触发的消息（按回合输出消息的收件人归属），不只按成员触发的输入归属；
2. 本次**只做成员端入口**；协调端“按成员筛看”不在本期范围。

## 2. 目标与非目标

### 目标

- 新增只读视图：指定成员与其当前主 Agent（Panel Agent）之间的双方执行消耗；
- 管理者侧明确区分“独占”与“共享（涉及其他成员）”，共享批次整批展示、不拆分；
- 明确不可相加：成员侧、管理者侧、协调总量三者之间不提供求和，也不允许前端相加；
- 复用现有批次、分页、时间范围、coverage、provenance 口径；不新增采集。

### 非目标

- 不拆分、不按成员平均分配合并投递批次；
- 不改变「双方会话」（成员 ↔ 成员）、「主 Agent 协调会话」、「成员概览」的既有数值与接口语义；
- 不做协调端的按成员筛选（下一期）；
- 不引入预算、费用、限流、自动压缩等业务联动；
- 不实现“成员 ↔ 成员主 Agent”的新路径：那种情况主 Agent 本身是成员，现有成员 ↔ 成员视图已经覆盖。

## 3. 口径定义

### 3.1 角色

- **成员**：请求指定的本群未移除成员；
- **管理者**：`teamController` 解析出的当前主 Agent。本期只在管理者为 **Panel Agent**（`kind = panel_agent`）时提供该视图；若当前主 Agent 是成员，接口返回 400 并提示改用成员 ↔ 成员双方会话（因为此时它已是普通成员）。

### 3.2 成员侧（可加、独占）

- 范围：该成员 `context = pair:<managerId>` 的端点上的批次；
- executor 恒为该成员；
- 该端点的执行只属于该成员，因此成员侧 totals 是该成员的**独占**小计，可在本视图内相加；
- 与其他视图（成员概览、协调会话）不重复相加——它们是同一消耗的不同视图。

### 3.3 管理者侧（相关性汇总、不可加）

范围：该群 Panel Agent 的 coordination 会话中，满足以下任一条件的批次：

- **输入触发**：该回合的输入消息发送者中包含该成员；
- **输出触达**：该回合发出过收件人为该成员的消息（覆盖用户触发、管理者主动派发的回合）。

`involvedMemberIds` 由两部分成员 id 去重合并（只计本群当前未移除成员；用户、系统、Panel Agent 本身和已移除成员不进入该数组）：

- 输入消息中发送者为群成员的部分（`panel_turn_inputs` ⋈ `messages.sender`）；
- 输出消息中收件人为本群成员的部分（`panel_message_origins` ⋈ `messages.recipient`）。

由此定义：

- 请求成员必须出现在 `involvedMemberIds` 中；不相关的管理者批次不进入该成员视图；
- `exclusiveToMember = involvedMemberIds.length === 1`，且唯一成员就是请求成员；
- `sharedWithOtherMembers = involvedMemberIds` 含其他成员（此时也包含请求成员）；
- 两项互斥，不会同时为 true；
- 一个管理者批次只要涉及该成员，就出现在该成员的视图里；
- **共享批次会同时出现在多个成员的管理者侧视图中**，每次均整批展示、只代表“该回合真实消耗”，不是每个成员的独占消耗；
- 管理者侧 totals 命名固定为 `involvementTotals`，语义是“与该成员相关的管理者执行汇总”，不是独占小计；
- 成员侧 pair 批次的 `involvement` 固定为 `null`，`outgoingMessages` 固定为空数组，避免把成员执行误读成管理者相关性。

### 3.4 可加性规则（必须写进契约与 UI）

1. `memberSide.totals` 内部可加（独占）；
2. `managerSide.involvementTotals` **不能**跨成员相加，也**不能**与 `memberSide.totals` 相加；
3. `managerSide.involvementTotals` 与「主 Agent 协调会话」的 `summary.executorTotals` 不是同一口径，不相等、不相加；
4. 同一共享批次在不同成员的视图中可见，但任何跨成员求和都会重复计数；
5. UI 不展示“本次对话总消耗”“两人合计”等求和结果，只并排显示两栏与各自 coverage。

## 4. 数据来源

| 数据 | 现有来源 | 需要补充的工作 |
| --- | --- | --- |
| 成员侧批次 | `pair:<managerId>` 端点 + 现有批次构建 | 复用 |
| 管理者输入触发 | `panel_turn_inputs` + `messages.sender` | 复用 |
| 管理者输出触达 | `panel_message_origins` ⋈ `messages`（origin turn=当前批次，recipient=成员） | 现有采集已写入，查询层仅读取消息标识/收件人/类型/时间等元数据，不读取正文 |
| 成员/管理者身份 | `members`、`panel_agents`、`team_lead_controllers` | 复用 |
| 时间范围/分页/去重 | 现有 `_range` / `_page` / `_batches` 口径 | 复用 |

**不新增宿主采集**；这是纯查询层视图。失败/取消/部分用量沿用现有 batch 口径，缺失保持 `null`，不补零。

## 5. API 约定（增量契约摘要）

新增只读端点：

```
GET /api/telemetry/manager-conversation?group=<groupId>&member=<memberId>&from=&to=&cursor=&limit=
```

错误约定沿用现有契约：参数缺失/非法 400；群或成员不存在 404；当前主 Agent 不是 Panel Agent 返回 400，并给出可执行提示；错误体仍为 `{ "error": string }`。

完整请求/响应、错误体、分页、缺失语义与示例 JSON 以增量契约为准；以下为设计层摘要：

```ts
interface ManagerConversationTelemetryResponse {
  schemaVersion: 1;
  readOnly: true;
  groupId: string;
  generatedAt: string;
  range: { from: string | null; to: string | null };
  member: { memberId: string; name: string; host: string };
  manager: Executor; // 本期恒为 panel_agent

  memberSide: {
    totals: Metrics;                    // 独占，可加
    contextReference: ContextReference;
    coverage: Coverage;
    batchCount: number;
    physicalSessions: SessionTelemetry[];
  };

  managerSide: {
    involvementTotals: Metrics;         // 相关性汇总：不可与本视图其他部分或跨成员相加
    exclusiveBatchIds: string[];
    sharedBatchIds: string[];
    involvedMemberIds: string[];        // 跨整个查询范围合并去重
    batchCount: number;
    physicalSessions: SessionTelemetry[];
    contextReference: ContextReference;
    coverage: Coverage;
  };

  batches: ManagerConversationBatch[];  // 成员侧 + 管理者侧相关批次的并集，按时间排序
  nextCursor: string | null;
  summary: {
    memberBatchIds: string[];
    managerBatchIds: string[];
    exclusiveManagerBatchIds: string[];
    sharedManagerBatchIds: string[];
    note: string;                       // 固定说明：管理者侧为相关性视图，禁止相加/拆分
  };
  provenance: Provenance[];
}
```

批次类型的**增量字段**（仅新增端点返回；既有端点响应不变）：

```ts
interface ManagerConversationBatch extends Batch {
  side: 'member' | 'manager';
  outgoingMessages: Array<{
    messageId: string;
    recipientId: string;
    recipientName: string;
    recipientKind: 'member' | 'user' | 'panel_agent' | 'other';
    kind: 'send' | 'note';              // 与 messages.kind 一致，不读取正文
    createdAt: string | null;
  }>;
  involvement: {
    involvedMemberIds: string[];        // 该批次涉及的当前未移除群成员（输入发送者 + 输出收件人），稳定排序
    exclusiveToMember: boolean;         // 仅当请求成员是唯一涉及成员
    sharedWithOtherMembers: boolean;    // 涉及其他成员时为 true，与 exclusiveToMember 互斥
  } | null;                             // side='member' 时固定为 null
}
```

说明：

- 输出消息只用于“触达/相关性”，不改变执行归属；`allocation` 仍为 `whole_to_executor`；
- 共享批次不拆分、不重复计入独占小计；
- 既有端点的响应不新增必填字段，也不回填 `outgoingMessages`/`involvement`；本期只在新增端点返回，减少回归面。
- `managerSide.physicalSessions` 只列出产生相关批次的物理 session；其 `consumption`/`coverage` 是 **session 级累计**，包含该 session 的全部协调回合，不按请求成员的 involvement 过滤，因此不得与 `involvementTotals` 相加或相互替代。
- `managerSide.contextReference` 取自相关批次中**最新可用的请求采样**；`lastRequestInputRatio` 仅在同一非空 `provider+model` 路由下计算，否则 `value:null`、`quality:"unknown"`、`missingReason:"scope_mismatch"` 或 `"dependency_missing"`；示例契约包含 `model:null` 场景。
- 批次分页、`from/to` 边界、跨两侧并集排序键与 tie-breaker、`cursor` 键集与非法游标 400、`summary.*BatchIds` 覆盖整个范围等细节，以增量契约 `docs/host-telemetry-manager-conversation-contract.md` 为准。

## 6. UI 草案（仅成员端入口）

入口：会话用量页中，选中的端点 `context = pair:<panelAgentId>` 时渲染新视图；成员 ↔ 成员端点仍用现有「双方会话」。

```
┌ 成员 ↔ 主 Agent（Panel Agent 主控）────────────────────────────┐
│ 执行成员 · dsh            |  欧鲸鲸 · Panel Agent              │
│ ── 成员执行（独占）        |  ── 主 Agent 执行（相关性，不可加）  │
│ 指标卡 · 物理会话 · coverage | 指标卡 · 物理会话 · coverage      │
│                           |  [独占 3] [共享 2] [涉及其他成员 1]   │
├ 说明：管理者回合可能同时服务多个成员；共享批次整批展示，         │
│      不拆分、不重复计入；两栏不可相加。                        │
├ 批次列表（成员侧 / 管理者侧徽标、涉及成员、合并投递标记）        │
│  分页 · coverage · provenance                                  │
└───────────────────────────────────────────────────────────────┘
```

- 不显示任何“合计/总计”数字；
- 共享批次显示“涉及：X、Y”，并提示“该批次也出现在他们的视图中，不能相加”；
- 空数据：显示“无观测”，不补零；无 coverage 时如实说明；
- 只读，不提供任何业务操作。

## 7. 验收用例

1. 成员侧有数据、管理者侧无相关批次：两栏独立；成员侧正常，管理者侧 0 批次 + `no_observations`；
2. 成员触发管理者回合：按输入发送者纳入管理者侧；
3. 用户触发、管理者主动发给成员：按输出收件人纳入管理者侧（本期决策 1）；
4. 用户触发、该回合没有成员输入（`panel_turn_inputs` 为空）但输出收件人为该成员：仍须纳入管理者侧并标 exclusive；
5. 同一管理者回合同时发给 A、B：A/B 视图都出现同一 `batchId`，均标 shared，任何一侧都不把它计入“独占”；
6. 管理者独占批次：`exclusiveToMember = true`，进入 exclusive 列表；成员侧批次的 `involvement` 必须为 null；
7. 合并投递批次：整批展示，不拆分；输入 merged 与输出触达同时存在时仍是同一批次；
8. 成员侧 totals 的核对：当该成员只有该 `pair:<managerId>` 端点且无其他执行上下文时，成员侧 totals 可与「成员概览」中该成员 totals 对照；若该成员还有其他 pair/coordination 执行上下文，成员概览按 executor 汇总所有上下文，不能直接与该 pair totals 相等，应以该 pair 端点的 session/batch 明细核对。
9. 管理者侧 involvement 汇总与协调会话总和不相等、不相加；UI 无求和；
10. 时间范围/分页只影响批次列表，不影响两侧 totals/coverage；分页游标稳定且不重复批次；
11. 无遥测、成员被移除、主 Agent 非 Panel Agent、群不存在、参数缺失/非法、cursor 非法的错误语义；
12. 缺失/部分字段保持 null + reason，不补零；`outgoingMessages` 不含正文/凭据；
13. 只读校验（GET only，无副作用）；
14. 回归：成员 ↔ 成员双方会话、协调会话、成员概览数值不变，不新增必需字段。

## 8. 实施拆分与预估

| 阶段 | 内容 | 预估 |
| --- | --- | --- |
| 契约/设计评审 | 本文定稿、批次增量字段、口径与验收确认、契约版本/hash | 0.5 天 |
| 后端 | 读取 outgoing 触达、involvement 计算、新查询、路由、错误语义、核心测试 | 1–1.5 天 |
| 前端 | 类型/API/query、成员端新视图、共享/独占徽标、不可加提示、前端测试 | 0.8–1 天 |
| 验证/审查 | 真实数据核对、回归、独立审查、接受 | 0.5–1 天 |

合计约 **3–4 人天**；按上一轮团队流程需要独立审查与契约版本确认。

## 9. 已定稿决策与风险

- **合并投递**：坚持“整批只计一次、共享批次不做独占小计、跨成员不可加”；`merge.merged` 与 output 触达互不影响批次数量。
- **主 Agent 变更**：本期以请求时的当前 `teamController` 为准。若 handback（主 Agent 变为成员），返回 400 并指引成员 ↔ 成员视图；历史 Panel Agent 批次不进入本路径，是否需要“按执行者历史”视图留待下一期。
- **输出触达的边界**：只统计 `panel_message_origins` 中收件人为本群当前未移除成员的输出；发给用户、系统或已移除成员的输出仍可出现在 `outgoingMessages` 元数据中（如可解析），但不进入 `involvedMemberIds`，也不改变独占/共享判定。
- **是否回填现有接口**：本期不回填；`outgoingMessages`/`involvement` 只在新增端点返回，既有 conversation/coordination/members 响应形状与数值不变。
- **契约冻结**：a54a62 不可静默修改；本增量以新文档冻结，需要新目标/新契约版本与独立审查。
- **分页与统计分离**：`nextCursor`/`cursor` 只翻 `batches[]`；两侧 totals、`summary`、coverage 覆盖整个 from/to 范围，不随页变化。
- **只读与隐私**：只有 GET；`outgoingMessages` 仅消息 id、收件人 id/名称/类型、消息类型、时间，不返回正文、凭据或完整环境。
