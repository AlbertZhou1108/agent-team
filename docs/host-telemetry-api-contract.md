# 宿主遥测查询 API 契约（v1）

> 注:ADR 0004([通信内核优先](./adr/0004-revert-to-communication-core.md))已移除契约、工作项与目标生命周期等框架流程机制。本文中相关描述已过时,仅保留仍在实现的通信、遥测与宿主接入部分;流程相关段落以 ADR 0004 与 [README](../README.md) 为准。

状态：当前接口契约。本文件是 `src/` 查询实现与 `web/` 只读展示共同消费的接口形状与身份口径；不改变 [宿主用量与会话统计设计](host-telemetry-design.md) 已定义的指标采集与聚合语义。API 响应形状与字段命名以本契约为准，采集/聚合语义以设计文档为准；设计文档统一指标表已使用 `inputTokensTotal`，宿主原始字段名（Codex `inputTokens`、DSH `inputTokens`、Claude `input_tokens`）仅在适配器内部映射，不作为 API 字段。若语义仍有冲突，以设计文档语义为准并回退本契约修订。

## 1. 总则

- 接口只读：仅 `GET`；不提供写入、预算、费用、压缩、停止、限流或其他业务联动字段。响应中的 `readOnly: true` 是固定承诺。
- 只观察消耗：不返回凭据、环境、提示词、消息正文、完整宿主配置或账户额度。可用消息编号、发送者和角色做关联，不复制消息文本。
- 统一命名：完整输入 token 在遥测 API 中只叫 `inputTokensTotal`。不得再出现 `inputTokens`、`input_tokens` 等别名；宿主原始名只保留在适配器内部与原始证据中。
- 数值单位：token 与耗时为非负 JSON number，耗时为毫秒；比例是 0–1 的 JSON number，展示层再转百分比。缺失值一律 `value: null`，不得用 0 代替；宿主明确报告的 0 才是有效 0。
- JSON 字段采用 camelCase；数据库列名不暴露给前端。
- 所有指标键固定存在（包括缺失字段的 `Metric` 对象）；缺失通过 `value: null`、`quality: "unknown"`、`completeness: "unknown"` 和 `missingReason` 表达。`Metric.formula` 与 `Metric.missingReason` 为条件字段，未知时为 `null` 或缺省；前端以指标键存在和 `value` 判断缺失，不得依赖“指标键不存在”。
- 数组顺序必须稳定：`batches` 按 `startedAt` 升序（空值排最后），相同时间按 `frameworkTurnId` 升序；同一查询重复执行结果顺序一致。
- 批次列表支持游标分页：请求 `cursor`、响应 `nextCursor`；`totals`、`summary`、`coverage` 始终覆盖查询时间范围内的全部去重数据，不受当前页影响。游标由服务端生成且不透明，前端不得解析或自行拼接。
- 响应中不得把不同 scope 或不同 aggregation 的值相加后仍沿用原 aggregation；查询层求和使用 `aggregation: "sum"` 且 `scope: "query"`。

## 2. 通用类型

```ts
type Quality =
  | 'host_reported'   // 宿主直接报告
  | 'derived'         // 由已报告的完整输入计算
  | 'measured'        // 框架实测
  | 'estimated'       // 估算；统一指标当前不使用，保留类型
  | 'unknown';        // 无值

type Completeness = 'complete' | 'partial' | 'unknown';

type MetricScope =
  | 'request' | 'step' | 'turn' | 'session'
  | 'query'            // 查询层聚合，仅在服务端生成
  | 'unknown';

type Aggregation =
  | 'delta' | 'cumulative' | 'snapshot'
  | 'sum' | 'ratio'    // 查询层聚合，仅在服务端生成
  | 'unknown';

type MissingReason =
  | 'unsupported'          // 适配器能力声明不支持该指标
  | 'not_reported_by_host' // 能力支持，但宿主本次未报告
  | 'not_captured'         // 框架/适配器尚未采集到该字段
  | 'scope_mismatch'       // 模型路由或 scope 不匹配，不能计算
  | 'dependency_missing'   // 派生值依赖项缺失或无定义
  | 'not_applicable'       // 该 scope 下指标无定义
  | 'anomaly';             // 计数回退、负值等异常

interface Metric {
  value: number | null;
  quality: Quality;
  completeness: Completeness;
  scope: MetricScope;
  aggregation: Aggregation;
  source: string;                 // 例如 codex.thread_token_usage；UI 原样展示或做可选标签
  observedAt: string | null;      // ISO-8601；未知为 null
  formula?: string;               // quality 为 derived 时必填
  missingReason?: MissingReason | null;
}

interface Metrics {
  inputTokensTotal: Metric;
  uncachedInputTokens: Metric;
  cacheReadTokens: Metric;
  cacheWriteTokens: Metric;
  outputTokens: Metric;
  totalTokens: Metric;
  cacheReadRatio: Metric;
  executionWallMs: Metric;
  hostTurnWallMs: Metric;
}

interface ContextReference {
  // 最近一次已完成模型请求的采样参考；不是累计值，不跨请求相加。
  lastRequestInputTokens: Metric;
  contextWindowTokens: Metric;
  lastRequestInputRatio: Metric;
  sampledAt: string | null;
  sampleTurnId: string | null;
  model: {
    provider: string | null;
    model: string;
    source: string;
    observedAt: string;
  } | null;
}

type ExecutorKind = 'member' | 'panel_agent';

interface Executor {
  kind: ExecutorKind;
  memberId: string;      // panel_agent 时为其稳定 id
  name: string;
  host: string;
}

interface PhysicalSession {
  instanceId: string;    // 不透明稳定 id；身份变化（含 reset）后必须变化
  host: string;
  endpointId: string;
  memberId: string;
  context: string;       // pair、coordination、panel-coordination（对端见 peer）
  peer: string | null;
  sessionKey: string;
  hostSessionNamespace: string; // 宿主实例/命名空间，如 codex:<config-dir>，不与 hostSessionId 分离使用
  hostSessionId: string | null; // 宿主明确提供的物理 session/thread 引用
  firstObservedAt: string | null;
  resetAt: string | null;
}

interface SessionTelemetry extends PhysicalSession {
  status: 'active' | 'ended' | 'reset' | 'unknown';
  // 物理 session 的累计视图；与批次/回合视图是同一消耗的不同视图，不得相加。
  consumption: Metrics;
  contextReference: ContextReference;
  coverage: Coverage;
}

interface Provenance {
  eventSeq: number | null;
  source: string;
  observedAt: string | null;
  scope: MetricScope;
  aggregation: Aggregation;
  nativeTurnId: string | null;
  stepId: string | null;
  requestId: string | null;
}

interface Coverage {
  captureStartedAt: string | null;
  complete: boolean;
  reasons: Array<
    | 'no_observations'
    | 'partial_capture'
    | 'missing_usage'
    | 'failed_attempt'
    | 'session_reset'
    | 'anomaly'
    | 'model_route_mismatch'
  >;
  batchCount: number;
  completeBatchCount: number;
  partialBatchCount: number;
  unknownBatchCount: number;
}

interface Anomaly {
  code:
    | 'negative_value'
    | 'total_mismatch'
    | 'count_regression'
    | 'session_identity_ambiguous'
    | 'overlapping_sources';
  fields: string[];
  detail: string;
  observedAt: string | null;
  raw: Record<string, number | string | null>; // 仅指标相关数字/来源，不含正文或环境
}
```

