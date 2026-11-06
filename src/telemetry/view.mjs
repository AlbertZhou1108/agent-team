// 遥测视图:批次汇总、覆盖度、分页与只读查询底座。
import { capability, METRIC_KEYS, UNIFIED_FIELDS, telemetryCapabilitiesFor } from '../telemetry-capabilities.mjs';
import {
  TelemetryQueryError, maxObservedAt, metric, missingMetric, sumMetricList, worstCompleteness,
} from './write.mjs';

export function _capabilitiesForHost(telemetry, host) {
  const declared = telemetry.capabilityFor(host) ?? telemetryCapabilitiesFor(host);
  const metrics = {};
  for (const field of UNIFIED_FIELDS) {
    metrics[field] = declared?.metrics?.[field] ?? capability('unsupported', 'adapter.capability', [], [], '适配器未声明支持该字段');
  }
  return { version: 1, host, metrics };
}

export function _capabilityMap(telemetry, host) {
  const declaration = telemetry._capabilitiesForHost(host);
  return declaration.metrics;
}

export function _sumBatches(batches) {
  const metrics = {};
  for (const field of METRIC_KEYS) {
    const values = batches.map(batch => batch.metrics[field]);
    metrics[field] = sumMetricList(field, values) ?? missingMetric(field, { capability: 'direct', source: 'unknown' });
  }
  if (metrics.totalTokens.value === null && metrics.inputTokensTotal.value !== null && metrics.outputTokens.value !== null) {
    metrics.totalTokens = metric(metrics.inputTokensTotal.value + metrics.outputTokens.value, {
      quality: 'derived',
      completeness: worstCompleteness([metrics.inputTokensTotal.completeness, metrics.outputTokens.completeness]),
      scope: 'query',
      aggregation: 'sum',
      source: 'query.aggregate',
      observedAt: maxObservedAt([metrics.inputTokensTotal.observedAt, metrics.outputTokens.observedAt]),
      formula: 'sum(inputTokensTotal) + sum(outputTokens)',
    });
  }
  const input = metrics.inputTokensTotal;
  const cache = metrics.cacheReadTokens;
  if (input.value !== null && input.value > 0 && cache.value !== null) {
    metrics.cacheReadRatio = metric(cache.value / input.value, {
      quality: 'derived', completeness: worstCompleteness([input.completeness, cache.completeness]),
      scope: 'query', aggregation: 'ratio', source: 'query.aggregate',
      observedAt: maxObservedAt([input.observedAt, cache.observedAt]), formula: 'cacheReadTokens / inputTokensTotal',
    });
  }
  return metrics;
}

export function _latestContext(batches) {
  const sorted = [...batches].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  const withContext = sorted.filter(batch => batch.contextReference.lastRequestInputTokens.value !== null);
  return (withContext.at(-1) ?? sorted.at(-1))?.contextReference ?? {
    lastRequestInputTokens: missingMetric('lastRequestInputTokens', { capability: 'direct', source: 'unknown' }, 'request'),
    contextWindowTokens: missingMetric('contextWindowTokens', { capability: 'direct', source: 'unknown' }, 'request'),
    lastRequestInputRatio: missingMetric('lastRequestInputRatio', { capability: 'direct', source: 'unknown' }, 'request'),
    sampledAt: null, sampleTurnId: null, model: null,
  };
}

export function _managerEmptyContext() {
  const missing = (field, reason = 'not_captured') => missingMetric(field, { capability: 'direct', source: 'unknown' }, 'request', reason);
  return {
    lastRequestInputTokens: missing('lastRequestInputTokens'),
    contextWindowTokens: missing('contextWindowTokens'),
    lastRequestInputRatio: missing('lastRequestInputRatio', 'dependency_missing'),
    sampledAt: null,
    sampleTurnId: null,
    model: null,
  };
}

