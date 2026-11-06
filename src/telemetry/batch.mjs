// 遥测批次:把原始观测行装配成回合批次、输入来源与指标/上下文视图。
import { METRIC_KEYS } from '../capability-contract.mjs';
import {
  TelemetryQueryError, aggregateCompleteness, batchCompleteness, maxObservedAt,
  metric, missingMetric, sumMetricList, worstCompleteness,
} from './write.mjs';

export function _rows(telemetry, groupId, from, to) {
  const rows = telemetry.store.all(
    'SELECT * FROM telemetry_observations WHERE group_id=? ORDER BY observed_at,rowid',
    groupId,
  ).flatMap(row => {
    try { return [{ ...row, payload: JSON.parse(row.payload) }]; }
    catch { return []; }
  });
  if (!from && !to) return rows;
  const start = from ? Date.parse(from) : null;
  const end = to ? Date.parse(to) : null;
  if ((from && Number.isNaN(start)) || (to && Number.isNaN(end))) throw new TelemetryQueryError('时间范围必须是有效的 ISO-8601');
  if (start !== null && end !== null && start >= end) throw new TelemetryQueryError('from 必须早于 to');
  const turnCache = new Map();
  return rows.filter(row => {
    const key = `${row.turn_kind}:${row.turn_id}`;
    let turn = turnCache.get(key);
    if (turn === undefined) {
      turn = telemetry._loadTurn(row.turn_kind, row.turn_id);
      turnCache.set(key, turn);
    }
    if (!turn?.created) return false;
    const created = Date.parse(turn.created);
    return (start === null || created >= start) && (end === null || created < end);
  });
}

export function _loadTurn(telemetry, kind, id) {
  if (kind === 'panel') {
    const turn = telemetry.store.get(
      `SELECT t.id,t.conversation_id AS endpoint_id,t.executor_id AS member_id,t.state,t.created,t.ended,
              c.context,c.group_id,p.name,p.host
       FROM turns t JOIN conversations c ON c.id=t.conversation_id
       JOIN panel_agents p ON p.id=c.panel_agent_id WHERE t.id=?`,
      id,
    );
    if (!turn || !turn.group_id) return null;
    return {
      ...turn,
      turnKind: 'panel',
      session: null,
      state: telemetry._state(turn.state),
      inputs: telemetry.store.all(
        'SELECT m.id,m.kind,m.sender,i.ordinal FROM turn_inputs i JOIN messages m ON m.id=i.message_id WHERE i.turn_id=? ORDER BY i.ordinal',
        id,
      ),
      executor: { kind: 'panel_agent', memberId: turn.member_id, name: turn.name, host: turn.host },
    };
  }
  const turn = telemetry.store.get(
    `SELECT t.id,t.conversation_id AS endpoint_id,t.session,t.created,c.group_id,c.member_id,c.context,c.peer,
            m.name,m.host,t.state,t.ended
     FROM turns t JOIN conversations c ON c.id=t.conversation_id JOIN members m ON m.id=c.member_id
     WHERE t.id=?`,
    id,
  );
  if (!turn) return null;
  return {
    ...turn,
    turnKind: 'member',
    state: telemetry._state(turn.state),
    ended: turn.ended ?? null,
    inputs: telemetry.store.all(
      'SELECT m.id,m.kind,m.sender,i.ordinal FROM turn_inputs i JOIN messages m ON m.id=i.message_id WHERE i.turn_id=? ORDER BY i.ordinal',
      id,
    ),
    executor: { kind: 'member', memberId: turn.member_id, name: turn.name, host: turn.host },
  };
}

export function _state(value) {
  if (value === 'completed' || value === 'succeeded') return 'succeeded';
  if (value === 'failed' || value === 'cancelled') return value;
  return 'unknown';
}

export function _actor(telemetry, sender) {
  if (sender === 'user') return { actorId: 'user', actorName: '用户', kind: 'user' };
  const member = telemetry.store.get('SELECT id,name FROM members WHERE id=?', sender);
  if (member) return { actorId: member.id, actorName: member.name, kind: 'member' };
  const panel = telemetry.store.get('SELECT id,name FROM panel_agents WHERE id=?', sender);
  if (panel) return { actorId: panel.id, actorName: panel.name, kind: 'panel_agent' };
  return { actorId: sender, actorName: sender, kind: 'user' };
}

export function _recipientActor(telemetry, groupId, recipientId) {
  if (recipientId === 'user') return { recipientId, recipientName: '用户', recipientKind: 'user' };
  const member = telemetry.store.get('SELECT id,name FROM members WHERE id=? AND group_id=?', recipientId, groupId);
  if (member) return { recipientId, recipientName: member.name, recipientKind: 'member' };
  const panel = telemetry.store.get('SELECT id,name FROM panel_agents WHERE id=?', recipientId);
  if (panel) return { recipientId, recipientName: panel.name, recipientKind: 'panel_agent' };
  return { recipientId, recipientName: recipientId, recipientKind: 'other' };
}