## 3. 指标字段含义

| 字段 | 含义 | 来源/计算 | 可加性 |
| --- | --- | --- | --- |
| `inputTokensTotal` | 含缓存读写的完整输入 token | Codex `inputTokens`；Claude `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`；DSH `inputTokens + cacheReadTokens + cacheWriteTokens` | 仅同一 scope 的非重叠 delta 可加 |
| `uncachedInputTokens` | 未缓存输入 token | Claude/DSH 的未缓存输入；Codex 完整输入减缓存读写 | 同上 |
| `cacheReadTokens` | 缓存读取输入 token | 各宿主对应计数 | 同上 |
| `cacheWriteTokens` | 缓存创建输入 token | Codex `cacheWriteInputTokens`；Claude `cache_creation_input_tokens`；DSH `cacheWriteTokens` | 同上 |
| `outputTokens` | 宿主报告的输出 token（已含其计入的推理 token） | 各宿主 output 字段 | 同上 |
| `totalTokens` | 完整输入与输出之和 | 优先宿主 total；仅输入输出完整时可计算 | 同上 |
| `cacheReadRatio` | 缓存读取占完整输入的比例 | 同一完整样本集合上 `cacheReadTokens / inputTokensTotal` | 比例，不可求和；分母为 0 或缺失时无定义 |
| `executionWallMs` | 框架执行经过时间 | 适配器 run 调用到 settle 的单调时钟测量 | 累计执行时间，不是用户等待时间 |
| `hostTurnWallMs` | 宿主原生回合经过时间 | Codex `turn.durationMs`；Claude `result.duration_ms`；DSH `turn/end.time - turn/start.time` | 同上 |
| `lastRequestInputTokens` | 最近已完成请求的完整输入 token | 各宿主最近请求/消息 usage 的采样 | 采样值，不可求和 |
| `contextWindowTokens` | 对应模型路由的上下文容量 | 宿主报告的窗口容量 | 容量，不可求和 |
| `lastRequestInputRatio` | 最近请求输入 / 上下文容量 | `lastRequestInputTokens / contextWindowTokens` | 采样比例，不可求和 |

补充规则：

- 任何字段缺失、缓存桶未知或样本不完整时，不得按 0 参与 ratio 或 total 计算。
- 派生值出现负值或宿主 total 与输入输出不一致时，`value` 为 `null` 或保留为 partial 的已知部分，且必须带 `Anomaly`；不得静默修正为零或覆盖原值。
- `lastRequestInputTokens`、`contextWindowTokens`、`lastRequestInputRatio` 只出现在 `ContextReference`，不进入 token 总量；模型路由不匹配或窗口不大于 0 时，ratio 的 `value` 为 `null`、`missingReason: "scope_mismatch"` 或 `"dependency_missing"`。
- 汇总 cache 比例使用汇总分子除汇总分母，且分子分母来自相同完整样本集合；不平均逐回合比例。`quality: "derived"` 时必须给出 `formula`。
- 汇总 `executionWallMs` / `hostTurnWallMs` 是累计执行时间，不是墙钟等待时间；并发执行不能解释为用户串行等待。

## 4. 批次、身份与归属

### 4.1 执行归属

- `executor` 永远是实际执行宿主回合的成员/面板 Agent。谁发消息触发不改变执行归属；消息发送者只出现在 `inputBatch.sourceActors`。
- `PhysicalSession` 身份为 `(host, hostSessionNamespace, endpointId, sessionKey, hostSessionId)`，并以 `instanceId` 作为对外稳定引用。不得跨宿主或跨宿主实例按字符串合并 `hostSessionId`。
- 无法取得 `hostSessionId` 时，`hostSessionId: null`，`instanceId` 仍须按绑定唯一且不得与其他绑定合并。`instanceId` 在 session reset 后必须变化；旧批次继续引用旧 `instanceId`，新累计不得延续旧基线。
- `captureStartedAt` 表示框架开始采集该统计的时间；部分采集时 `coverage.reasons` 必须包含 `partial_capture`，不得冒充宿主全量累计。