export function _coverage(batches) {
  const reasons = [];
  if (!batches.length) reasons.push('no_observations');
  if (batches.some(batch => batch.state === 'failed' || batch.state === 'cancelled')) reasons.push('failed_attempt');
  if (batches.some(batch => batch.completeness !== 'complete')) reasons.push('missing_usage');
  if (batches.some(batch => batch.anomalies.length)) reasons.push('anomaly');
  if (batches.some(batch => batch._sessionMeta?.status === 'reset')) reasons.push('session_reset');
  return {
    captureStartedAt: batches.length ? batches.map(batch => batch.physicalSession.firstObservedAt).filter(Boolean).sort()[0] ?? null : null,
    complete: batches.length > 0 && batches.every(batch => batch.completeness === 'complete' && batch.anomalies.length === 0),
    reasons,
    batchCount: batches.length,
    completeBatchCount: batches.filter(batch => batch.completeness === 'complete').length,
    partialBatchCount: batches.filter(batch => batch.completeness === 'partial').length,
    unknownBatchCount: batches.filter(batch => batch.completeness === 'unknown').length,
  };
}

export function _sessions(telemetry, batches) {
  const grouped = new Map();
  for (const batch of batches) {
    const id = batch.physicalSession.instanceId;
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id).push(batch);
  }
  return [...grouped.entries()].map(([instanceId, sessionBatches]) => {
    const base = sessionBatches[0].physicalSession;
    const meta = sessionBatches[0]._sessionMeta;
    return {
      ...base,
      instanceId,
      status: meta.status,
      resetAt: meta.resetAt,
      consumption: telemetry._sumBatches(sessionBatches),
      contextReference: telemetry._latestContext(sessionBatches),
      coverage: telemetry._coverage(sessionBatches),
    };
  });
}

export function _provenance(batches) {
  const seen = new Set();
  const result = [];
  for (const batch of batches) {
    for (const entry of batch.provenance) {
      const key = [entry.source, entry.observedAt, entry.scope, entry.aggregation, entry.nativeTurnId, entry.stepId, entry.requestId].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(entry);
    }
  }
  return result.slice(-500);
}

export function _sourceSubtotals(telemetry, batches) {
  const actors = new Map();
  for (const batch of batches) {
    for (const actor of batch.inputBatch.sourceActors) {
      if (!actors.has(actor.actorId)) actors.set(actor.actorId, { sourceActorId: actor.actorId, sourceActorName: actor.actorName, included: [], excluded: [] });
      if (batch.inputBatch.merge.merged) actors.get(actor.actorId).excluded.push(batch.batchId);
      else actors.get(actor.actorId).included.push(batch.batchId);
    }
  }
  return [...actors.values()].map(actor => ({
    sourceActorId: actor.sourceActorId,
    sourceActorName: actor.sourceActorName,
    totals: telemetry._sumBatches(batches.filter(batch => actor.included.includes(batch.batchId))),
    includedBatchIds: actor.included,
    excludedMergedBatchIds: actor.excluded,
  }));
}

export function _outgoingMessages(telemetry, turn) {
  if (turn.turnKind !== 'panel') return [];
  return telemetry.store.all(
    `SELECT m.id,m.kind,m.recipient,m.created
     FROM message_origins o JOIN messages m ON m.id=o.message_id
     WHERE o.turn_id=? AND m.kind IN ('send','note')
     ORDER BY m.created,m.id`,
    turn.id,
  ).map(message => {
    const member = telemetry.store.get('SELECT id,name FROM members WHERE id=?', message.recipient);
    const panel = member ? null : telemetry.store.get('SELECT id,name FROM panel_agents WHERE id=?', message.recipient);
    const recipientKind = member ? 'member' : panel ? 'panel_agent' : message.recipient === 'user' ? 'user' : 'other';
    return {
      messageId: message.id,
      recipientId: message.recipient,
      recipientName: member?.name ?? panel?.name ?? message.recipient,
      recipientKind,
      kind: message.kind,
      createdAt: message.created ?? null,
    };
  });
}

export function _involvement(telemetry, turn, outgoingMessages, groupId, memberId) {
  const involved = new Set();
  const addIfMember = id => {
    if (telemetry.store.get('SELECT 1 FROM members WHERE id=? AND group_id=? AND removed IS NULL', id, groupId)) involved.add(id);
  };
  for (const input of turn.inputs) addIfMember(input.sender);
  for (const message of outgoingMessages) addIfMember(message.recipientId);
  const involvedMemberIds = [...involved].sort();
  return {
    involvedMemberIds,
    exclusiveToMember: involvedMemberIds.length === 1 && involvedMemberIds[0] === memberId,
    sharedWithOtherMembers: involvedMemberIds.some(id => id !== memberId),
  };
}

