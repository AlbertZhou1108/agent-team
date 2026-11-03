// 身份层的只读投影。
//
// 身份表保持两套（members / panel_agents），执行层只依赖这里的公共字段:
// 传入一个成员或 Panel Agent 行，得到宿主调用需要的模型选择形状。

export function modelSelectionOf(actor) {
  return {
    model_provider: actor.model_provider ?? null,
    model: actor.model ?? null,
    reasoning_effort: actor.reasoning_effort ?? null,
  };
}