### 4.2 输入批次

```ts
interface InputBatch {
  batchId: string;                 // 与响应中 batch.batchId 一致，稳定不变
  kind: 'single_source' | 'merged_delivery';
  messages: Array<{
    messageId: string;
    senderId: string;
    senderName: string;
    ordinal: number;
    role: 'primary' | 'additional' | 'note';
  }>;
  sourceActors: Array<{
    actorId: string;
    actorName: string;
    kind: ExecutorKind | 'user';
    messageIds: string[];
  }>;
  merge: {
    merged: boolean;          // 是否含 additionalMessages
    sharedSources: boolean;   // 输入来源成员是否多于一个（跨来源共同批次）
    sourceCount: number;
    countedOnce: true;        // 整批只计入执行方一次
    splitBySource: false;     // 不按来源拆分或平均
    exclusiveSubtotal: boolean; // 单来源批次可计入所在对话独占小计；跨来源共同批次为 false
  };
  allocation: 'whole_to_executor'; // 永远整批归执行方，不按来源分摊
}

interface Batch {
  batchId: string;
  frameworkTurnId: string;
  executor: Executor;
  physicalSession: PhysicalSession;
  inputBatch: InputBatch;
  state: 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  startedAt: string | null;
  endedAt: string | null;
  attempts: Array<{
    attemptId: string;
    state: 'succeeded' | 'failed' | 'cancelled' | 'unknown';
    hostTurnRef: string | null;
    observedAt: string | null;
    completeness: Completeness;
    metrics: Metrics | null;       // 仅当存在独立尝试级指标视图；否则 null，已知部分见 batch.metrics，不得推断为 0
  }>;
  metrics: Metrics;                // 本回合/批次选择的非重叠视图，不与 attempts 视图相加
  contextReference: ContextReference;
  completeness: Completeness;      // 批次内最差值：complete < partial < unknown
  anomalies: Anomaly[];
  provenance: Provenance[];
}
```

规则：

- 单一来源回合 `kind: "single_source"`；合并投递回合 `kind: "merged_delivery"`，整批消耗只记一次，所有消息和发送者保留在 `messages`/`sourceActors`，不拆分、不向每个成员重复计入全额。
- `merge.sharedSources` 显式区分跨来源共同批次（`sourceActors` 多于一个）。共同批次 `exclusiveSubtotal: false`，在协调会话独立展示，不进入各双人对话独占小计；单来源批次 `exclusiveSubtotal: true`。
- `attempts` 仅用于回查重试、失败、取消与部分用量；`batch.metrics` 与 `attempts[].metrics` 是同一消耗的不同视图，不得相加。失败或取消不等于零消耗：已报告的部分用量必须保留并标 `partial`/`unknown`，优先放在该尝试的 `attempts[].metrics`；若宿主没有提供独立尝试级视图，则允许 `attempts[].metrics: null`，已知部分保留在 `batch.metrics`，并在 `attempts[].completeness` 标明部分性，前端不得把 `null` 推断为 0。
- 重试若每次尝试都真实消耗 token，批次视图由服务端选择非重叠来源（例如 step 汇总或各尝试 delta 的合并）；乱序、重复、旧回合重发和计数回退不得强行生成回合值。
- 历史上下文中的成员消息不进入本批次 `sources`；只保留实际投递消息与 notes。
- `batch.completeness` 是批次级最差值；字段级完整性在 `Metric.completeness` 中单独表达，两者不一致时以字段级为准，批次级必须说明存在部分数据。

### 4.3 去重与不重叠保证

查询由服务端完成去重与来源选择，前端不得自行重算。以下为 API 必须满足的保证：

1. Codex 累计快照重复到达只保留一份；恢复 session 时重发的旧 `nativeTurnId` 数据路由至原回合，不回填当前回合。`last` 与累计 `total` 不混加。
2. Claude assistant 事件按宿主消息身份去重并更新最终值；`result` 运行汇总不再与该运行内 assistant 统计相加。
3. DSH `step_end` 是该步骤尝试的汇总；不再叠加 assistant/message 或 session tokenUsage 投影。
4. 累计差值只在同一物理 session、顺序明确、基线完整且计数未回退时生成；否则保留原始观测并标 `unknown`/`partial`，不生成回合值。
5. session 总量与回合总量、step 与 turn、attempt 与 batch 都是同一消耗的不同视图；不得相加。查询层求和只使用 `aggregation: "sum"` 且明确非重叠的 delta 集合。
6. 只有显式宿主报告 0 才输出 `value: 0`；未知缓存桶、缺失字段、未采集范围都输出 `null`。

## 5. 查询接口

以下查询端点均只读，查询参数相同的时间范围语义：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `group` | 是 | 群 id |
| `from` | 否 | ISO-8601，包含；按批次 `startedAt` 过滤，整批保留，不裁剪批次内指标 |
| `to` | 否 | ISO-8601，不包含；按批次 `startedAt` 过滤 |
| `cursor` | 否 | 上一页响应的 `nextCursor`；不传表示第一页。聚合 `totals`/`summary`/`coverage` 不受游标影响。 |
| `limit` | 否 | 当前页批次数，默认 20，最大 100；服务端不得静默截断或丢弃批次。 |

时间范围缺失表示使用全部已采集数据。无遥测时返回 200 与空数组、`null` 值组合，不返回 404，也不补零。批次列表分页；成员列表与 `provenance` 不分页（数量分别受群成员数与来源事件数约束）。

错误约定：参数缺失/非法返回 400；群或成员不存在返回 404；错误响应 `Content-Type: application/json`，错误体 `{ "error": string }`。只读接口不返回业务状态或可执行操作。