export function _managerOutgoingMessages(telemetry, groupId, turnId) {
  const rows = telemetry.store.all(
    `SELECT m.id,m.recipient,m.kind,m.created FROM message_origins o
     JOIN messages m ON m.id=o.message_id
     WHERE o.turn_id=? AND m.group_id=? AND m.kind IN ('send','note')
     ORDER BY m.created,m.id`,
    turnId,
    groupId,
  );
  return rows.map(row => ({
    messageId: row.id,
    ...telemetry._recipientActor(groupId, row.recipient),
    kind: row.kind,
    createdAt: row.created ?? null,
  })).sort((a, b) => {
    const left = a.createdAt ?? '';
    const right = b.createdAt ?? '';
    return left.localeCompare(right) || a.messageId.localeCompare(b.messageId);
  });
}

export function _inputBatch(telemetry, turn) {
  const messages = turn.inputs.map((message, index) => {
    const actor = telemetry._actor(message.sender);
    return {
      messageId: message.id,
      senderId: message.sender,
      senderName: actor.actorName,
      ordinal: message.ordinal ?? index,
      role: message.kind === 'note' ? 'note' : index === 0 ? 'primary' : 'additional',
    };
  });
  const actors = new Map();
  for (const message of messages) {
    if (!actors.has(message.senderId)) {
      actors.set(message.senderId, {
        actorId: message.senderId,
        actorName: message.senderName,
        kind: telemetry._actor(message.senderId).kind,
        messageIds: [],
      });
    }
    actors.get(message.senderId).messageIds.push(message.messageId);
  }
  const sourceActors = [...actors.values()];
  const merged = messages.some(message => message.role === 'additional');
  const sharedSources = sourceActors.length > 1;
  return {
    batchId: `batch:${turn.id}`,
    kind: merged ? 'merged_delivery' : 'single_source',
    messages,
    sourceActors,
    merge: {
      merged,
      sharedSources,
      sourceCount: sourceActors.length,
      countedOnce: true,
      splitBySource: false,
      exclusiveSubtotal: !sharedSources,
    },
    allocation: 'whole_to_executor',
  };
}

export function _metricFromTurn(rows, field) {
  const candidates = rows
    .filter(row => row.scope === 'turn' && row.payload.metrics?.[field]?.value != null)
    .sort((a, b) => String(a.observed_at).localeCompare(String(b.observed_at)));
  return candidates.at(-1)?.payload.metrics?.[field] ?? null;
}

export function _stepSum(rows, field) {
  const allStepRows = rows.filter(row => row.scope === 'step' && row.payload.metrics && Object.keys(row.payload.metrics).length);
  const stepRows = allStepRows
    .filter(row => row.payload.metrics?.[field])
    .sort((a, b) => String(a.observed_at).localeCompare(String(b.observed_at)));
  if (!stepRows.length) return null;
  const metrics = stepRows.map(row => row.payload.metrics[field]);
  const value = sumMetricList(field, metrics);
  if (!value) return null;
  const missingFromSteps = allStepRows.length > stepRows.length;
  value.completeness = missingFromSteps
    ? (value.completeness === 'unknown' ? 'unknown' : 'partial')
    : aggregateCompleteness(metrics.map(item => item.completeness));
  return value;
}

export function _buildMetrics(telemetry, rows, host) {
  const capabilities = telemetry._capabilityMap(host);
  const metrics = {};
  for (const field of METRIC_KEYS) {
    const turnValue = telemetry._metricFromTurn(rows, field);
    const stepValue = turnValue ? null : telemetry._stepSum(rows, field);
    metrics[field] = turnValue ?? stepValue ?? missingMetric(field, capabilities[field]);
  }
  if (metrics.inputTokensTotal.value !== null && metrics.outputTokens.value !== null
    && (metrics.totalTokens.value === null
      || metrics.totalTokens.completeness !== 'complete')) {
    const completeness = worstCompleteness([metrics.inputTokensTotal.completeness, metrics.outputTokens.completeness]);
    metrics.totalTokens = metric(metrics.inputTokensTotal.value + metrics.outputTokens.value, {
      quality: 'derived',
      completeness,
      scope: metrics.inputTokensTotal.scope,
      aggregation: metrics.inputTokensTotal.aggregation,
      source: 'query.aggregate',
      observedAt: maxObservedAt([metrics.inputTokensTotal.observedAt, metrics.outputTokens.observedAt]),
      formula: 'inputTokensTotal + outputTokens (已知部分)',
    });
  }
  const ratioInput = metrics.inputTokensTotal;
  const ratioCache = metrics.cacheReadTokens;
  if (ratioInput.value !== null && ratioInput.value > 0 && ratioCache.value !== null) {
    metrics.cacheReadRatio = metric(ratioCache.value / ratioInput.value, {
      quality: 'derived',
      completeness: worstCompleteness([ratioInput.completeness, ratioCache.completeness]),
      scope: ratioInput.scope,
      aggregation: 'ratio',
      source: 'query.aggregate',
      observedAt: maxObservedAt([ratioInput.observedAt, ratioCache.observedAt]),
      formula: 'cacheReadTokens / inputTokensTotal',
    });
  } else if (metrics.cacheReadRatio.value === null) {
    metrics.cacheReadRatio = missingMetric('cacheReadRatio', capabilities.cacheReadRatio, ratioInput.scope);
  }
  return metrics;
}

