# 成员 ↔ 主 Agent 用量查询 API 增量契约（v2 增量）

状态：**W1 定稿（2026-10-23；待主 Agent 与观测界面确认后冻结）**。

## 0. 基线与变更范围

- 本文件是增量契约，**base = `docs/host-telemetry-api-contract.md` sha256 `a54a62ebf64b4b01f96c49127cb9656cf3adb9d574957af62400f9d0d7a7d618`（683 行）**。
- 本文件只**新增**一个只读端点与相关类型；不修改、不覆盖、不静默改变 a54a62 的既有字段、必填项、归属、去重、语义或响应数值。
- 既有 `GET /api/telemetry/conversation`、`/coordination`、`/members`、`/capabilities` 的响应形状与数值保持不变；本文件新增的 `outgoingMessages`、`involvement` **不回填**到既有端点。
- 设计依据：`docs/host-telemetry-manager-conversation-design.md`（W1 定稿，见其 sha256）。
- 本期只读观测；不引入预算、费用、限流、自动压缩、停止、阈值或工作流控制；不提交、不部署。

## 1. 端点

```
GET /api/telemetry/manager-conversation?group=<groupId>&member=<memberId>&from=<iso>&to=<iso>&cursor=<opaque>&limit=<n>
```

### 1.1 请求参数

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `group` | 是 | 群 id；必须存在。 |
| `member` | 是 | 请求的成员 id；必须属于该群且 `removed IS NULL`。 |
| `from` | 否 | ISO-8601 时间；按批次 `startedAt`（回合创建时间）过滤，包含下界。 |
| `to` | 否 | ISO-8601 时间；不包含上界。`from >= to` 为 400。 |
| `cursor` | 否 | 不透明分页游标，由服务端返回；只作用于 `batches[]`。 |
| `limit` | 否 | 批次页大小，整数 1–100；缺省 20；越界/非整数为 400。 |

- `from`/`to` 同时存在时按 `[from, to)`；只存在一个时按单边范围。
- `group`/`member` 为空或纯空白视为缺失。
- 所有参数只影响查询，不产生写入或副作用。

### 1.2 管理者解析

- 管理者取请求时该群的当前 `teamController`。
- 若当前主 Agent 的 `kind` **不是** `panel_agent`（例如 handback 后为主 Agent 为成员），返回 **400**，`error` 提示改用成员 ↔ 成员双方会话；不返回空视图，以免误读为“无消耗”。
- 若管理者是当前群绑定的 Panel Agent，即使其 coordination 会话尚无遥测，也返回 200 与该侧空数据（`batchCount: 0`、`coverage.reasons` 含 `no_observations`），不报错。
- 本期只支持成员端入口；不提供协调端按成员筛选。

### 1.3 错误体

错误响应仍为 `Content-Type: application/json`：

```json
{ "error": "可读错误信息" }
```

| 状态 | 场景 |
| --- | --- |
| 400 | 缺少/空白 `group` 或 `member`；`from`/`to` 非法；`from >= to`；`cursor` 非法；`limit` 非法；当前主 Agent 不是 Panel Agent。 |
| 404 | 群不存在；成员不存在、已移除或不属于该群。 |
| 500 | 未预期服务端错误；不返回堆栈、凭据或内部路径。 |

## 2. 响应类型

### 2.1 顶层

