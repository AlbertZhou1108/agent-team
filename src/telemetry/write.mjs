// 遥测写入:观测归一化、指标构造、记录与物理会话轮转。公共门面见 ../telemetry.mjs。
import { createHash, randomUUID } from 'node:crypto';
import { METRIC_KEYS } from '../capability-contract.mjs';

export class TelemetryQueryError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'TelemetryQueryError';
    this.status = status;
  }
}

export function metric(value, { quality, completeness, scope, aggregation, source, observedAt, formula, missingReason = null }) {
  return {
    value,
    quality,
    completeness,
    scope,
    aggregation,
    source,
    observedAt,
    ...(formula ? { formula } : {}),
    ...(value === null && missingReason ? { missingReason } : {}),
  };
}

export function missingMetric(field, capabilityEntry, scope = 'unknown', reason = null) {
  const unsupported = capabilityEntry?.capability === 'unsupported';
  return metric(null, {
    quality: 'unknown',
    completeness: 'unknown',
    scope,
    aggregation: 'unknown',
    source: capabilityEntry?.source ?? 'unknown',
    observedAt: null,
    missingReason: reason ?? (unsupported ? 'unsupported' : 'not_captured'),
  });
}

export function worstCompleteness(values) {
  if (values.includes('unknown')) return 'unknown';
  if (values.includes('partial')) return 'partial';
  return 'complete';
}

export function batchCompleteness(values) {
  if (!values.length) return 'unknown';
  if (values.every(value => value === 'unknown')) return 'unknown';
  if (values.includes('partial') || values.includes('unknown')) return 'partial';
  return 'complete';
}

export function aggregateCompleteness(values) {
  if (!values.length) return 'unknown';
  if (values.every(value => value === 'unknown')) return 'unknown';
  if (values.includes('partial') || values.includes('unknown')) return 'partial';
  return 'complete';
}

export function maxObservedAt(values) {
  return values.filter(Boolean).sort().at(-1) ?? null;
}

export function sumMetricList(field, metrics, { fallbackScope = 'query' } = {}) {
  const usable = metrics.filter(item => item && item.value !== null && Number.isFinite(item.value));
  if (!usable.length) return null;
  const value = usable.reduce((total, item) => total + item.value, 0);
  return metric(value, {
    quality: 'derived',
    completeness: aggregateCompleteness(metrics.filter(Boolean).map(item => item.completeness)),
    scope: usable.length === 1 ? usable[0].scope : fallbackScope,
    aggregation: usable.length === 1 ? usable[0].aggregation : 'sum',
    source: usable.length === 1 ? usable[0].source : 'query.aggregate',
    observedAt: maxObservedAt(usable.map(item => item.observedAt)),
    formula: `sum(${field})`,
  });
}

function hasNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizePayload(observation) {
  const observedAt = observation.observedAt ?? new Date().toISOString();
  const metrics = {};
  for (const field of METRIC_KEYS) {
    const provided = observation.usage?.[field] !== undefined ? observation.usage[field]
      : observation.timing?.[field] !== undefined ? observation.timing[field] : undefined;
    if (provided === undefined) continue;
    if (!hasNumber(provided)) {
      metrics[field] = metric(null, {
        quality: 'unknown',
        completeness: observation.completeness?.[field] ?? 'unknown',
        scope: observation.scope,
        aggregation: observation.aggregation,
        source: observation.source,
        observedAt: null,
        missingReason: observation.missingReason?.[field] ?? 'not_reported_by_host',
      });
      continue;
    }
    const quality = observation.quality?.[field]
      ?? (field.endsWith('WallMs') && field === 'executionWallMs' ? 'measured' : 'host_reported');
    metrics[field] = metric(provided, {
      quality,
      completeness: observation.completeness?.[field] ?? 'complete',
      scope: observation.scope,
      aggregation: observation.aggregation,
      source: observation.source,
      observedAt,
      formula: observation.formula?.[field] ?? observation.formulas?.[field],
    });
  }
  const context = {};
  for (const field of ['lastRequestInputTokens', 'contextWindowTokens']) {
    if (!hasNumber(observation.context?.[field])) continue;
    context[field] = metric(observation.context[field], {
      quality: observation.quality?.[field] ?? 'host_reported',
      completeness: observation.completeness?.[field] ?? 'complete',
      scope: 'request',
      aggregation: 'snapshot',
      source: observation.contextSource?.[field] ?? observation.source,
      observedAt,
      formula: observation.formula?.[field] ?? observation.formulas?.[field],
    });
  }
  const contextReference = Object.keys(context).length || observation.context?.model ? {
    ...context,
    sampledAt: observedAt,
    sampleTurnId: observation.nativeTurnId ? String(observation.nativeTurnId) : null,
    model: observation.context?.model ?? null,
  } : null;
  return {
    metrics,
    contextReference,
    anomalies: Array.isArray(observation.anomalies) ? observation.anomalies : [],
    attempt: observation.attempt ?? null,
    capturedAt: observedAt,
  };
}