export function _buildContext(telemetry, rows, host) {
  const capabilities = telemetry._capabilityMap(host);
  const ordered = [...rows].sort((a, b) => String(a.observed_at).localeCompare(String(b.observed_at)));
  const latest = baseline => ordered.filter(row => row.payload.contextReference?.[baseline]?.value != null).at(-1);
  const inputRow = latest('lastRequestInputTokens');
  const windowRow = latest('contextWindowTokens');
  const lastRequestInputTokens = inputRow?.payload.contextReference.lastRequestInputTokens ?? missingMetric('lastRequestInputTokens', capabilities.lastRequestInputTokens, 'request');
  const contextWindowTokens = windowRow?.payload.contextReference.contextWindowTokens ?? missingMetric('contextWindowTokens', capabilities.contextWindowTokens, 'request');
  const inputModel = inputRow?.payload.contextReference?.model ?? null;
  const windowModel = windowRow?.payload.contextReference?.model ?? null;
  const sameModelRoute = Boolean(inputModel?.model && windowModel?.model
    && inputModel.model === windowModel.model
    && (inputModel.provider ?? null) === (windowModel.provider ?? null));
  const ratio = lastRequestInputTokens.value !== null && contextWindowTokens.value !== null && contextWindowTokens.value > 0 && sameModelRoute
    ? metric(lastRequestInputTokens.value / contextWindowTokens.value, {
        quality: 'derived',
        completeness: worstCompleteness([lastRequestInputTokens.completeness, contextWindowTokens.completeness]),
        scope: 'request',
        aggregation: 'ratio',
        source: 'query.aggregate',
        observedAt: maxObservedAt([lastRequestInputTokens.observedAt, contextWindowTokens.observedAt]),
        formula: 'lastRequestInputTokens / contextWindowTokens',
      })
    : missingMetric(
        'lastRequestInputRatio',
        capabilities.lastRequestInputRatio,
        'request',
        lastRequestInputTokens.value === null || contextWindowTokens.value === null ? 'dependency_missing' : 'scope_mismatch',
      );
  return {      lastRequestInputTokens,
    contextWindowTokens,
    lastRequestInputRatio: ratio,
    sampledAt: maxObservedAt([lastRequestInputTokens.observedAt, contextWindowTokens.observedAt]),
    sampleTurnId: sameModelRoute ? (inputRow?.turn_id ?? null) : null,
    model: sameModelRoute ? inputModel : null,
  };
}

