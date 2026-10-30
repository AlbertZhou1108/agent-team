# 查询重构实施与验证记录

日期：2026-10-30。

## 已实施

- 增加 groups、directory、group、group-runtime、home-summary、sessions、session、session-target、agent-tasks、model-policy/defaults、panel-agent/unread 接口。
- 会话列表不推导 modelState；所选会话通过独立、按团队校验的查询支撑消息标题、过滤和路由恢复。模型详情沿用 models 分页。
- 前端不再订阅 overview/snapshot，删除未使用的对应查询 hook；旧 HTTP 接口和 bus.snapshot 保留兼容。
- tasks/sessions 按上下文可见性启用；运行成员和首页统计不依赖列表加载；完整 Panel 状态仅在 Panel 路由观察，其他路由使用未读投影。
- 未读投影保留最近200条 private 消息窗口及回执来源语义，不返回正文。新增字段最小结构类型，沿用原 localStorage 已读状态。
- 集中新增 queryKeys 和跨资源失效入口；写入团队指令、互动回答、成员模型、归档恢复及控制权操作同步刷新相关资源。
- 局部上下文查询失败提供重试；只有对应会话404才清理 session 路由参数。

## 实际验证

- `npm run typecheck` 通过。
- `npm run test:core`：159项通过。
- `npm run test:web`：98项通过。
- `npm run build` 通过；仍有大于500KB的产物提示，本次未调整代码分包。
- 新增契约测试验证团队隔离、私密字段排除、列表不执行模型历史推导、未读消息窗口与完整状态一致、回执投影一致；新增查询测试验证隐藏门控和团队key隔离。
- 在侧栏浏览器、隔离数据目录 `work/query-qa`、端口62049验证：首页、长团队名、团队消息、会话列表、所选会话详情、收起右栏后保留session与消息过滤、设置、浅色/系统深色、Panel创建空状态、模型空观测、Tab键焦点及390×844基础窄屏布局。已恢复默认视口和原主题。

## 性能样本与验证限制

隔离数据含1团队、2成员、1消息，单次HTTP采样：旧overview 7428 B，旧scoped snapshot 8646 B，新groups 327 B、directory 628 B、group 652 B、runtime 2 B、sessions 885 B。不同资源周期不同，不将这些样本直接换算成固定节省百分比；未进行60秒网络采样或真实持续输出压力测试。

本次浏览器未验证真实宿主的持续输出、长历史模型分页、浏览器后台轮询、断线重连、真实Panel会话中的交互式回执及接管写操作；其中部分业务语义由既有及新增自动测试覆盖。不得将这些测试描述为完整的生产场景视觉验收。

## 兼容与后续边界

旧overview/snapshot契约保持，不删除可能仍被直接调用或测试依赖的字段。新增home-summary返回运行端点最小归属投影，前端计算按团队数量，避免首页加载全会话。单会话投影直接按group/id查询；互动目标解析复用团队会话投影。模型默认规则长缓存并在设置页启用。跨资源复杂写入采用保守失效，后续可在具备精确影响集合时缩小范围。
