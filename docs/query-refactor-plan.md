# 前端查询重构计划（终稿）

核对日期：2026-10-30。本文依据仓库源码核对，未进行运行时性能复测。配套接口和缓存设计见 [query-refactor-design.md](./query-refactor-design.md)。本次交付只修改文档，不实施查询重构。

## 1. 目标与边界

按数据归属、消费者和更新频率拆分查询，降低无效计算、传输和后台面板轮询；保持消息、未读、隐私和路由恢复语义。保留现有 SSE、数据库结构及消息增量协议。允许列表与详情重复少量摘要字段；禁止的是重复加载昂贵聚合，而非要求任何字段只能出现一次。

## 2. 当前实现核对

| 结论 | 源码依据与修正 |
|---|---|
| overview 与 snapshot 重复 | `src/bus.mjs` 的 snapshot 展开 overview，后者包含 groups、members、panelAgent、panelTeams、actors、modelPolicy、modelPolicyDefaults、groupStates。两者还会调用 ensurePanelBindings，不能视为纯廉价读取 |
| 查询默认两秒轮询 | `web/src/features/queries.ts`。snapshot 没有 enabled，在无 groupId 的首页、Panel 和设置路由也可能被观察；API 客户端的 scoped 参数必须保留核对 |
| Panel 有两份缓存 | key 为 `['panel-agent', full]`；false 请求 summary，并非两份完整响应。summary 消息仅选 seq/id/role/created/active_team_id，其余聚合仍存在 |
| 协作请求已有门控 | CollaborationPanel 只在 contextVisible 且选中 collaboration 时挂载，其内部 collaboration/charter 查询随组件卸载停止被观察；agentTasks 却仍来自父级 snapshot |
| 会话元数据不只服务右栏 | 主消息标题、selectedPair、互动跳转、运行成员、所选会话有效性及轨迹状态也依赖 endpoints/runningEndpoints。不能把全部会话数据仅绑定右栏可见性 |
| 模型已有独立接口 | `/api/models?endpoint=…&after=…` 与 useModelsQuery 已支持观测分页；snapshot 仍计算每个 endpoint 的 modelState，页面 selectedModelState 优先取这一摘要 |
| 消息已经增量轮询 | useMessagesQuery 平时带 after，每批最多 200 条并循环排空；首次恢复缓存缝隙最多额外回补 40 页。并非每轮固定拉取完整消息，也非每次最多 40 请求 |
| 回执不能仅返回 ID | panel-agent store 的 syncReceiptReads 需要 isSourceCopy/sourceMessageIds，才能在团队消息已展示时自动标记来源副本已读；unreadReceipts 遍历全部回执，并不限所谓 pending 回执 |
| 持久化包含两类缓存 | tab-cache.ts 保存 messages 与 message-history，不是仅 messages；两个 key 和缝隙修复语义均须兼容 |
| 删除旧字段存在兼容风险 | 前端未读取不等于所有调用方未读取；测试直接使用 bus.snapshot。没有证据表明 CLI 必须依赖 HTTP snapshot，不能以此指定删除周期 |

主要核对文件：`web/src/pages/GroupWorkspacePage.vue`、`web/src/features/queries.ts`、`web/src/features/groups/CollaborationPanel.vue`、`web/src/features/groups/TeamHome.vue`、`web/src/stores/panel-agent.ts`、`web/src/shared/api/tab-cache.ts`、`src/server.mjs`、`src/bus.mjs`、`src/team-requests.mjs`。

原稿中的响应字节数、22 ms 和每小时流量没有附采样数据或复现条件，不能标作本次实测。原表所列字节合计实际为 66,601 B；即便将它们视为同轮采样，也不能推出稳定消息增量流量。不同周期的新接口应按 `Σ(响应字节 × 每小时调用次数)` 计算，不能统一除以两秒。撤销“必然降低 65%”的承诺。

## 3. 设计决策

1. 全局拆为团队导航、成员/身份目录、模型配置；首页运行摘要单独取数。不能只用 groups 和单团队接口替代整个 overview。
2. 团队基础信息和运行状态分开。运行状态提供运行 endpoint/member 标识，而非仅 runningCount，避免关闭右栏后徽章与轨迹失真。
3. 会话列表与绑定按需；选中会话的最小元数据独立查询，在右栏关闭时仍供主消息区使用。互动跳转所需目标由独立解析请求取得，不强制加载所有会话。
4. 复用 models 接口，移除新会话列表中的模型推导；详情以 models 返回值为准。全局成员和历史身份目录保留已移除参与者的显示能力。
5. 未读接口返回精简消息行与回执投影，保留客户端初始化、来源副本去重、历史模式和可见性规则。维持现有最近 200 条消息窗口，本次不顺带改变窗口外未读语义。
6. SSE 继续负责实时流。查询缓存可保存持久化消息和汇总状态；不把“不入缓存”作为实时数据的普遍规则。轮询负责现有状态补偿。

## 4. 迁移顺序与退出条件

| 阶段 | 内容 | 退出条件 |
|---|---|---|
| 1 基线及契约 | 固定测试数据；列出字段消费者、路由、写操作刷新点；新增投影测试 | 区分冷启动、静置、持续输出、缓存恢复和面板切换数据 |
| 2 低风险拆分 | 新增未读、tasks、无模型推导的 sessions；旧接口结构保持 | 团队页不再观察 Panel summary；未读语义逐项一致；tasks 随协作面板启停 |
| 3 基础数据替代 | 新增全局目录/配置、团队详情/运行状态、首页摘要、所选会话元数据；逐项替换 overview/snapshot 消费 | 首页、设置、模型编辑、互动跳转、消息过滤、运行徽章、断线判定和深链恢复均有数据来源；浏览器不再请求旧聚合 |
| 4 模型与刷新收口 | 模型详情完全使用既有 models；集中 key 与失效映射，移除摘要优先级 | 模型变化可见、分页有效、切换团队无串数据；全部写操作更新关联缓存 |
| 5 兼容清理及评估 | 查明直接和 HTTP 消费者；更新测试后另行决定旧接口弃用 | 兼容清单清零才删除字段/接口；记录同数据集前后性能 |

不得在头部和全局依赖尚未替代时先移除 snapshot 的 overview 展开；不得把删除字段标为“无风险”。迁移期间旧契约保持，新增接口独立提供，可按消费者回退。

## 5. 验收

实现阶段运行 `npm run typecheck`、`npm run test:core`、`npm run test:web`、`npm run build`。新增测试覆盖投影隐私、团队边界、运行状态、未读初始化及来源副本、失效映射、快速切换与取消请求、缓存回补。

浏览器分别验证：首页/团队/Panel/设置，所选会话深链、归档/恢复、模型编辑、互动响应、断线恢复；面板关闭、切换、窄屏隐藏和标签后台期间请求行为。禁用查询不保证已经发出的请求自动取消，需传递 AbortSignal 并检查晚到响应不会污染其他 key。

页面验收包含主要操作、状态恢复、长内容、键盘、窄屏及浅深主题。侧栏要求数据稳定时不清空、不闪烁、不丢焦点；不能要求 DOM 绝对零变更（未读和运行状态正常变化应更新）。性能同时记录请求数、响应体、处理耗时及模型推导次数，至少采样 60 秒并分别报告冷启动和稳态。