### 5.1 会话双方遥测

`GET /api/telemetry/conversation?group=<groupId>&member=<memberId>&peer=<peerMemberId>`

选择该二人 pair 会话端点上的执行回合。响应：

```ts
interface ConversationTelemetryResponse {
  schemaVersion: 1;
  readOnly: true;
  groupId: string;
  generatedAt: string;
  range: { from: string | null; to: string | null };
  conversation: {
    participantIds: [string, string];
    participants: Array<{ memberId: string; name: string; host: string }>;
  };
  executors: Array<{
    executor: Executor;
    physicalSessions: SessionTelemetry[]; // 按物理 session 分别展示累计与最近请求；不得相加到 batch
    batchCount: number;
    totals: Metrics;              // 只含本会话批次，按执行方分开
    contextReference: ContextReference; // 该执行方在本会话内最近采样
    coverage: Coverage;
  }>;
  batches: Batch[];               // 每个批次只出现一次；合并批次不拆分
  nextCursor: string | null;      // 批次分页游标；summary/totals 覆盖整个查询范围
  summary: {
    singleSourceBatchIds: string[];
    mergedBatchIds: string[];          // 含 additionalMessages 的全部批次
    sharedSourceBatchIds: string[];    // 来源成员多于一个的共同批次
    sourceSubtotals: Array<{
      sourceActorId: string;
      sourceActorName: string;
      totals: Metrics;            // 仅单来源批次；合并批次不计入
      includedBatchIds: string[];
      excludedMergedBatchIds: string[];
    }>;
    coverage: Coverage;
  };
  provenance: Provenance[];       // 本响应涉及的来源聚合，供回查
}
```

- `executors[]` 通常包含双方各一项；某一方从未执行时仍可返回该项，`batchCount: 0`、`totals` 全部 `value: null`、`coverage.reasons: ["no_observations"]`，不得补零。
- 双方消耗互不合并；`sourceSubtotals` 是触发来源分析视图，不能与执行归属总量相加。
- 合并批次整批计入其执行方 `totals` 一次；`summary.mergedBatchIds` 单独列出，`summary.sharedSourceBatchIds` 标出跨来源共同批次；`sourceSubtotals` 不拆分也不重复计入。
- `nextCursor` 只用于 `batches[]` 翻页；`executors[].totals`、`summary` 与 `coverage` 始终覆盖请求时间范围内的全部数据，避免翻页改变合计。
- `executors[].physicalSessions[]` 是 session 累计视图：同一物理 session 只出现一次，`reset` 后生成新 `instanceId`；其 `consumption` 与 `batches[].metrics` 是同一消耗的不同视图，禁止相加。

### 5.2 主 Agent 协调会话

`GET /api/telemetry/coordination?group=<groupId>`

`group` 唯一必填；服务端解析该群当前主 Agent/协调执行方。协调会话不存在或尚无遥测时返回 `coordination: null` 或空批次，不报错。

```ts
interface CoordinationTelemetryResponse {
  schemaVersion: 1;
  readOnly: true;
  groupId: string;
  generatedAt: string;
  range: { from: string | null; to: string | null };
  coordination: {
    executor: Executor;
    physicalSessions: SessionTelemetry[];
  } | null;
  batches: Batch[];               // 按输入批次逐条，合并批次独立成条
  nextCursor: string | null;      // 批次分页游标；summary/executorTotals 覆盖整个查询范围
  summary: {
    executorTotals: Metrics;      // 每个批次只计一次，按执行方汇总
    contextReference: ContextReference;
    singleSourceBatchIds: string[];
    mergedBatchIds: string[];     // 含 additionalMessages 的全部批次
    sharedSourceBatchIds: string[]; // 跨来源共同批次，独立展示
    sourceSubtotals: Array<{
      sourceActorId: string;
      sourceActorName: string;
      totals: Metrics;            // 只含单来源批次；共同批次不拆入
      includedBatchIds: string[];
      excludedMergedBatchIds: string[];
    }>;
    coverage: Coverage;
  };
  provenance: Provenance[];
}
```

- `batches[]` 中每个 `inputBatch.kind: "merged_delivery"` 是独立批次，UI 展示整批总消耗与全部来源；不得为每个来源各显示一份全额，也不得平均拆分。`merge.sharedSources: true` 的跨来源共同批次另见 `sharedSourceBatchIds`。
- `summary.mergedBatchIds` 中的批次不进入 `sourceSubtotals`；`sharedSourceBatchIds` 中的共同批次在协调视图独立展示且 `exclusiveSubtotal: false`，其消耗仍计入 `executorTotals` 一次。这样“按执行归属总量”和“按消息来源分析”口径分开。
- 批次不因来源数量被拆成多个 `Batch`；`batchId` 稳定，合并投递跨刷新不变。

### 5.3 群成员概览

`GET /api/telemetry/members?group=<groupId>`

按执行归属汇总该群各成员与（若存在）面板 Agent 的消耗，只包含群相关执行上下文（`pair`、`coordination`、`panel-coordination`），不包含用户私聊或面板私聊上下文。

```ts
interface MembersTelemetryResponse {
  schemaVersion: 1;
  readOnly: true;
  groupId: string;
  generatedAt: string;
  range: { from: string | null; to: string | null };
  members: Array<{
    executor: Executor;
    physicalSessions: SessionTelemetry[]; // 每个物理 session 的累计与最近请求，可按 session 下钻
    physicalSessionCount: number;
    batchCount: number;
    totals: Metrics;              // 按执行成员汇总，不按发送者
    contextReference: ContextReference; // 该成员最近一次可用采样
    coverage: Coverage;
  }>;
  sourceAnalysis: {
    note: string;                 // 固定说明：仅来源分析，不可与执行归属总量相加
    actors: Array<{
      sourceActorId: string;
      sourceActorName: string;
      totals: Metrics;              // 仅单来源批次
      includedBatchIds: string[];
      excludedMergedBatchIds: string[]; // 合并批次不拆分，单列
    }>;
    mergedBatchIds: string[];
    sharedSourceBatchIds: string[];
  };
  provenance: Provenance[];
}
```