export function _buildBatch(telemetry, turn, rows) {
  const latest = rows.at(-1);
  const capabilities = telemetry._capabilityMap(turn.executor.host);
  const metrics = telemetry._buildMetrics(rows, turn.executor.host);
  const contextReference = telemetry._buildContext(rows, turn.executor.host);
  const supported = METRIC_KEYS.filter(field => capabilities[field].capability !== 'unsupported' || metrics[field].value !== null);
  const completeness = batchCompleteness(supported.map(field => metrics[field].completeness));
  const attemptRows = new Map();
  for (const row of rows) {
    if (!row.attempt_id) continue;
    if (!attemptRows.has(row.attempt_id)) attemptRows.set(row.attempt_id, []);
    attemptRows.get(row.attempt_id).push(row);
  }
  const attempts = [...attemptRows.entries()].map(([attemptId, attemptObs]) => {
    const attempt = attemptObs.find(row => row.payload.attempt)?.payload.attempt ?? {};
    const attemptMetrics = telemetry._buildMetrics(attemptObs, turn.executor.host);
    return {
      attemptId,
      state: telemetry._state(attempt.state),
      hostTurnRef: attempt.hostTurnRef ?? (attemptObs.at(-1).native_turn_id || null),
      observedAt: maxObservedAt(attemptObs.map(row => row.observed_at)),
      completeness: batchCompleteness(METRIC_KEYS.map(field => attemptMetrics[field].completeness)),
      metrics: attemptMetrics,
    };
  });
  if (!attempts.length) {
    attempts.push({
      attemptId: `${turn.id}:attempt`,
      state: turn.state,
      hostTurnRef: rows.find(row => row.native_turn_id)?.native_turn_id || null,
      observedAt: maxObservedAt(rows.map(row => row.observed_at)),
      completeness,
      metrics: null,
    });
  }
  const generation = latest.instance_generation;
  const currentGeneration = telemetry.store.get(
    'SELECT generation FROM telemetry_session_generations WHERE endpoint_id=? AND session_key=?',
    latest.endpoint_id,
    latest.session_key,
  )?.generation ?? 0;
  const generationRow = telemetry.store.get(
    'SELECT updated FROM telemetry_session_generations WHERE endpoint_id=? AND session_key=?',
    latest.endpoint_id,
    latest.session_key,
  );
  // Panel 与成员回合共用存储层原始 context;执行者身份看 turn.executor.kind,不再合成 panel-* 词汇。
  const rawContext = turn.context;
  const sessionContext = rawContext === 'pair' || String(rawContext).startsWith('pair:') ? 'pair' : rawContext;
  const sessionPeer = sessionContext === 'pair'
    ? (turn.peer ?? (String(rawContext).startsWith('pair:') ? String(rawContext).slice(5) : null))
    : (turn.peer ?? null);
  const batch = {
    batchId: `batch:${turn.id}`,
    frameworkTurnId: turn.id,
    executor: turn.executor,
    physicalSession: {
      instanceId: latest.instance_id,
      host: latest.host,
      endpointId: latest.endpoint_id,
      memberId: turn.executor.memberId,
      context: sessionContext,
      peer: sessionPeer,
      sessionKey: latest.session_key,
      hostSessionNamespace: latest.host_session_namespace,
      hostSessionId: latest.host_session_id ?? null,
      firstObservedAt: rows[0].observed_at,
      resetAt: generation > 0 ? generationRow?.updated ?? null : null,
    },
    inputBatch: telemetry._inputBatch(turn),
    state: turn.state,
    startedAt: turn.created ?? null,
    endedAt: turn.ended ?? null,
    attempts,
    metrics,
    contextReference,
    model: [...rows].reverse().find(row => row.payload.contextReference?.model?.model)?.payload.contextReference.model ?? null,
    completeness,
    anomalies: [
      ...rows.flatMap(row => row.payload.anomalies ?? []),
      ...(metrics.totalTokens.value !== null && metrics.totalTokens.completeness === 'complete'
        && metrics.inputTokensTotal.value !== null && metrics.totalTokens.value < metrics.inputTokensTotal.value
        ? [{ code: 'total_mismatch', fields: ['totalTokens'], detail: '宿主 total 小于完整输入，保留报告值并标记异常', observedAt: maxObservedAt(rows.map(row => row.observed_at)), raw: { totalTokens: metrics.totalTokens.value, inputTokensTotal: metrics.inputTokensTotal.value } }]
        : []),
    ],
    provenance: rows.map(row => ({
      eventSeq: null,
      source: row.source,
      observedAt: row.observed_at,
      scope: row.scope,
      aggregation: row.aggregation,
      nativeTurnId: row.native_turn_id || null,
      stepId: row.step_id || null,
      requestId: row.request_id || null,
    })),
  };
  Object.defineProperty(batch, '_sessionMeta', {
    enumerable: false,
    value: {
      generation,
      currentGeneration,
      status: generation === currentGeneration ? 'active' : generation < currentGeneration ? 'reset' : 'ended',
      resetAt: generationRow?.updated ?? null,
    },
  });
  return batch;
}

export function _batches(telemetry, groupId, { from = null, to = null } = {}) {
  const grouped = new Map();
  for (const row of telemetry._rows(groupId, from, to)) {
    const key = `${row.turn_kind}:${row.turn_id}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  const batches = [];
  for (const rows of grouped.values()) {
    const turn = telemetry._loadTurn(rows[0].turn_kind, rows[0].turn_id);
    if (!turn) continue;
    const batch = telemetry._buildBatch(turn, rows);
    const context = String(batch.physicalSession.context ?? '');
    if (!['pair', 'coordination'].includes(context)) continue;
    batches.push(batch);
  }
  return batches.sort((a, b) => {
    const left = a.startedAt ?? '';
    const right = b.startedAt ?? '';
    return left.localeCompare(right) || a.frameworkTurnId.localeCompare(b.frameworkTurnId);
  });
}
