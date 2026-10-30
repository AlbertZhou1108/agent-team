# 查询层设计方案

依据 [重构计划终稿](./query-refactor-plan.md)。以下均为拟新增设计，既有接口明确标注；采用当前 `/api/资源?group=` 风格，避免把尚未存在的路径描述为已有接口。

## 1. 资源、缓存和调度

| 资源与接口 | Query key | 消费者与调度 |
|---|---|---|
| 新增 `/api/groups`：团队导航摘要 | `['groups']` | 应用导航，10s；含 id/name/workspace/state/created/lead 等实际导航所需字段 |
| 新增 `/api/directory`：members、actors、panelAgent 安全摘要 | `['directory']` | 首页或团队需要时启用，10s；保留历史身份显示信息，不返回凭证 |
| 既有 `/api/model-policy` 加新增 `/api/model-policy/defaults` | `['model-policy']`、`['model-policy-defaults']` | 策略消费者/模型对话框挂载时启用；策略10s，默认规则长缓存，构建版本变化重取 |
| 新增 `/api/group?group=id`：meta、controller、成员归属 | `['group', id, 'detail']` | 团队页，3s；成员实体复用目录，控制信息保留 assignment/original_lead_id |
| 新增 `/api/group-runtime?group=id` | `['group', id, 'runtime']` | 团队主体，2s；runningEndpointIds/runningMemberIds，不查模型历史 |
| 新增 `/api/home-summary` | `['home-summary']` | 仅首页，2s；总运行数、按团队运行数及首页实际使用的其他摘要 |
| 新增 `/api/sessions?group=id` | `['group', id, 'sessions']` | 会话列表可见，2s；endpoints + bindings，不含 modelState |
| 新增 `/api/session?group=id&endpoint=ep` | `['group', id, 'session', ep]` | 存在所选会话时启用，3s；返回标题、消息过滤、peer/context/session 等必要元数据 |
| 新增 `/api/session-target?group=id&member=member&context=context` | `['group', id, 'session-target', member, context]` | 点击互动跳转时按需解析目标；校验归属 |
| 新增 `/api/agent-tasks?group=id` | `['group', id, 'tasks']` | contextVisible 且 collaboration，2s |
| 既有 collaboration/charter | 暂保留既有 key | 保持条件挂载；collaboration 2s，charter 写后失效 |
| 既有 `/api/models?endpoint=ep&after=seq` | 保留 `['models', ep]` | detailsVisible 且 models，2s，沿用无限分页 |
| 既有 history/messages/interactions/team-directives | 保留既有 key 和协议 | 主体保持原门控；history 仅详情对应标签；messages 保留 after 与缓存恢复 |
| 新增 `/api/panel-agent/unread` | `['panel-agent', 'unread']` | 非 Panel 路由有徽章消费者时2s；Panel 页由完整状态投影，避免重复轮询 |
| 既有 `/api/panel-agent` 完整状态 | `['panel-agent', 'state']` | 仅 Panel 路由2s |

周期是初始配置，不是性能结论。导航10s允许外部修改最多约10s后可见；本地写入主动失效。保持默认后台不轮询，不把窗口 blur 与标签后台混为一谈。设置合理 staleTime/gcTime 并按预算评估，禁止长期保存无限数量的非消息缓存。

## 2. 未读投影契约

```ts
type UnreadProjection = {
  messages: Array<{ seq: number; role: string; active_team_id: string | null }>;
  receipts: Array<{ id: string; isSourceCopy: boolean; sourceMessageIds: string[] }>;
};
```

messages 使用与 panelAgentState 相同的 private 消息窗口及排序；receipts 与当前 requests 展开的回执集合一致，不按 pending 状态过滤。无 Panel Agent 时返回两个空数组。服务端直接查询必要字段，不能先构造完整 Panel 状态再裁剪，否则只节省传输。

将 store 的未读方法参数改为最小结构类型，共享完整状态到投影的纯函数。两个路由喂入同一套 syncReadContexts/syncReceiptReads 逻辑；保留首次初始化、全局可见、historyVisible、displayed source IDs 与持久化版本兼容。完整状态加载失败不能用空数组假装成功清除徽章；保留最后成功数据并显示既有错误反馈。

## 3. 查询组合与服务端实现

页面拆为导航、团队主体、首页、上下文面板和 Panel 各自观察需要的查询。统一 queryKeys 工厂与 enabled 计算，queryFn 从 queryKey 获取参数并向 fetch 传递 signal。相同 key 不混用不同响应结构。

会话列表关闭后，selected session 查询继续支撑主消息区；列表未加载不能据空列表删除路由 session 参数，只有对应单会话请求明确404才触发现有无效选择处理。团队详情404与网络错误分开处理，非关键面板失败不应把整个应用判定离线。切换团队不沿用前一个团队的详情占位，仅允许同 ID 的导航摘要作为标题占位。

服务端新增专用 bus/store 投影方法。SQL 按 group_id 过滤后读取，bindings 通过所属 endpoint 关联筛选，避免先扫全表再 JS filter。覆盖普通 endpoints 和 panel coordination sessions，排除 private/panel-private，复用现有请求来源检查。运行状态按团队筛选内存进程；首页才聚合全局。接口响应不得包含 endpoint key、私聊历史或认证信息。

先保留 ensurePanelBindings 的业务效果；若后续从读路径移走，需要单独证明初始化、接管和恢复路径完整，不能作为查询拆分的附带修改。

## 4. 写入和实时补偿

集中实现领域级 invalidate helpers，并用当前实际 ID 定位 key，避免全局 `['messages']` 广播刷新。

| 写操作 | 必须失效的资源 |
|---|---|
| 创建/归档/恢复/改名/改 workspace | groups、对应 detail；首页摘要；影响运行时同步 runtime |
| 增删成员 | directory、detail、sessions、相关 session、runtime、home-summary |
| 成员模型/策略修改 | directory、model-policy、相关 models；按响应影响更新 detail |
| 接管/交还 | groups、detail、directory、sessions、session、runtime、home-summary |
| 发消息/启动/停止 | 当前 messages、runtime、home-summary；创建会话时 sessions；Panel 发消息刷新 state/unread |
| 回答互动 | 当前 interactions/messages；引起运行变化时 runtime/home-summary |
| charter/协作操作 | charter、collaboration、tasks；涉及成员/控制权时调用对应领域 helper |
| 发布/处理请求回执 | state/unread；相关团队消息和协作资源 |

保留现有 SSE 流消费。完成、取消、错误与重连可合并触发相关运行/消息刷新；不要每个 delta 都失效所有查询。写后失效禁用查询只标记过期，重新打开时取新数据；SSE 与 mutation 采用同一领域 helper。

## 5. 实施验证与交付界限

契约测试验证投影字段、归属、隐私和错误码；查询测试验证门控、key 隔离、写后失效、取消与缓存恢复；浏览器按终稿的场景矩阵实测。models 页另验证分页后状态不会被旧 snapshot 摘要覆盖。

本次为源码核对及文档设计交付，未改运行代码、未运行构建/测试或浏览器验证，未复测流量与耗时。实现前的基线采样与上述验收仍须执行。