- 当前成员即使没有任何遥测也必须出现，`batchCount: 0`、指标 `null`、`coverage.reasons: ["no_observations"]`；不得显示为 0。
- `sourceAnalysis` 是触发来源分析，不是执行归属；两者不得相加，UI 不得把它作为成员消耗的另一份总和。
- 同一批次只归其执行成员一次；跨成员合并批次不重复计入每个来源成员。
- 成员 `totals` 只能按互不重叠的 `physicalSessions[].consumption` 汇总（或按去重后的回合视图，见实现口径），不得把 session 累计与 batch 度量相加；`physicalSessionCount` 与实际去重后的 session 数一致。

### 5.4 适配器能力声明

`GET /api/telemetry/capabilities?group=<groupId>`

只读返回该群涉及的宿主适配器对统一指标的能力声明，用于前端区分“宿主不支持”“支持但本次未报告”和“数据不完整”。不调用宿主、不触发采集。

```ts
interface CapabilityResponse {
  schemaVersion: 1;
  readOnly: true;
  groupId: string;
  generatedAt: string;
  hosts: Array<{
    host: string;
    metrics: Record<keyof Metrics | 'lastRequestInputTokens' | 'contextWindowTokens' | 'lastRequestInputRatio', {
      capability: 'direct' | 'derived' | 'unsupported';
      source: string;
      requires: string[];             // 所需事件/字段
      completenessConditions: string[];
      note: string | null;
    }>;
  }>;
}
```

- 能力声明必须覆盖全部 12 个统一字段；不支持的字段显式 `unsupported`，不能省略。
- 能力声明不等于每条记录都有值；单条可用性仍由 `Metric.value`、`completeness` 与 `missingReason` 表达。
- 宿主升级、模型路由或认证变化后应重新验证，不在本端点承诺永久能力。
- `unsupported` 指标在记录中的 `missingReason` 使用 `unsupported`。

## 6. 缺失、部分与完整性表达

- `complete`：该字段所需数据完整，或仅由完整数据派生；`quality` 为 `host_reported`/`derived`/`measured`。
- `partial`：部分子事件、部分尝试或部分采集可用；`value` 是已知部分（可能是下界），UI 必须显式标注“部分”，不得当精确值。
- `unknown`：无可靠值；`value: null`、`quality: "unknown"`、`completeness: "unknown"`，并给出 `missingReason`。有值的统一指标只使用 `host_reported`/`derived`/`measured`；`estimated` 当前不用于统一指标。
- `unsupported`：适配器能力声明不支持时，`value: null`、`quality: "unknown"`、`missingReason: "unsupported"`；前端显示“宿主不支持”，不得显示为未采集或 0。
- 查询层求和的完整性取最差贡献者；任何 `unknown` 贡献都可能使总和成为 `partial`（除非已证明该贡献为显式 0）。不能把未知当 0。
- 比例在分母缺失、为 0 或样本集合不一致时没有定义：`value: null`，不得输出 0。
- `Anomaly` 必须随批次输出；出现 `negative_value` 或 `total_mismatch` 时不能静默修正。异常字段不得进入看似正常的完整总量；至少标为 `partial`/`unknown` 并保留原值证据。
- 前端展示规则：`value: null` 显示“—/未采集”，并同时展示 `missingReason` 的可读标签；`partial` 显示“部分”；`quality` 用文字或小标记展示。不得把缺失渲染为 0，不得用估算值填充统一指标。

## 7. 只读展示消费点

| UI 区域 | 消费字段 | 约束 |
| --- | --- | --- |
| 会话双方可归属消耗 | `executors[].totals`、`executors[].physicalSessions[]`、`executors[].coverage` | 按执行方显示；双方不合并；按物理 session 展示累计与最近请求；缺失/部分按 §6 |
| 会话上下文参考 | `executors[].contextReference`、`physicalSessions[].contextReference` | 显示最近请求输入、窗口容量与占比；标注采样时点/模型；不求和、不预测下一请求 |
| 协调会话按输入批次 | `batches[]`、`inputBatch.kind`、`merge`、`messages`、`sourceActors` | 每个批次一条；合并投递显示整批一次；`sharedSources` 共同批次单列，不拆分、不重复 |
| 群成员概览 | `members[].totals`、`members[].contextReference` | 按执行成员汇总；来源分析视图分开，不与执行归属相加 |
| 完整性/来源 | `Metric.source`、`completeness`、`quality`、`missingReason`、`coverage`、`provenance` | 必须可回查；UI 只展示，不自行补值或重算 |
| 能力区分 | `/api/telemetry/capabilities` | `capability`、`requires`、`completenessConditions`；区分不支持与未观测 |
| 批次翻页 | `nextCursor` + `cursor` | 只翻 `batches[]`，合计与来源分析的覆盖范围不变 |
| 只读性 | 全局 `readOnly: true` | 不出现预算、费用、压缩、停止、阈值等控制或联动入口 |

## 8. 代表性示例

以下示例为契约形状，不是本轮真实采集结果。数值均使用整数 token 与毫秒。

### 8.1 完整批次（协调会话，合并投递）