```ts
interface ManagerConversationTelemetryResponse {
  schemaVersion: 1;
  readOnly: true;                 // 固定只读承诺
  groupId: string;
  generatedAt: string;            // ISO-8601

  range: {
    from: string | null;
    to: string | null;
  };

  member: {
    memberId: string;
    name: string;
    host: string;
  };

  manager: Executor;              // 本期恒为 kind='panel_agent'

  memberSide: {
    totals: Metrics;              // 成员侧 pair 批次；独占，可加
    contextReference: ContextReference;
    coverage: Coverage;           // 覆盖整个 from/to 范围，不受当前页影响
    batchCount: number;           // 整个范围，不受当前页影响
    physicalSessions: SessionTelemetry[];
  };

  managerSide: {
    involvementTotals: Metrics;   // 与该成员相关的管理者批次；相关性汇总，不可加
    exclusiveBatchIds: string[];  // 整个范围
    sharedBatchIds: string[];     // 整个范围
    involvedMemberIds: string[];  // 整个范围、去重、稳定排序
    batchCount: number;           // 整个范围，不受当前页影响
    physicalSessions: SessionTelemetry[];
    contextReference: ContextReference;
    coverage: Coverage;           // 覆盖整个 from/to 范围，不受当前页影响
  };

  batches: ManagerConversationBatch[]; // 成员侧 + 管理者侧相关批次的并集，按 2.4 排序，受分页影响
  nextCursor: string | null;           // 只翻 batches[]

  summary: {
    memberBatchIds: string[];
    managerBatchIds: string[];
    exclusiveManagerBatchIds: string[];
    sharedManagerBatchIds: string[];
    note: string;                // 固定说明：管理者侧为相关性视图，禁止相加/拆分
  };

  provenance: Provenance[];      // 全范围来源，供回查；不受当前页影响
}
```

- `memberSide` 只来自该成员 `context = pair:<managerId>` 端点上的批次；executor 恒为该成员。
- `managerSide` 只来自该群 Panel Agent 的 `panel-coordination` 批次中满足第 3 节相关性的批次。
- `batches[]` 是两侧批次的并集，用 `side` 区分；按 `batchId` 去重，同一批次只出现一次；同一 `frameworkTurnId` 不会同时出现在两侧。
- `manager.memberId` 在 `kind='panel_agent'` 时就是 `panelAgents.id`（并非群成员 id）；`Executor.memberId` 的既有语义不变。
- `managerSide.physicalSessions` 只列出**产生相关批次的**物理 session；其 `consumption`/`coverage` 是 **session 级累计**，包含该 session 的全部协调回合，不按请求成员的 involvement 过滤，因此不得与 `involvementTotals` 相加或相互替代。UI 必须标注“session 累计（不与相关性汇总相加）”。
- `managerSide.contextReference` 取自相关批次中**最新可用的请求采样**（不是整个协调会话）；`lastRequestInputRatio` 仅在输入采样与窗口采样都带非空 `provider+model` 且二者一致时计算，否则 `value:null`、`quality:"unknown"`、`missingReason:"scope_mismatch"` 或 `"dependency_missing"`、`model:null`。示例见 7.5。
- `memberSide.contextReference` 同理，只在成员侧批次范围内取最新可用采样并沿用同一路由规则。
- `summary.memberBatchIds` 与 `memberSide` 覆盖范围一致；`summary.managerBatchIds` 与 `managerSide` 覆盖范围一致。
- `summary.note` 为稳定中文说明，例如：`管理者侧为相关性视图：共享批次整批只计一次，禁止拆分或与成员侧/协调总量相加`。
- `range.from`/`range.to` 回显请求值（规范化后）；未提供为 `null`。

### 2.2 增量批次类型

```ts
interface OutgoingMessage {
  messageId: string;
  recipientId: string;            // 成员、用户、Panel Agent 或其它可解析 id
  recipientName: string;          // 可解析名称；无法解析时为 id
  recipientKind: 'member' | 'user' | 'panel_agent' | 'other';
  kind: 'send' | 'note';          // 与 messages.kind 一致
  createdAt: string | null;       // 消息创建时间
}

interface ManagerBatchInvolvement {
  involvedMemberIds: string[];    // 本批次涉及的当前未移除群成员；稳定排序
  exclusiveToMember: boolean;     // 唯一涉及成员就是请求成员
  sharedWithOtherMembers: boolean; // 涉及其他成员；与 exclusiveToMember 互斥
}

interface ManagerConversationBatch extends Batch {
  // 复用 a54a62 的 Batch 全部字段，不改变其含义
  side: 'member' | 'manager';
  outgoingMessages: OutgoingMessage[];   // member 侧固定 []
  involvement: ManagerBatchInvolvement | null; // member 侧固定 null
}
```

`outgoingMessages` 的约束：

