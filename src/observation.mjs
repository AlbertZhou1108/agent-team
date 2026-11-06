// 观测载荷构造:纯数据整形,宿主适配器与遥测写入共用,不依赖任何遥测存储/查询实现。
export function telemetryObservation({ source, scope = 'turn', aggregation = 'delta', observedAt = new Date().toISOString(), usage = {}, context = {}, timing = {}, quality = {}, completeness = {}, formula = {}, formulas = {}, missingReason = {}, contextSource = {}, anomalies = [], attempt = null, nativeTurnId = null, stepId = null, requestId = null }) {
  return {
    source,
    scope,
    aggregation,
    observedAt,
    usage,
    context,
    timing,
    quality,
    completeness,
    formula,
    formulas,
    missingReason,
    contextSource,
    anomalies,
    attempt,
    nativeTurnId,
    stepId,
    requestId,
  };
}