```json
{
  "batchId": "batch:turn-42",
  "frameworkTurnId": "turn-42",
  "executor": { "kind": "member", "memberId": "ae02f43e-9c7f-4446-b1ed-b069cf43eea3", "name": "主 Agent", "host": "codex" },
  "physicalSession": {
    "instanceId": "ps_7f3a9c2e",
    "host": "codex",
    "endpointId": "ep_coordination_1",
    "memberId": "ae02f43e-9c7f-4446-b1ed-b069cf43eea3",
    "context": "coordination",
    "peer": null,
    "sessionKey": "communication",
    "hostSessionNamespace": "codex:default",
    "hostSessionId": "codex-thread-9d1",
    "firstObservedAt": "2026-10-23T07:00:00.000Z",
    "resetAt": null
  },
  "inputBatch": {
    "batchId": "batch:turn-42",
    "kind": "merged_delivery",
    "messages": [
      { "messageId": "msg-1001", "senderId": "17effb15-bfa3-41bc-adda-1a939bad2aeb", "senderName": "观测界面", "ordinal": 0, "role": "primary" },
      { "messageId": "msg-1002", "senderId": "673ab831-7a96-45d0-8227-6c4e8ac30c87", "senderName": "采集与统计", "ordinal": 1, "role": "additional" },
      { "messageId": "note-1003", "senderId": "ae02f43e-9c7f-4446-b1ed-b069cf43eea3", "senderName": "主 Agent", "ordinal": 2, "role": "note" }
    ],
    "sourceActors": [
      { "actorId": "17effb15-bfa3-41bc-adda-1a939bad2aeb", "actorName": "观测界面", "kind": "member", "messageIds": ["msg-1001"] },
      { "actorId": "673ab831-7a96-45d0-8227-6c4e8ac30c87", "actorName": "采集与统计", "kind": "member", "messageIds": ["msg-1002"] }
    ],
    "merge": {
      "merged": true,
      "sharedSources": true,
      "sourceCount": 2,
      "countedOnce": true,
      "splitBySource": false,
      "exclusiveSubtotal": false
    },
    "allocation": "whole_to_executor"
  },
  "state": "succeeded",
  "startedAt": "2026-10-23T07:00:01.000Z",
  "endedAt": "2026-10-23T07:00:03.000Z",
  "attempts": [
    {
      "attemptId": "attempt-42-1",
      "state": "succeeded",
      "hostTurnRef": "native-turn-42",
      "observedAt": "2026-10-23T07:00:03.000Z",
      "completeness": "complete",
      "metrics": null
    }
  ],
  "metrics": {
    "inputTokensTotal": { "value": 15165, "quality": "host_reported", "completeness": "complete", "scope": "turn", "aggregation": "delta", "source": "codex.thread_token_usage", "observedAt": "2026-10-23T07:00:03.000Z" },
    "uncachedInputTokens": { "value": 15165, "quality": "host_reported", "completeness": "complete", "scope": "turn", "aggregation": "delta", "source": "codex.thread_token_usage", "observedAt": "2026-10-23T07:00:03.000Z" },
    "cacheReadTokens": { "value": 0, "quality": "host_reported", "completeness": "complete", "scope": "turn", "aggregation": "delta", "source": "codex.thread_token_usage", "observedAt": "2026-10-23T07:00:03.000Z" },
    "cacheWriteTokens": { "value": 0, "quality": "host_reported", "completeness": "complete", "scope": "turn", "aggregation": "delta", "source": "codex.thread_token_usage", "observedAt": "2026-10-23T07:00:03.000Z" },
    "outputTokens": { "value": 8, "quality": "host_reported", "completeness": "complete", "scope": "turn", "aggregation": "delta", "source": "codex.thread_token_usage", "observedAt": "2026-10-23T07:00:03.000Z" },
    "totalTokens": { "value": 15173, "quality": "host_reported", "completeness": "complete", "scope": "turn", "aggregation": "delta", "source": "codex.thread_token_usage", "observedAt": "2026-10-23T07:00:03.000Z" },
    "cacheReadRatio": { "value": 0, "quality": "derived", "completeness": "complete", "scope": "turn", "aggregation": "ratio", "source": "query.aggregate", "observedAt": "2026-10-23T07:00:03.000Z", "formula": "cacheReadTokens / inputTokensTotal" },
    "executionWallMs": { "value": 5336, "quality": "measured", "completeness": "complete", "scope": "turn", "aggregation": "delta", "source": "framework.measured", "observedAt": "2026-10-23T07:00:03.000Z" },
    "hostTurnWallMs": { "value": 6010, "quality": "host_reported", "completeness": "complete", "scope": "turn", "aggregation": "delta", "source": "codex.turn_completed", "observedAt": "2026-10-23T07:00:03.000Z" }
  },
  "contextReference": {
    "lastRequestInputTokens": { "value": 15165, "quality": "host_reported", "completeness": "complete", "scope": "request", "aggregation": "snapshot", "source": "codex.token_usage_last", "observedAt": "2026-10-23T07:00:03.000Z" },
    "contextWindowTokens": { "value": 258400, "quality": "host_reported", "completeness": "complete", "scope": "request", "aggregation": "snapshot", "source": "codex.token_usage", "observedAt": "2026-10-23T07:00:03.000Z" },
    "lastRequestInputRatio": { "value": 0.058688, "quality": "derived", "completeness": "complete", "scope": "request", "aggregation": "ratio", "source": "query.aggregate", "observedAt": "2026-10-23T07:00:03.000Z", "formula": "lastRequestInputTokens / contextWindowTokens" },
    "sampledAt": "2026-10-23T07:00:03.000Z",
    "sampleTurnId": "turn-42",
    "model": { "provider": "example-provider", "model": "example-model", "source": "codex.model", "observedAt": "2026-10-23T07:00:01.000Z" }
  },
  "completeness": "complete",
  "anomalies": [],
  "provenance": [
    { "eventSeq": 501, "source": "codex.thread_token_usage", "observedAt": "2026-10-23T07:00:03.000Z", "scope": "turn", "aggregation": "delta", "nativeTurnId": "native-turn-42", "stepId": "step-1", "requestId": "req-1" },
    { "eventSeq": 502, "source": "framework.measured", "observedAt": "2026-10-23T07:00:03.000Z", "scope": "turn", "aggregation": "delta", "nativeTurnId": "native-turn-42", "stepId": null, "requestId": null }
  ]
}
```