- 只返回 `panel_message_origins` 可关联到该管理者回合、且消息类型为 `send` 或 `note` 的元数据；
- **严禁**返回 `messages.text`、提示词、完整聊天正文、凭据、环境变量、宿主配置或账户信息；
- 排序稳定：`createdAt` 升序（空值排最后），再按 `messageId` 升序；
- 仅用于触达/相关性展示，不改变 `executor`、`allocation` 或批次消耗归属。

`involvement` 的约束：

- `side='member'` 时固定 `null`，避免把成员执行误读为管理者相关性；
- `side='manager'` 时固定为对象，且 `involvedMemberIds` 必含请求成员；
- `involvedMemberIds` 只包含本群当前未移除成员：
  - 该批次输入消息的发送者（`panel_turn_inputs` ⋈ `messages.sender`）；
  - 该批次输出消息的收件人（`panel_message_origins` ⋈ `messages.recipient`）；
  - 两组 id 去重合并、按字符串升序稳定排序；
  - 用户、`system`、Panel Agent 本身、已移除成员不进入该数组。
- `exclusiveToMember = involvedMemberIds.length === 1 && involvedMemberIds[0] === memberId`；
- `sharedWithOtherMembers = involvedMemberIds.some(id => id !== memberId)`；
- 两项互斥；不可能同时为 true。

## 3. 归属与相关性规则

### 3.1 成员侧

- 范围：该成员端点上 `context = pair:<managerId>` 的批次。
- 执行归属：`executor = 请求成员`；物理 session 仍按 a54a62 的 `PhysicalSession` 身份规则。
- 成员侧 `totals` 是该成员在本 pair 会话中的**独占**小计，可在本视图成员侧内部相加；不得与管理者侧或其它视图相加。

### 3.2 管理者侧

管理者侧只纳入满足以下**任一**条件、且执行方为当前 Panel Agent 的 `panel-coordination` 批次：

1. **输入触发**：`panel_turn_inputs` 中存在发送者 = 请求成员的消息；
2. **输出触达**：`panel_message_origins` 中对应该回合的输出消息存在收件人 = 请求成员（覆盖用户触发、管理者主动发给成员的回合）。

补充：

- 只按输出收件人匹配即可纳入，即使该回合没有任何成员输入（`panel_turn_inputs` 为空）。
- 一个批次同时满足输入与输出条件时仍是同一批次，只出现一次、只计一次。
- `managerSide.involvementTotals` 是“与该成员相关的管理者执行汇总”，不是该成员独占消耗，也不是协调会话总量；不得跨成员相加，也不得与 `memberSide.totals` 相加。
- `managerSide.exclusiveBatchIds` 与 `sharedBatchIds` 均为整个查询范围的集合；`exclusiveBatchIds ∩ sharedBatchIds = ∅`，两者并集等于 `summary.managerBatchIds`。
- 共享批次整批展示、整批计入 `involvementTotals` 一次；不按成员拆分、不按成员平均、不为每个成员重复计全额。
- `managerSide.physicalSessions` 只列出产生相关批次的物理 session；其 `consumption`/`coverage` 是 **session 级累计**，包含该 session 的全部协调回合，不按请求成员的 involvement 过滤；不得与 `involvementTotals` 相加或相互替代。
- `managerSide.contextReference` 取相关批次中**最新可用的请求采样**（不是整个协调会话）；仅当输入采样与窗口采样都带非空 `provider+model` 且二者一致时计算 `lastRequestInputRatio`，否则 `value:null`、`quality:"unknown"`、`missingReason:"scope_mismatch"` 或 `"dependency_missing"`、`model:null`。

### 3.3 不可相加口径（API 与 UI 共同遵守）

1. 成员侧内部可加；管理者侧 `involvementTotals` 不可跨成员相加；
2. 成员侧与管理者侧不可相加；
3. 管理者侧与「主 Agent 协调会话」的 `summary.executorTotals` 不是同一口径，不可相加；
4. 同一共享批次可能出现在多个成员的管理者侧视图，任何跨成员求和都会重复计数；
5. API 不提供任何“合计/总计”字段；UI 不展示成员侧+管理者侧或跨成员合计；
6. 响应中的 `totals`/`involvementTotals` 只是各自范围内批次消耗的不同视图，不是可相加的账户余额。