export function record(telemetry, {
  groupId,
  executorKind,
  executorId,
  endpointId,
  sessionKey = 'default',
  turnId,
  turnKind = 'member',
  host,
  hostSessionId = null,
  hostSessionNamespace,
  context = null,
  observation,
}) {
  if (!groupId || !observation || typeof observation !== 'object') return null;
  if (context && ['profile', 'private', 'preparation'].includes(context)) return null;
  const source = typeof observation.source === 'string' && observation.source.trim() ? observation.source : 'adapter.unknown';
  const scope = observation.scope ?? 'turn';
  const aggregation = observation.aggregation ?? 'delta';
  const nativeTurnId = observation.nativeTurnId != null ? String(observation.nativeTurnId) : '';
  let effectiveTurnId = turnId;
  let effectiveEndpoint = endpointId;
  let effectiveHostSession = hostSessionId;
  if (turnKind === 'member' && nativeTurnId) {
    const routed = telemetry.store.get(
      `SELECT t.id,t.conversation_id AS endpoint_id,t.session FROM native_turn_refs r
       JOIN turns t ON t.id=r.turn_id JOIN conversations c ON c.id=t.conversation_id
       WHERE r.ref=? AND c.group_id=? ORDER BY t.rowid DESC LIMIT 1`,
      nativeTurnId,
      groupId,
    );
    if (routed) {
      effectiveTurnId = routed.id;
      effectiveEndpoint = routed.endpoint_id;
      effectiveHostSession = routed.session ?? effectiveHostSession;
    }
  }
  const generation = telemetry.store.get(
    'SELECT generation FROM telemetry_session_generations WHERE endpoint_id=? AND session_key=?',
    effectiveEndpoint,
    sessionKey,
  )?.generation ?? 0;
  const namespace = hostSessionNamespace ?? `${host}:default`;
  const instanceId = `ps_${createHash('sha256')
    .update([host, namespace, effectiveEndpoint, sessionKey, effectiveHostSession ?? '', generation].join('|'))
    .digest('hex')
    .slice(0, 16)}`;
  const payload = normalizePayload({ ...observation, source });
  const now = new Date().toISOString();
  telemetry.store.run(
    `INSERT INTO telemetry_observations(
      id,group_id,executor_kind,executor_id,endpoint_id,session_key,turn_id,turn_kind,host,
      host_session_namespace,host_session_id,instance_id,instance_generation,native_turn_id,
      step_id,request_id,attempt_id,source,scope,aggregation,observed_at,payload,created,updated
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(executor_kind,executor_id,endpoint_id,session_key,turn_id,instance_id,source,scope,aggregation,native_turn_id,step_id,request_id,attempt_id)
    DO UPDATE SET payload=excluded.payload,observed_at=excluded.observed_at,updated=excluded.updated,
      host_session_id=excluded.host_session_id,instance_generation=excluded.instance_generation`,
    randomUUID(), groupId, executorKind, executorId, effectiveEndpoint, sessionKey, effectiveTurnId, turnKind,
    host, namespace, effectiveHostSession, instanceId, generation, nativeTurnId,
    observation.stepId != null ? String(observation.stepId) : '',
    observation.requestId != null ? String(observation.requestId) : '',
    observation.attempt?.id != null ? String(observation.attempt.id) : '',
    source, scope, aggregation, payload.capturedAt, JSON.stringify(payload), now, now,
  );
  return { instanceId, generation, turnId: effectiveTurnId };
}

export function rotateSession(telemetry, endpointId, sessionKey = null) {
  const now = new Date().toISOString();
  const keys = sessionKey
    ? [sessionKey]
    : telemetry.store.all('SELECT session_key FROM telemetry_session_generations WHERE endpoint_id=?', endpointId).map(row => row.session_key);
  for (const key of new Set(keys)) {
    telemetry.store.run(
      `INSERT INTO telemetry_session_generations(endpoint_id,session_key,generation,updated) VALUES(?,?,1,?)
       ON CONFLICT(endpoint_id,session_key) DO UPDATE SET generation=generation+1,updated=excluded.updated`,
      endpointId,
      key,
      now,
    );
  }
}