### 8.2 缺失字段与部分用量

```json
{
  "batchId": "batch:turn-43",
  "frameworkTurnId": "turn-43",
  "executor": { "kind": "member", "memberId": "673ab831-7a96-45d0-8227-6c4e8ac30c87", "name": "采集与统计", "host": "claude" },
  "physicalSession": {
    "instanceId": "ps_21ab55d0",
    "host": "claude",
    "endpointId": "ep_pair_1",
    "memberId": "673ab831-7a96-45d0-8227-6c4e8ac30c87",
    "context": "pair",
    "peer": "17effb15-bfa3-41bc-adda-1a939bad2aeb",
    "sessionKey": "default",
    "hostSessionNamespace": "claude:default",
    "hostSessionId": null,
    "firstObservedAt": "2026-10-23T07:10:00.000Z",
    "resetAt": null
  },
  "inputBatch": {
    "batchId": "batch:turn-43",
    "kind": "single_source",
    "messages": [
      { "messageId": "msg-2001", "senderId": "17effb15-bfa3-41bc-adda-1a939bad2aeb", "senderName": "观测界面", "ordinal": 0, "role": "primary" }
    ],
    "sourceActors": [
      { "actorId": "17effb15-bfa3-41bc-adda-1a939bad2aeb", "actorName": "观测界面", "kind": "member", "messageIds": ["msg-2001"] }
    ],
    "merge": {
      "merged": false,
      "sharedSources": false,
      "sourceCount": 1,
      "countedOnce": true,
      "splitBySource": false,
      "exclusiveSubtotal": true
    },
    "allocation": "whole_to_executor"
  },
  "state": "failed",
  "startedAt": "2026-10-23T07:10:01.000Z",
  "endedAt": "2026-10-23T07:10:02.000Z",
  "attempts": [
    {
      "attemptId": "attempt-43-1",
      "state": "failed",
      "hostTurnRef": null,
      "observedAt": "2026-10-23T07:10:02.000Z",
      "completeness": "partial",
      "metrics": {
        "inputTokensTotal": { "value": 1641, "quality": "host_reported", "completeness": "partial", "scope": "request", "aggregation": "snapshot", "source": "claude.assistant_message_usage", "observedAt": "2026-10-23T07:10:01.500Z" },
        "uncachedInputTokens": { "value": 1641, "quality": "host_reported", "completeness": "partial", "scope": "request", "aggregation": "snapshot", "source": "claude.assistant_message_usage", "observedAt": "2026-10-23T07:10:01.500Z" },
        "cacheReadTokens": { "value": null, "quality": "unknown", "completeness": "unknown", "scope": "request", "aggregation": "unknown", "source": "claude.assistant_message_usage", "observedAt": null, "missingReason": "not_reported_by_host" },
        "cacheWriteTokens": { "value": null, "quality": "unknown", "completeness": "unknown", "scope": "request", "aggregation": "unknown", "source": "claude.assistant_message_usage", "observedAt": null, "missingReason": "not_reported_by_host" },
        "outputTokens": { "value": null, "quality": "unknown", "completeness": "unknown", "scope": "request", "aggregation": "unknown", "source": "claude.result_usage", "observedAt": null, "missingReason": "not_captured" },
        "totalTokens": { "value": null, "quality": "unknown", "completeness": "unknown", "scope": "request", "aggregation": "unknown", "source": "query.aggregate", "observedAt": null, "missingReason": "dependency_missing" },
        "cacheReadRatio": { "value": null, "quality": "unknown", "completeness": "unknown", "scope": "request", "aggregation": "unknown", "source": "query.aggregate", "observedAt": null, "missingReason": "dependency_missing" },
        "executionWallMs": { "value": 1000, "quality": "measured", "completeness": "complete", "scope": "request", "aggregation": "snapshot", "source": "framework.measured", "observedAt": "2026-10-23T07:10:02.000Z" },
        "hostTurnWallMs": { "value": null, "quality": "unknown", "completeness": "unknown", "scope": "request", "aggregation": "unknown", "source": "claude.result_usage", "observedAt": null, "missingReason": "not_reported_by_host" }
      }
    }
  ],
  "metrics": {
    "inputTokensTotal": { "value": 1641, "quality": "host_reported", "completeness": "partial", "scope": "turn", "aggregation": "delta", "source": "claude.assistant_message_usage", "observedAt": "2026-10-23T07:10:01.500Z" },
    "uncachedInputTokens": { "value": 1641, "quality": "host_reported", "completeness": "partial", "scope": "turn", "aggregation": "delta", "source": "claude.assistant_message_usage", "observedAt": "2026-10-23T07:10:01.500Z" },
    "cacheReadTokens": { "value": null, "quality": "unknown", "completeness": "unknown", "scope": "turn", "aggregation": "unknown", "source": "claude.assistant_message_usage", "observedAt": null, "missingReason": "not_reported_by_host" },
    "cacheWriteTokens": { "value": null, "quality": "unknown", "completeness": "unknown", "scope": "turn", "aggregation": "unknown", "source": "claude.assistant_message_usage", "observedAt": null, "missingReason": "not_reported_by_host" },
    "outputTokens": { "value": null, "quality": "unknown", "completeness": "unknown", "scope": "turn", "aggregation": "unknown", "source": "claude.result_usage", "observedAt": null, "missingReason": "not_captured" },
    "totalTokens": { "value": null, "quality": "unknown", "completeness": "unknown", "scope": "turn", "aggregation": "unknown", "source": "query.aggregate", "observedAt": null, "missingReason": "dependency_missing" },
    "cacheReadRatio": { "value": null, "quality": "unknown", "completeness": "unknown", "scope": "turn", "aggregation": "unknown", "source": "query.aggregate", "observedAt": null, "missingReason": "dependency_missing" },
    "executionWallMs": { "value": 1000, "quality": "measured", "completeness": "complete", "scope": "turn", "aggregation": "delta", "source": "framework.measured", "observedAt": "2026-10-23T07:10:02.000Z" },
    "hostTurnWallMs": { "value": null, "quality": "unknown", "completeness": "unknown", "scope": "turn", "aggregation": "unknown", "source": "claude.result_usage", "observedAt": null, "missingReason": "not_reported_by_host" }
  },
  "contextReference": {
    "lastRequestInputTokens": { "value": 1641, "quality": "host_reported", "completeness": "complete", "scope": "request", "aggregation": "snapshot", "source": "claude.assistant_message_usage", "observedAt": "2026-10-23T07:10:01.500Z" },
    "contextWindowTokens": { "value": null, "quality": "unknown", "completeness": "unknown", "scope": "request", "aggregation": "unknown", "source": "claude.model_usage", "observedAt": null, "missingReason": "not_reported_by_host" },
    "lastRequestInputRatio": { "value": null, "quality": "unknown", "completeness": "unknown", "scope": "request", "aggregation": "unknown", "source": "query.aggregate", "observedAt": null, "missingReason": "dependency_missing" },
    "sampledAt": "2026-10-23T07:10:01.500Z",
    "sampleTurnId": "turn-43",
    "model": { "provider": "claude", "model": "deepseek-v4-flash", "source": "claude.assistant_message", "observedAt": "2026-10-23T07:10:01.500Z" }
  },
  "completeness": "partial",
  "anomalies": [
    { "code": "total_mismatch", "fields": ["totalTokens"], "detail": "结果输出未结算，无法与输入核对；保留已报告输入，不补零", "observedAt": "2026-10-23T07:10:02.000Z", "raw": { "inputTokensTotal": 1641, "outputTokens": null } }
  ],
  "provenance": [
    { "eventSeq": 601, "source": "claude.assistant_message_usage", "observedAt": "2026-10-23T07:10:01.500Z", "scope": "request", "aggregation": "snapshot", "nativeTurnId": null, "stepId": null, "requestId": null }
  ]
}
```