### 3.4 去重、乱序、重试与部分用量

- 继续使用 a54a62 的批次构建与去重规则：重复观测 upsert、恢复旧回合通知路由、session reset、merged 投递整批一次、attempts 与 batch.metrics 不相加、partial/未知不补零。
- 本增量只在“相关性筛选”和“输出消息元数据”上扩展查询；不得因为输出消息存在而复制批次或重复累计消耗。
- 同一批次被多个成员的管理者侧视图命中时，各自响应独立展示同一份整批消耗；后端不得为每个成员生成不同金额。

## 4. 分页、时间范围与 coverage

- `from`/`to` 对两侧批次统一过滤；两侧 totals、`summary`、`involvedMemberIds`、`exclusiveBatchIds`、`sharedBatchIds`、coverage 均覆盖整个时间范围。
- `cursor`/`limit` 只作用于 `batches[]` 并集；翻页不改变 totals/summary/coverage。
- 排序：`startedAt` 升序（`null` 排最后），相同时间按 `frameworkTurnId` 升序，再按 `batchId` 升序作为确定 tie-breaker；重复查询顺序一致、不重复、不遗漏。
- `cursor` 是封装的键集游标，编码排序键 `(startedAt, frameworkTurnId, batchId)` 的末项；客户端不得解析或拼接。非法/不可解码/越界 `cursor` 返回 400；跨两侧连续翻页，不要求前端分别记录两侧游标。
- `limit` 缺省 20、范围 1–100；非整数、0、负数或 >100 返回 400。
- `nextCursor` 为 `null` 表示没有下一页；否则由服务端生成，客户端不得解析或自行拼接。
- `summary.memberBatchIds`、`summary.managerBatchIds`、`summary.exclusiveManagerBatchIds`、`summary.sharedManagerBatchIds`、`managerSide.exclusiveBatchIds`、`sharedBatchIds`、`involvedMemberIds` 均为全 `from/to` 范围、不受当前页影响；数组顺序按批次排序键或 `involvedMemberIds` 字符串升序稳定输出。
- 成员侧无批次：`memberSide.totals` 固定包含 9 个 Metric 键，全部 `value:null`、`quality:"unknown"`、`completeness:"unknown"`、`missingReason:"not_captured"`；`contextReference` 为固定缺失形状（`model:null`、比例 `dependency_missing`）、`physicalSessions: []`、`batchCount: 0`、`coverage.reasons` 含 `no_observations`。
- 管理者侧无相关批次：`involvementTotals` 同样固定 9 键全缺失、`exclusiveBatchIds`/`sharedBatchIds`/`involvedMemberIds` 为空数组、`physicalSessions: []`、`batchCount: 0`、coverage 含 `no_observations`。
- 两侧 coverage 分别计算；不使用一侧的 coverage 代表另一侧。空侧 UI 显示“无观测/—”，不得补零。
- 两侧 coverage 分别计算；不使用一侧的 coverage 代表另一侧。

## 5. 只读与安全

- 只允许 `GET`；不提供写入、控制、预算、费用、压缩、停止、阈值或工作流字段。
- `readOnly: true` 固定。
- 不返回消息正文、提示词、凭据、环境变量、宿主配置、完整路径或账户额度。
- `outgoingMessages` 仅用于展示“是否触达/涉及谁”，不得用于重建聊天内容。
- 查询不修改任何表，不触发宿主调用，不产生 outbox/队列副作用。

## 6. 向后兼容

- a54a62 的四个既有端点：字段名、必填、语义、数值、排序、分页行为均不变。
- 既有端点不新增 `outgoingMessages`/`involvement`，也不返回本响应类型。
- 本端点仅在成员端入口使用；不改变协调会话、双方会话、成员概览的展示口径。
- 若未来需要回填增量字段到既有端点，必须另立契约修订并重新验收，不能以本文件为依据。

## 7. 代表性示例

### 7.1 成员侧独占 + 管理者侧独占（第 1 页）