export function _compareBatches(a, b) {
  if (a.startedAt !== b.startedAt) {
    if (a.startedAt == null) return 1;
    if (b.startedAt == null) return -1;
    return String(a.startedAt).localeCompare(String(b.startedAt));
  }
  return a.frameworkTurnId.localeCompare(b.frameworkTurnId) || a.batchId.localeCompare(b.batchId);
}

export function _managerPage(batches, { cursor = null, limit = 20 } = {}) {
  let size = 20;
  if (limit !== undefined && limit !== null) {
    if (!/^\d+$/.test(String(limit))) throw new TelemetryQueryError('limit 必须为 1–100 的整数');
    size = Number(limit);
    if (size < 1 || size > 100) throw new TelemetryQueryError('limit 必须为 1–100 的整数');
  }
  let afterIndex = 0;
  if (cursor !== null && cursor !== undefined && cursor !== '') {
    let decoded;
    try {
      decoded = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
      if (!decoded || (decoded.startedAt !== null && typeof decoded.startedAt !== 'string')
        || typeof decoded.frameworkTurnId !== 'string' || typeof decoded.batchId !== 'string') throw new Error('bad');
    } catch { throw new TelemetryQueryError('cursor 无效'); }
    const index = batches.findIndex(batch => (batch.startedAt ?? null) === decoded.startedAt
      && batch.frameworkTurnId === decoded.frameworkTurnId && batch.batchId === decoded.batchId);
    if (index < 0) throw new TelemetryQueryError('cursor 无效');
    afterIndex = index + 1;
  }
  const remaining = batches.slice(afterIndex);
  const page = remaining.slice(0, size);
  const nextCursor = remaining.length > size
    ? Buffer.from(JSON.stringify({
        startedAt: page.at(-1).startedAt ?? null,
        frameworkTurnId: page.at(-1).frameworkTurnId,
        batchId: page.at(-1).batchId,
      })).toString('base64url')
    : null;
  return { page, nextCursor };
}

export function _summary(telemetry, batches) {
  return {
    executorTotals: telemetry._sumBatches(batches),
    contextReference: telemetry._latestContext(batches),
    singleSourceBatchIds: batches.filter(batch => !batch.inputBatch.merge.merged).map(batch => batch.batchId),
    mergedBatchIds: batches.filter(batch => batch.inputBatch.merge.merged).map(batch => batch.batchId),
    sharedSourceBatchIds: batches.filter(batch => batch.inputBatch.merge.sharedSources).map(batch => batch.batchId),
    sourceSubtotals: telemetry._sourceSubtotals(batches),
    coverage: telemetry._coverage(batches),
  };
}

export function _page(batches, { cursor = null, limit = 20 } = {}) {
  const size = Math.min(Math.max(Number(limit) || 20, 1), 100);
  let offset = 0;
  if (cursor !== null && cursor !== undefined && cursor !== '') {
    if (!/^\d+$/.test(String(cursor))) throw new TelemetryQueryError('cursor 无效');
    offset = Number(cursor);
  }
  const page = batches.slice(offset, offset + size);
  return { page, nextCursor: offset + size < batches.length ? String(offset + size) : null };
}

export function _range(from, to) {
  if (from && Number.isNaN(Date.parse(from))) throw new TelemetryQueryError('from 必须是有效的 ISO-8601');
  if (to && Number.isNaN(Date.parse(to))) throw new TelemetryQueryError('to 必须是有效的 ISO-8601');
  if (from && to && Date.parse(from) >= Date.parse(to)) throw new TelemetryQueryError('from 必须早于 to');
  return { from: from || null, to: to || null };
}

export function _base(telemetry, groupId) {
  if (!telemetry.store.get('SELECT 1 FROM groups WHERE id=?', groupId)) throw new TelemetryQueryError('群不存在', 404);
  return {
    schemaVersion: 1,
    readOnly: true,
    groupId,
    generatedAt: new Date().toISOString(),
  };
}
