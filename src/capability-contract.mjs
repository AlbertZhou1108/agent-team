// 遥测能力契约:指标键、能力声明构造与通用完备性条件。
// 宿主适配器与遥测实现都只依赖本模块;具体宿主声明在各自适配器里,查表兼容层在 telemetry-capabilities.mjs。
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

export function capability(capability, source, requires, completenessConditions, note = null) {
  return { capability, source, requires, completenessConditions, note };
}

export function capabilities(host, entries) {
  const result = {};
  for (const field of UNIFIED_FIELDS) result[field] = entries[field] ?? capability('unsupported', 'adapter.capability', [], [], '适配器未声明支持该字段');
  return { version: 1, host, metrics: result };
}

export const tokenConditions = ['宿主报告完整的输入与缓存桶时参与归一化', '重复快照按宿主原生回合身份去重', '缺失桶保持 null，不按 0 计算'];
export const executionConditions = ['从适配器 run 调用到 settle 的单调时钟测量', '不含调用前队列等待'];