```json
{
  "schemaVersion": 1,
  "readOnly": true,
  "groupId": "g-1",
  "generatedAt": "2026-10-23T10:30:00.000Z",
  "range": { "from": null, "to": null },
  "member": { "memberId": "m-a", "name": "成员 A", "host": "claude" },
  "manager": { "kind": "panel_agent", "memberId": "p-1", "name": "主 Agent", "host": "codex" },
  "memberSide": {
    "totals": { "inputTokensTotal": { "value": 1200, "quality": "host_reported", "completeness": "complete", "scope": "query", "aggregation": "sum", "source": "query.aggregate", "observedAt": "2026-10-23T10:00:00.000Z", "formula": "sum(inputTokensTotal)", "missingReason": null } },
    "contextReference": { "lastRequestInputTokens": { "value": 1200, "quality": "host_reported", "completeness": "complete", "scope": "request", "aggregation": "snapshot", "source": "claude.result_usage", "observedAt": "2026-10-23T10:00:00.000Z", "missingReason": null }, "contextWindowTokens": { "value": 200000, "quality": "host_reported", "completeness": "complete", "scope": "request", "aggregation": "snapshot", "source": "claude.model_usage", "observedAt": "2026-10-23T10:00:00.000Z", "missingReason": null }, "lastRequestInputRatio": { "value": 0.006, "quality": "derived", "completeness": "complete", "scope": "request", "aggregation": "ratio", "source": "query.aggregate", "observedAt": "2026-10-23T10:00:00.000Z", "formula": "lastRequestInputTokens / contextWindowTokens", "missingReason": null }, "sampledAt": "2026-10-23T10:00:00.000Z", "sampleTurnId": "t-1", "model": { "provider": "anthropic", "model": "claude-x", "source": "claude.model_usage", "observedAt": "2026-10-23T10:00:00.000Z" } },
    "coverage": { "captureStartedAt": "2026-10-23T10:00:00.000Z", "complete": true, "reasons": [], "batchCount": 1, "completeBatchCount": 1, "partialBatchCount": 0, "unknownBatchCount": 0 },
    "batchCount": 1,
    "physicalSessions": []
  },
  "managerSide": {
    "involvementTotals": { "inputTokensTotal": { "value": 800, "quality": "host_reported", "completeness": "complete", "scope": "query", "aggregation": "sum", "source": "query.aggregate", "observedAt": "2026-10-23T10:01:00.000Z", "formula": "sum(inputTokensTotal)", "missingReason": null } },
    "exclusiveBatchIds": ["batch:t-2"],
    "sharedBatchIds": [],
    "involvedMemberIds": ["m-a"],
    "batchCount": 1,
    "physicalSessions": [],
    "contextReference": { "lastRequestInputTokens": { "value": null, "quality": "unknown", "completeness": "unknown", "scope": "request", "aggregation": "snapshot", "source": "unknown", "observedAt": null, "missingReason": "not_reported_by_host" }, "contextWindowTokens": { "value": null, "quality": "unknown", "completeness": "unknown", "scope": "request", "aggregation": "snapshot", "source": "unknown", "observedAt": null, "missingReason": "not_reported_by_host" }, "lastRequestInputRatio": { "value": null, "quality": "unknown", "completeness": "unknown", "scope": "request", "aggregation": "ratio", "source": "query.aggregate", "observedAt": null, "missingReason": "dependency_missing" }, "sampledAt": null, "sampleTurnId": null, "model": null },
    "coverage": { "captureStartedAt": "2026-10-23T10:01:00.000Z", "complete": true, "reasons": [], "batchCount": 1, "completeBatchCount": 1, "partialBatchCount": 0, "unknownBatchCount": 0 }
  },
  "batches": [
    {
      "batchId": "batch:t-2",
      "frameworkTurnId": "t-2",
      "side": "manager",
      "executor": { "kind": "panel_agent", "memberId": "p-1", "name": "主 Agent", "host": "codex" },
      "physicalSession": { "instanceId": "ps_panel_1", "host": "codex", "endpointId": "e-panel", "memberId": "p-1", "context": "panel-coordination", "peer": null, "sessionKey": "default", "hostSessionNamespace": "codex:default", "hostSessionId": "thread-1", "firstObservedAt": "2026-10-23T10:01:00.000Z", "resetAt": null },
      "inputBatch": { "batchId": "batch:t-2", "kind": "single_source", "messages": [], "sourceActors": [], "merge": { "merged": false, "sharedSources": false, "sourceCount": 0, "countedOnce": true, "splitBySource": false, "exclusiveSubtotal": true }, "allocation": "whole_to_executor" },
      "state": "succeeded",
      "startedAt": "2026-10-23T10:01:00.000Z",
      "endedAt": "2026-10-23T10:01:02.000Z",
      "attempts": [],
      "metrics": { "inputTokensTotal": { "value": 800, "quality": "host_reported", "completeness": "complete", "scope": "turn", "aggregation": "delta", "source": "codex.thread_token_usage", "observedAt": "2026-10-23T10:01:02.000Z", "missingReason": null } },
      "contextReference": { "lastRequestInputTokens": { "value": null, "quality": "unknown", "completeness": "unknown", "scope": "request", "aggregation": "snapshot", "source": "unknown", "observedAt": null, "missingReason": "not_reported_by_host" }, "contextWindowTokens": { "value": null, "quality": "unknown", "completeness": "unknown", "scope": "request", "aggregation": "snapshot", "source": "unknown", "observedAt": null, "missingReason": "not_reported_by_host" }, "lastRequestInputRatio": { "value": null, "quality": "unknown", "completeness": "unknown", "scope": "request", "aggregation": "ratio", "source": "query.aggregate", "observedAt": null, "missingReason": "dependency_missing" }, "sampledAt": null, "sampleTurnId": null, "model": null },
      "completeness": "complete",
      "anomalies": [],
      "provenance": [],
      "outgoingMessages": [
        { "messageId": "msg-9", "recipientId": "m-a", "recipientName": "成员 A", "recipientKind": "member", "kind": "send", "createdAt": "2026-10-23T10:01:01.000Z" }
      ],
      "involvement": { "involvedMemberIds": ["m-a"], "exclusiveToMember": true, "sharedWithOtherMembers": false }
    }
  ],
  "nextCursor": null,
  "summary": {
    "memberBatchIds": ["batch:t-1"],
    "managerBatchIds": ["batch:t-2"],
    "exclusiveManagerBatchIds": ["batch:t-2"],
    "sharedManagerBatchIds": [],
    "note": "管理者侧为相关性视图：共享批次整批只计一次，禁止拆分或与成员侧/协调总量相加"
  },
  "provenance": []
}
```

