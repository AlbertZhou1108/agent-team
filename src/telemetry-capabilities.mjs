import { createHash, randomUUID } from 'node:crypto';

export const METRIC_KEYS = [
  'inputTokensTotal',
  'uncachedInputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'outputTokens',
  'totalTokens',
  'cacheReadRatio',
  'executionWallMs',
  'hostTurnWallMs',
];

export const CONTEXT_KEYS = ['lastRequestInputTokens', 'contextWindowTokens', 'lastRequestInputRatio'];
export const UNIFIED_FIELDS = [...METRIC_KEYS, ...CONTEXT_KEYS];

const tokenKeys = ['inputTokensTotal', 'uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'totalTokens'];

function capability(capability, source, requires, completenessConditions, note = null) {
  return { capability, source, requires, completenessConditions, note };
}

function capabilities(host, entries) {
  const result = {};
  for (const field of UNIFIED_FIELDS) result[field] = entries[field] ?? capability('unsupported', 'adapter.capability', [], [], '适配器未声明支持该字段');
  return { version: 1, host, metrics: result };
}

const tokenConditions = ['宿主报告完整的输入与缓存桶时参与归一化', '重复快照按宿主原生回合身份去重', '缺失桶保持 null，不按 0 计算'];
const executionConditions = ['从适配器 run 调用到 settle 的单调时钟测量', '不含调用前队列等待'];

export function telemetryCapabilitiesFor(host) {
  if (host === 'codex') {
    return capabilities('codex', {
      inputTokensTotal: capability('direct', 'codex.thread_token_usage', ['thread/tokenUsage/updated.total.inputTokens'], tokenConditions),
      uncachedInputTokens: capability('derived', 'codex.thread_token_usage', ['total.inputTokens', 'total.cachedInputTokens', 'total.cacheWriteInputTokens'], tokenConditions),
      cacheReadTokens: capability('direct', 'codex.thread_token_usage', ['total.cachedInputTokens'], tokenConditions),
      cacheWriteTokens: capability('direct', 'codex.thread_token_usage', ['total.cacheWriteInputTokens'], tokenConditions),
      outputTokens: capability('direct', 'codex.thread_token_usage', ['total.outputTokens'], tokenConditions),
      totalTokens: capability('direct', 'codex.thread_token_usage', ['total.totalTokens'], tokenConditions),
      cacheReadRatio: capability('derived', 'query.aggregate', ['cacheReadTokens', 'inputTokensTotal'], ['同一完整样本集合', '输入为 0 时不生成比例']),
      executionWallMs: capability('derived', 'framework.measured', ['run start/settle'], executionConditions),
      hostTurnWallMs: capability('direct', 'codex.turn_completed', ['turn/completed.durationMs'], ['宿主成功报告回合结束耗时']),
      lastRequestInputTokens: capability('direct', 'codex.token_usage_last', ['tokenUsage.last.inputTokens'], ['按原生回合身份关联', '恢复会话的旧回合通知不得覆盖当前回合']),
      contextWindowTokens: capability('direct', 'codex.token_usage', ['tokenUsage.modelContextWindow'], ['与最近请求采样来自同一模型路由']),
      lastRequestInputRatio: capability('derived', 'query.aggregate', ['lastRequestInputTokens', 'contextWindowTokens'], ['模型路由匹配且窗口大于 0']),
    });
  }
  if (host === 'claude') {
    const claudeInputs = ['result.usage.input_tokens', 'result.usage.cache_read_input_tokens', 'result.usage.cache_creation_input_tokens'];
    return capabilities('claude', {
      inputTokensTotal: capability('derived', 'claude.result_usage', claudeInputs, [...tokenConditions, 'inputTokensTotal = input_tokens + cache_read_input_tokens + cache_creation_input_tokens', 'assistant 重复事件不逐条累加']),
      uncachedInputTokens: capability('direct', 'claude.result_usage', ['result.usage.input_tokens'], [...tokenConditions, 'assistant 重复事件不逐条累加']),
      cacheReadTokens: capability('direct', 'claude.result_usage', ['result.usage.cache_read_input_tokens'], tokenConditions),
      cacheWriteTokens: capability('direct', 'claude.result_usage', ['result.usage.cache_creation_input_tokens'], tokenConditions),
      outputTokens: capability('direct', 'claude.result_usage', ['result.usage.output_tokens'], ['以 result 最终输出为准，不用 assistant 尚未结算的输出代替']),
      totalTokens: capability('derived', 'claude.result_usage', ['完整输入', 'result 最终输出'], ['输入与输出同一运行范围']),
      cacheReadRatio: capability('derived', 'query.aggregate', ['cacheReadTokens', 'inputTokensTotal'], ['同一完整样本集合', '输入为 0 时不生成比例']),
      executionWallMs: capability('derived', 'framework.measured', ['run start/settle'], executionConditions),
      hostTurnWallMs: capability('direct', 'claude.result_usage', ['result.duration_ms'], ['宿主成功报告运行汇总']),
      lastRequestInputTokens: capability('derived', 'claude.assistant_message_usage', ['assistant.message.usage 输入三桶'], ['lastRequestInputTokens = input_tokens + cache_read_input_tokens + cache_creation_input_tokens', '按宿主消息身份去重并更新最终值']),
      contextWindowTokens: capability('direct', 'claude.model_usage', ['result.modelUsage[model].contextWindow'], ['模型键与最近请求模型匹配']),
      lastRequestInputRatio: capability('derived', 'query.aggregate', ['lastRequestInputTokens', 'contextWindowTokens'], ['模型路由匹配且窗口大于 0']),
    });
  }
  if (host === 'dsh') {
    const dshTokens = ['assistant/message.usage.inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens'];
    return capabilities('dsh', {
      inputTokensTotal: capability('derived', 'dsh.assistant_message_usage', dshTokens, [...tokenConditions, 'inputTokensTotal = usage.inputTokens + cacheReadTokens + cacheWriteTokens', '不与 session tokenUsage 投影相加']),
      uncachedInputTokens: capability('direct', 'dsh.assistant_message_usage', ['usage.inputTokens'], tokenConditions),
      cacheReadTokens: capability('direct', 'dsh.assistant_message_usage', ['usage.cacheReadTokens'], tokenConditions),
      cacheWriteTokens: capability('direct', 'dsh.assistant_message_usage', ['usage.cacheWriteTokens'], tokenConditions),
      outputTokens: capability('direct', 'dsh.assistant_message_usage', ['usage.outputTokens'], tokenConditions),
      totalTokens: capability('direct', 'dsh.assistant_message_usage', ['usage.totalTokens'], ['优先核对宿主 total', '不与 session 投影相加']),
      cacheReadRatio: capability('derived', 'query.aggregate', ['cacheReadTokens', 'inputTokensTotal'], ['同一完整样本集合', '输入为 0 时不生成比例']),
      executionWallMs: capability('derived', 'framework.measured', ['run start/settle'], executionConditions),
      hostTurnWallMs: capability('direct', 'dsh.turn_time', ['turn/end.time - turn/start.time'], ['插件提供原生回合起止时间']),
      lastRequestInputTokens: capability('direct', 'dsh.context_pressure', ['contextPressure.pressureTokens'], ['最近请求采样，不与 projectedTokens 混淆']),
      contextWindowTokens: capability('direct', 'dsh.context_pressure', ['contextPressure.contextWindow'], ['与压力采样同一模型路由']),
      lastRequestInputRatio: capability('derived', 'query.aggregate', ['lastRequestInputTokens', 'contextWindowTokens'], ['模型路由匹配且窗口大于 0']),
    });
  }
  return capabilities(host, {});
}
