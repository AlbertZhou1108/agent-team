# ADR 0003：SSE 统一流层与 panel 单连接

- 状态：已采纳（2026-11-06，提交 15fa879）
- 背景：团队页、私人助手、工作台各写一份 SSE 状态机；`/api/panel-agent/events` 被两处重复连接。
- 决策：`features/streams/use-event-stream.ts` 成为唯一 EventSource 构造点；panel 流走模块级单例（retain/subscribe），团队流保留独立 URL；reducer 统一到 `panel-reducer.ts`。
- 后果：新增流式事件只改 reducer 一处；`new EventSource` 全仓仅 1 处；新增消费者必须走流层。