> 示例为说明形状，省略了 `Metrics` 中与示例无关的指标键，`physicalSessions`、`attempts`、`provenance` 等数组也为示例缩略；**7.1 中两侧 `batchCount: 1` 但 `physicalSessions: []` 仅表示示例省略，实际每个有批次的角色/session 必须至少出现一个对应 `SessionTelemetry`**。实际响应必须固定包含 a54a62 定义的全部指标键与既有 Batch 字段，缺失用 `value: null` + `missingReason`，不补零。

### 7.2 共享批次（成员 A 的视图中）

```json
{
  "batchId": "batch:t-3",
  "frameworkTurnId": "t-3",
  "side": "manager",
  "executor": { "kind": "panel_agent", "memberId": "p-1", "name": "主 Agent", "host": "codex" },
  "inputBatch": {
    "kind": "merged_delivery",
    "merge": { "merged": true, "sharedSources": true, "sourceCount": 2, "countedOnce": true, "splitBySource": false, "exclusiveSubtotal": false },
    "messages": [
      { "messageId": "msg-a", "senderId": "m-a", "senderName": "成员 A", "ordinal": 0, "role": "primary" },
      { "messageId": "msg-b", "senderId": "m-b", "senderName": "成员 B", "ordinal": 1, "role": "additional" }
    ]
  },
  "outgoingMessages": [
    { "messageId": "msg-c", "recipientId": "m-a", "recipientName": "成员 A", "recipientKind": "member", "kind": "send", "createdAt": "2026-10-23T10:02:01.000Z" },
    { "messageId": "msg-d", "recipientId": "m-b", "recipientName": "成员 B", "recipientKind": "member", "kind": "send", "createdAt": "2026-10-23T10:02:01.500Z" }
  ],
  "involvement": {
    "involvedMemberIds": ["m-a", "m-b"],
    "exclusiveToMember": false,
    "sharedWithOtherMembers": true
  },
  "metrics": { "inputTokensTotal": { "value": 1000, "quality": "host_reported", "completeness": "complete", "scope": "turn", "aggregation": "delta", "source": "codex.thread_token_usage", "observedAt": "2026-10-23T10:02:02.000Z", "missingReason": null } }
}
```