注意：上例的 `cacheReadTokens: 0` 没有出现；若宿主明确报告 0，则必须是 `value: 0`、`quality: "host_reported"`、`completeness: "complete"`，与 `null` 严格区分。

8.2 中 `attempts[0].metrics` 是该失败尝试的独立部分视图，`batch.metrics` 是批次视图；两者是同一消耗的不同视图，不得相加。仅当宿主没有提供独立尝试级视图时，`attempts[].metrics` 才为 `null`，此时已知部分只保留在 `batch.metrics`，且 `attempts[].completeness` 仍为 `partial`/`unknown`；前端在任何情况下都不得把 `null` 推断为 0。

## 9. 前端与后端共同验收点

1. 前后端均使用 `inputTokensTotal`，搜索代码不得出现遥测响应中的 `inputTokens` 别名。
2. 每个指标对象始终包含 `value`、`quality`、`completeness`、`scope`、`aggregation`、`source`、`observedAt`；缺失必为 `value: null` 且有 `missingReason`。
3. 会话双方分别展示执行归属总量与各自 `contextReference`，不合并、不推断对方；物理 session 累计单独展示且不与批次度量相加。
4. 协调会话每个 `Batch` 只出现一次；`merged_delivery` 显示整批与全部来源，`sharedSources` 共同批次出现在 `sharedSourceBatchIds` 且 `exclusiveSubtotal` 为 `false`，来源小计不拆分且将其列入 `excludedMergedBatchIds`。
5. 成员概览按 `executor` 汇总，与 `sourceAnalysis` 分开；无遥测成员显示未采集而非 0。
6. `coverage`、`provenance`、`Metric.source`、`quality` 可用于回查；UI 不自行补值、重算或改变归属。
7. 前后端只读：不出现预算/费用/压缩/停止/阈值等按钮或联动，也不发写请求。
8. 批次列表翻页不改变 `totals`/`summary`/`coverage` 的统计范围；`nextCursor` 为末页时为 `null`。

## 10. 版本与变更

- `schemaVersion: 1` 下，字段改名、语义变化、必填字段删除或新增业务联动都视为破坏性变更，必须建立新契约版本并重新验证实现与界面。
- 新增可选字段或新的 `source` 字符串不是破坏性变更；UI 必须能原样显示未知 `source`。
- 契约或实现变化时同时更新版本指纹；审查和发布以同一版本指纹为准。

## 11. 证据与相关文档

- [宿主用量与会话统计设计](host-telemetry-design.md)
- [CLI 宿主适配器接口](adapters.md)
- `work/host-metrics-probe/REPORT.md`
- `work/host-metrics-probe/EXTENDED-REPORT.md`
- `work/host-metrics-probe/codex-extended.json`
- `work/host-metrics-probe/claude-extended.json`
- `work/host-metrics-probe/dsh-extended.json`
- `work/host-metrics-probe/dsh-final.json`