- 同一 `batchId` 也会出现在成员 B 的响应中，`involvement` 相同；
- 成员 A 与成员 B 都把该批次整批展示一次；不得把 1000 拆成 500/500，也不得在“独占”小计中重复计入。

### 7.3 输出触达、无输入的用户触发回合

```json
{
  "batchId": "batch:t-4",
  "side": "manager",
  "inputBatch": { "kind": "single_source", "messages": [], "sourceActors": [], "merge": { "merged": false, "sharedSources": false, "sourceCount": 0, "countedOnce": true, "splitBySource": false, "exclusiveSubtotal": true } },
  "outgoingMessages": [
    { "messageId": "msg-e", "recipientId": "m-a", "recipientName": "成员 A", "recipientKind": "member", "kind": "send", "createdAt": "2026-10-23T10:03:01.000Z" }
  ],
  "involvement": { "involvedMemberIds": ["m-a"], "exclusiveToMember": true, "sharedWithOtherMembers": false }
}
```

该回合按输出收件人纳入成员 A 的管理者侧，不要求 `inputBatch.messages` 非空。

### 7.4 缺失/部分与空侧

```json
{
  "memberSide": {
    "totals": {
      "outputTokens": { "value": null, "quality": "unknown", "completeness": "unknown", "scope": "query", "aggregation": "sum", "source": "query.aggregate", "observedAt": null, "missingReason": "not_captured" }
    },
    "batchCount": 0,
    "coverage": { "captureStartedAt": null, "complete": false, "reasons": ["no_observations"], "batchCount": 0, "completeBatchCount": 0, "partialBatchCount": 0, "unknownBatchCount": 0 }
  }
}
```

> 空侧用 `value:null`、`quality:"unknown"`、`missingReason:"not_captured"`、`coverage.reasons` 表达，不新增说明字段；实际响应中 `memberSide.totals`/`managerSide.involvementTotals` 必须固定包含 a54a62 的全部 9 个 Metric 键，示例只缩略展示一个键。该成员与当前主 Agent 尚无 pair 遥测时显示“无观测”，不补零。

### 7.5 contextReference 的 model=null / 不同路由

```json
{
  "managerSide": {
    "contextReference": {
      "lastRequestInputTokens": { "value": 900, "quality": "host_reported", "completeness": "complete", "scope": "request", "aggregation": "snapshot", "source": "dsh.context_pressure", "observedAt": "2026-10-23T10:04:00.000Z", "missingReason": null },
      "contextWindowTokens": { "value": 1000000, "quality": "host_reported", "completeness": "complete", "scope": "request", "aggregation": "snapshot", "source": "dsh.context_pressure", "observedAt": "2026-10-23T10:04:00.000Z", "missingReason": null },
      "lastRequestInputRatio": { "value": null, "quality": "unknown", "completeness": "unknown", "scope": "request", "aggregation": "ratio", "source": "query.aggregate", "observedAt": null, "missingReason": "scope_mismatch" },
      "sampledAt": "2026-10-23T10:04:00.000Z",
      "sampleTurnId": null,
      "model": null
    }
  }
}
```

> 输入与窗口都存在不代表可计算比例：必须证明二者来自同一非空 `provider+model`。模型未知时 ratio 必须为 `null`/`unknown` + `scope_mismatch`，UI 显示“—”，不得回填 0 或用 0.00295 之类的跨来源比值。`lastRequestInputTokens`/`contextWindowTokens` 仍可独立展示并标明来源。

### 7.6 分页边界

请求：

```
GET /api/telemetry/manager-conversation?group=g-1&member=m-a&limit=1
```

首次响应 `batches` 只有 1 条，`nextCursor` 为不透明值（例如 `"1"`）；再次请求带 `cursor=<该值>` 返回下一条。两次的 `memberSide.totals`、`managerSide.involvementTotals`、`summary`、`coverage` 完全相同，只 `batches` 与 `nextCursor` 变化；最后一页 `nextCursor: null`。非法 cursor 返回 400 `{"error":"cursor 无效"}`。

### 7.7 错误

```json
{ "error": "缺少 group 或 member 参数" }
```

```json
{ "error": "当前主 Agent 不是 Panel Agent，请使用成员 ↔ 成员双方会话" }
```

```json
{ "error": "cursor 无效" }
```

## 8. 后端与前端共同验收点

1. 成员侧只含 `pair:<managerId>` 批次，执行方为请求成员；成员侧 totals 核对采用：该成员只有该 pair 端点且无其他执行上下文时，可与「成员概览」该成员 totals 对照；若还有其他上下文，成员概览不单列 pair，只能按该 pair 端点 session/batch 明细核对，不得声称数值必然相等。
2. 管理者侧同时覆盖输入发送者=成员与输出收件人=成员；存在“无输入、仅输出触达”的用户触发回合测试。
3. 独占批次 `exclusiveToMember=true`；共享批次 `sharedWithOtherMembers=true`，两项互斥；共享批次不拆分、不重复计入独占。
4. 同一共享批次在 A/B 两个成员视图中 `batchId` 相同、`involvement` 相同；任何跨成员/跨侧求和都不在 API 或 UI 出现。
5. `outgoingMessages` 只有元数据，无正文/凭据；排序稳定；`involvement.involvedMemberIds` 全范围去重、字符串升序、只含当前未移除成员；`manager.memberId` 在 panel_agent 时为 panelAgentId。
6. `from`/`to`、`cursor`、`limit` 边界正确；非法 cursor/limit/from>=to 返回 400；分页不影响 totals/summary/coverage；排序稳定、跨两侧连续、不重复不遗漏。
7. 重复、乱序、恢复旧回合、merged、partial/缺失沿用 a54a62，不重复归因、不补零。
8. 错误体为 `{error}`，400/404 语义符合第 1.3 节。
9. 空侧固定形状：两侧 totals 9 键全 `value:null`/`quality:"unknown"`/`missingReason:"not_captured"`、`physicalSessions: []`、`batchCount: 0`、`coverage.reasons` 含 `no_observations`；无合计数字，不补零。
10. `managerSide.physicalSessions` 只含产生相关批次的 session；其 consumption/coverage 为 session 级累计（含该 session 全部协调回合，不按 involvement 过滤），不得与 `involvementTotals` 相加或替代。
11. `managerSide.contextReference` 取相关批次中最新可用采样；仅同一非空 `provider+model` 时计算 ratio，`model:null`/不同路由时 ratio `null`/`unknown` + `scope_mismatch` 或 `dependency_missing`，并提交示例验证。
12. 既有 conversation/coordination/members/capabilities 字段、数值、排序不变，不新增必填字段，不回填增量字段。
13. GET only、readOnly、无副作用、无业务控制联动。
14. 前端成员端入口：双栏并排、独占/共享徽标、不可相加提示、无合计数字、分页与 coverage、缺失“—”不补零。

## 9. 版本与证据

- 增量契约版本：v2 增量（新端点）；base = a54a62（683 行）。
- 本文件与设计文档的 sha256 由 W1 汇报给出；主 Agent 冻结后作为 W2/W3 的共同依据。
- 相关文档：
  - `docs/host-telemetry-api-contract.md`（a54a62，683 行，未改）
  - `docs/host-telemetry-design.md`（08e971cc…，未改）
  - `docs/host-telemetry-manager-conversation-design.md`（W1 定稿）
  - `docs/host-telemetry-manager-conversation-contract.md`（本文件）
