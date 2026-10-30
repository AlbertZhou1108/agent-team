// 遥测能力声明:各宿主适配器对统一遥测字段的采集方式与完整性条件。
// 纯声明性数据,不依赖任何运行时状态。
import { telemetryCapabilitiesFor, METRIC_KEYS, CONTEXT_KEYS, UNIFIED_FIELDS } from './telemetry-capabilities.mjs';
import { createHash, randomUUID } from 'node:crypto';
export class TelemetryQueryError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'TelemetryQueryError';
    this.status = status;
  }
}

function metric(value, { quality, completeness, scope, aggregation, source, observedAt, formula, missingReason = null }) {
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

function missingMetric(field, capabilityEntry, scope = 'unknown', reason = null) {
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

function worstCompleteness(values) {
  if (values.includes('unknown')) return 'unknown';
  if (values.includes('partial')) return 'partial';
  return 'complete';
}

function batchCompleteness(values) {
  if (!values.length) return 'unknown';
  if (values.every(value => value === 'unknown')) return 'unknown';
  if (values.includes('partial') || values.includes('unknown')) return 'partial';
  return 'complete';
}

function aggregateCompleteness(values) {
  if (!values.length) return 'unknown';
  if (values.every(value => value === 'unknown')) return 'unknown';
  if (values.includes('partial') || values.includes('unknown')) return 'partial';
  return 'complete';
}

function maxObservedAt(values) {
  return values.filter(Boolean).sort().at(-1) ?? null;
}

function sumMetricList(field, metrics, { fallbackScope = 'query' } = {}) {
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

function normalizedMetricValue(observation, field) {
  if (METRIC_KEYS.includes(field)) return observation.usage?.[field] ?? observation.timing?.[field];
  return observation.context?.[field];
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

function conversationSummary(summary) {
  const { executorTotals, contextReference, ...rest } = summary;
  return rest;
}

export class Telemetry {
  constructor(store, { capabilityFor = () => null } = {}) {
    this.store = store;
    this.capabilityFor = capabilityFor;
  }

  record({
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
    if (context && ['profile', 'private', 'preparation', 'panel-private'].includes(context)) return null;
    const source = typeof observation.source === 'string' && observation.source.trim() ? observation.source : 'adapter.unknown';
    const scope = observation.scope ?? 'turn';
    const aggregation = observation.aggregation ?? 'delta';
    const nativeTurnId = observation.nativeTurnId != null ? String(observation.nativeTurnId) : '';
    let effectiveTurnId = turnId;
    let effectiveEndpoint = endpointId;
    let effectiveHostSession = hostSessionId;
    if (turnKind === 'member' && nativeTurnId) {
      const routed = this.store.get(
        `SELECT t.id,t.endpoint_id,t.session FROM native_turn_refs r
         JOIN turns t ON t.id=r.turn_id JOIN endpoints e ON e.id=t.endpoint_id
         WHERE r.ref=? AND e.group_id=? ORDER BY t.rowid DESC LIMIT 1`,
        nativeTurnId,
        groupId,
      );
      if (routed) {
        effectiveTurnId = routed.id;
        effectiveEndpoint = routed.endpoint_id;
        effectiveHostSession = routed.session ?? effectiveHostSession;
      }
    }
    const generation = this.store.get(
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
    this.store.run(
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

  rotateSession(endpointId, sessionKey = null) {
    const now = new Date().toISOString();
    const keys = sessionKey
      ? [sessionKey]
      : this.store.all('SELECT session_key FROM telemetry_session_generations WHERE endpoint_id=?', endpointId).map(row => row.session_key);
    for (const key of new Set(keys)) {
      this.store.run(
        `INSERT INTO telemetry_session_generations(endpoint_id,session_key,generation,updated) VALUES(?,?,1,?)
         ON CONFLICT(endpoint_id,session_key) DO UPDATE SET generation=generation+1,updated=excluded.updated`,
        endpointId,
        key,
        now,
      );
    }
  }

  _capabilitiesForHost(host) {
    const declared = this.capabilityFor(host) ?? telemetryCapabilitiesFor(host);
    const metrics = {};
    for (const field of UNIFIED_FIELDS) {
      metrics[field] = declared?.metrics?.[field] ?? capability('unsupported', 'adapter.capability', [], [], '适配器未声明支持该字段');
    }
    return { version: 1, host, metrics };
  }

  _capabilityMap(host) {
    const declaration = this._capabilitiesForHost(host);
    return declaration.metrics;
  }

  _rows(groupId, from, to) {
    const rows = this.store.all(
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
        turn = this._loadTurn(row.turn_kind, row.turn_id);
        turnCache.set(key, turn);
      }
      if (!turn?.created) return false;
      const created = Date.parse(turn.created);
      return (start === null || created >= start) && (end === null || created < end);
    });
  }

  _loadTurn(kind, id) {
    if (kind === 'panel') {
      const turn = this.store.get(
        `SELECT t.id,t.session_id AS endpoint_id,t.panel_agent_id AS member_id,t.state,t.created,t.ended,
                s.context,s.group_id,p.name,p.host
         FROM panel_turns t JOIN panel_sessions s ON s.id=t.session_id
         JOIN panel_agents p ON p.id=t.panel_agent_id WHERE t.id=?`,
        id,
      );
      if (!turn || !turn.group_id) return null;
      return {
        ...turn,
        turnKind: 'panel',
        session: null,
        state: this._state(turn.state),
        inputs: this.store.all(
          'SELECT m.id,m.kind,m.sender,i.ordinal FROM panel_turn_inputs i JOIN messages m ON m.id=i.message_id WHERE i.turn_id=? ORDER BY i.ordinal',
          id,
        ),
        executor: { kind: 'panel_agent', memberId: turn.member_id, name: turn.name, host: turn.host },
      };
    }
    const turn = this.store.get(
      `SELECT t.id,t.endpoint_id,t.session,t.created,e.group_id,e.member_id,e.context,e.peer,
              m.name,m.host
       FROM turns t JOIN endpoints e ON e.id=t.endpoint_id JOIN members m ON m.id=e.member_id
       WHERE t.id=?`,
      id,
    );
    if (!turn) return null;
    const attempt = this.store.get(
      'SELECT state,ended FROM runtime_attempts WHERE turn_id=? ORDER BY created DESC LIMIT 1',
      id,
    );
    return {
      ...turn,
      turnKind: 'member',
      state: this._state(attempt?.state),
      ended: attempt?.ended ?? null,
      inputs: this.store.all(
        'SELECT m.id,m.kind,m.sender,i.ordinal FROM turn_inputs i JOIN messages m ON m.id=i.message_id WHERE i.turn_id=? ORDER BY i.ordinal',
        id,
      ),
      executor: { kind: 'member', memberId: turn.member_id, name: turn.name, host: turn.host },
    };
  }

  _state(value) {
    if (value === 'completed' || value === 'succeeded') return 'succeeded';
    if (value === 'failed' || value === 'cancelled') return value;
    return 'unknown';
  }

  _actor(sender) {
    if (sender === 'user') return { actorId: 'user', actorName: '用户', kind: 'user' };
    const member = this.store.get('SELECT id,name FROM members WHERE id=?', sender);
    if (member) return { actorId: member.id, actorName: member.name, kind: 'member' };
    const panel = this.store.get('SELECT id,name FROM panel_agents WHERE id=?', sender);
    if (panel) return { actorId: panel.id, actorName: panel.name, kind: 'panel_agent' };
    return { actorId: sender, actorName: sender, kind: 'user' };
  }

  _recipientActor(groupId, recipientId) {
    if (recipientId === 'user') return { recipientId, recipientName: '用户', recipientKind: 'user' };
    const member = this.store.get('SELECT id,name FROM members WHERE id=? AND group_id=?', recipientId, groupId);
    if (member) return { recipientId, recipientName: member.name, recipientKind: 'member' };
    const panel = this.store.get('SELECT id,name FROM panel_agents WHERE id=?', recipientId);
    if (panel) return { recipientId, recipientName: panel.name, recipientKind: 'panel_agent' };
    return { recipientId, recipientName: recipientId, recipientKind: 'other' };
  }

  _managerOutgoingMessages(groupId, turnId) {
    const rows = this.store.all(
      `SELECT m.id,m.recipient,m.kind,m.created FROM panel_message_origins o
       JOIN messages m ON m.id=o.message_id
       WHERE o.turn_id=? AND m.group_id=? AND m.kind IN ('send','note')
       ORDER BY m.created,m.id`,
      turnId,
      groupId,
    );
    return rows.map(row => ({
      messageId: row.id,
      ...this._recipientActor(groupId, row.recipient),
      kind: row.kind,
      createdAt: row.created ?? null,
    })).sort((a, b) => {
      const left = a.createdAt ?? '';
      const right = b.createdAt ?? '';
      return left.localeCompare(right) || a.messageId.localeCompare(b.messageId);
    });
  }

  _inputBatch(turn) {
    const messages = turn.inputs.map((message, index) => {
      const actor = this._actor(message.sender);
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
          kind: this._actor(message.senderId).kind,
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

  _metricFromTurn(rows, field) {
    const candidates = rows
      .filter(row => row.scope === 'turn' && row.payload.metrics?.[field]?.value != null)
      .sort((a, b) => String(a.observed_at).localeCompare(String(b.observed_at)));
    return candidates.at(-1)?.payload.metrics?.[field] ?? null;
  }

  _stepSum(rows, field) {
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

  _buildMetrics(rows, host) {
    const capabilities = this._capabilityMap(host);
    const metrics = {};
    for (const field of METRIC_KEYS) {
      const turnValue = this._metricFromTurn(rows, field);
      const stepValue = turnValue ? null : this._stepSum(rows, field);
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

  _buildContext(rows, host) {
    const capabilities = this._capabilityMap(host);
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

  _buildBatch(turn, rows) {
    const latest = rows.at(-1);
    const capabilities = this._capabilityMap(turn.executor.host);
    const metrics = this._buildMetrics(rows, turn.executor.host);
    const contextReference = this._buildContext(rows, turn.executor.host);
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
      const attemptMetrics = this._buildMetrics(attemptObs, turn.executor.host);
      return {
        attemptId,
        state: this._state(attempt.state),
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
    const currentGeneration = this.store.get(
      'SELECT generation FROM telemetry_session_generations WHERE endpoint_id=? AND session_key=?',
      latest.endpoint_id,
      latest.session_key,
    )?.generation ?? 0;
    const generationRow = this.store.get(
      'SELECT updated FROM telemetry_session_generations WHERE endpoint_id=? AND session_key=?',
      latest.endpoint_id,
      latest.session_key,
    );
    const rawContext = turn.turnKind === 'panel' ? 'panel-coordination' : turn.context;
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
      inputBatch: this._inputBatch(turn),
      state: turn.state,
      startedAt: turn.created ?? null,
      endedAt: turn.ended ?? null,
      attempts,
      metrics,
      contextReference,
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

  _batches(groupId, { from = null, to = null } = {}) {
    const grouped = new Map();
    for (const row of this._rows(groupId, from, to)) {
      const key = `${row.turn_kind}:${row.turn_id}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(row);
    }
    const batches = [];
    for (const rows of grouped.values()) {
      const turn = this._loadTurn(rows[0].turn_kind, rows[0].turn_id);
      if (!turn) continue;
      const batch = this._buildBatch(turn, rows);
      const context = String(batch.physicalSession.context ?? '');
      if (!['pair', 'coordination', 'panel-coordination'].includes(context)) continue;
      batches.push(batch);
    }
    return batches.sort((a, b) => {
      const left = a.startedAt ?? '';
      const right = b.startedAt ?? '';
      return left.localeCompare(right) || a.frameworkTurnId.localeCompare(b.frameworkTurnId);
    });
  }

  _sumBatches(batches) {
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

  _latestContext(batches) {
    const sorted = [...batches].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    const withContext = sorted.filter(batch => batch.contextReference.lastRequestInputTokens.value !== null);
    return (withContext.at(-1) ?? sorted.at(-1))?.contextReference ?? {
      lastRequestInputTokens: missingMetric('lastRequestInputTokens', { capability: 'direct', source: 'unknown' }, 'request'),
      contextWindowTokens: missingMetric('contextWindowTokens', { capability: 'direct', source: 'unknown' }, 'request'),
      lastRequestInputRatio: missingMetric('lastRequestInputRatio', { capability: 'direct', source: 'unknown' }, 'request'),
      sampledAt: null, sampleTurnId: null, model: null,
    };
  }

  _managerEmptyContext() {
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

  _coverage(batches) {
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

  _sessions(batches) {
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
        consumption: this._sumBatches(sessionBatches),
        contextReference: this._latestContext(sessionBatches),
        coverage: this._coverage(sessionBatches),
      };
    });
  }

  _provenance(batches) {
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

  _sourceSubtotals(batches) {
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
      totals: this._sumBatches(batches.filter(batch => actor.included.includes(batch.batchId))),
      includedBatchIds: actor.included,
      excludedMergedBatchIds: actor.excluded,
    }));
  }

  _outgoingMessages(turn) {
    if (turn.turnKind !== 'panel') return [];
    return this.store.all(
      `SELECT m.id,m.kind,m.recipient,m.created
       FROM panel_message_origins o JOIN messages m ON m.id=o.message_id
       WHERE o.turn_id=? AND m.kind IN ('send','note')
       ORDER BY m.created,m.id`,
      turn.id,
    ).map(message => {
      const member = this.store.get('SELECT id,name FROM members WHERE id=?', message.recipient);
      const panel = member ? null : this.store.get('SELECT id,name FROM panel_agents WHERE id=?', message.recipient);
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

  _involvement(turn, outgoingMessages, groupId, memberId) {
    const involved = new Set();
    const addIfMember = id => {
      if (this.store.get('SELECT 1 FROM members WHERE id=? AND group_id=? AND removed IS NULL', id, groupId)) involved.add(id);
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

  _compareBatches(a, b) {
    if (a.startedAt !== b.startedAt) {
      if (a.startedAt == null) return 1;
      if (b.startedAt == null) return -1;
      return String(a.startedAt).localeCompare(String(b.startedAt));
    }
    return a.frameworkTurnId.localeCompare(b.frameworkTurnId) || a.batchId.localeCompare(b.batchId);
  }

  _managerPage(batches, { cursor = null, limit = 20 } = {}) {
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

  _summary(batches) {
    return {
      executorTotals: this._sumBatches(batches),
      contextReference: this._latestContext(batches),
      singleSourceBatchIds: batches.filter(batch => !batch.inputBatch.merge.merged).map(batch => batch.batchId),
      mergedBatchIds: batches.filter(batch => batch.inputBatch.merge.merged).map(batch => batch.batchId),
      sharedSourceBatchIds: batches.filter(batch => batch.inputBatch.merge.sharedSources).map(batch => batch.batchId),
      sourceSubtotals: this._sourceSubtotals(batches),
      coverage: this._coverage(batches),
    };
  }

  _page(batches, { cursor = null, limit = 20 } = {}) {
    const size = Math.min(Math.max(Number(limit) || 20, 1), 100);
    let offset = 0;
    if (cursor !== null && cursor !== undefined && cursor !== '') {
      if (!/^\d+$/.test(String(cursor))) throw new TelemetryQueryError('cursor 无效');
      offset = Number(cursor);
    }
    const page = batches.slice(offset, offset + size);
    return { page, nextCursor: offset + size < batches.length ? String(offset + size) : null };
  }

  _range(from, to) {
    if (from && Number.isNaN(Date.parse(from))) throw new TelemetryQueryError('from 必须是有效的 ISO-8601');
    if (to && Number.isNaN(Date.parse(to))) throw new TelemetryQueryError('to 必须是有效的 ISO-8601');
    if (from && to && Date.parse(from) >= Date.parse(to)) throw new TelemetryQueryError('from 必须早于 to');
    return { from: from || null, to: to || null };
  }

  _base(groupId) {
    if (!this.store.get('SELECT 1 FROM groups WHERE id=?', groupId)) throw new TelemetryQueryError('群不存在', 404);
    return {
      schemaVersion: 1,
      readOnly: true,
      groupId,
      generatedAt: new Date().toISOString(),
    };
  }

  managerConversation(groupId, controller, memberId, options = {}) {
    if (typeof groupId !== 'string' || !groupId.trim() || typeof memberId !== 'string' || !memberId.trim()) {
      throw new TelemetryQueryError('缺少 group 或 member 参数');
    }
    const base = this._base(groupId);
    if (controller?.kind !== 'panel_agent') {
      throw new TelemetryQueryError('当前主 Agent 不是 Panel Agent，请使用成员 ↔ 成员双方会话');
    }
    const member = this.store.get('SELECT * FROM members WHERE id=? AND group_id=? AND removed IS NULL', memberId, groupId);
    if (!member) throw new TelemetryQueryError('成员不存在或已移除', 404);
    const range = this._range(options.from, options.to);
    const manager = {
      kind: 'panel_agent',
      memberId: controller.id,
      name: controller.agent?.name ?? controller.name,
      host: controller.agent?.host ?? 'unknown',
    };
    const pairEndpoint = this.store.get(
      "SELECT id FROM endpoints WHERE member_id=? AND context=?",
      memberId,
      `pair:${controller.id}`,
    );
    const memberBatches = this._batches(groupId, range)
      .filter(batch => batch.executor.kind === 'member'
        && batch.executor.memberId === memberId
        && pairEndpoint
        && batch.physicalSession.endpointId === pairEndpoint.id)
      .map(batch => {
        const view = { ...batch, side: 'member', outgoingMessages: [], involvement: null };
        Object.defineProperty(view, '_sessionMeta', { enumerable: false, value: batch._sessionMeta });
        return view;
      });
    const allManagerBatches = this._batches(groupId).filter(batch => batch.executor.kind === 'panel_agent'
      && batch.executor.memberId === controller.id
      && batch.physicalSession.context === 'panel-coordination');
    const managerBatches = [];
    for (const batch of allManagerBatches) {
      if (range.from && Date.parse(batch.startedAt) < Date.parse(range.from)) continue;
      if (range.to && Date.parse(batch.startedAt) >= Date.parse(range.to)) continue;
      const turn = this._loadTurn('panel', batch.frameworkTurnId);
      if (!turn) continue;
      const outgoingMessages = this._outgoingMessages(turn);
      const involvement = this._involvement(turn, outgoingMessages, groupId, memberId);
      if (!involvement.involvedMemberIds.includes(memberId)) continue;
      const view = { ...batch, side: 'manager', outgoingMessages, involvement };
      Object.defineProperty(view, '_sessionMeta', { enumerable: false, value: batch._sessionMeta });
      managerBatches.push(view);
    }
    const sortedManagerBatches = managerBatches.sort((a, b) => this._compareBatches(a, b));
    const sortedMemberBatches = memberBatches.sort((a, b) => this._compareBatches(a, b));
    const union = [...sortedMemberBatches, ...sortedManagerBatches]
      .sort((a, b) => this._compareBatches(a, b));
    const paged = this._managerPage(union, options);
    const involvedMemberIds = [...new Set(sortedManagerBatches.flatMap(batch => batch.involvement.involvedMemberIds))].sort();
    const sessionIds = new Set(sortedManagerBatches.map(batch => batch.physicalSession.instanceId));
    const managerSessions = this._sessions(allManagerBatches.filter(batch => sessionIds.has(batch.physicalSession.instanceId)));
    const memberBatchIds = sortedMemberBatches.map(batch => batch.batchId);
    const managerBatchIds = sortedManagerBatches.map(batch => batch.batchId);
    const exclusiveBatchIds = sortedManagerBatches.filter(batch => batch.involvement.exclusiveToMember).map(batch => batch.batchId);
    const sharedBatchIds = sortedManagerBatches.filter(batch => batch.involvement.sharedWithOtherMembers).map(batch => batch.batchId);
    return {
      ...base,
      range,
      member: { memberId: member.id, name: member.name, host: member.host },
      manager,
      memberSide: {
        totals: this._sumBatches(sortedMemberBatches),
        contextReference: sortedMemberBatches.length ? this._latestContext(sortedMemberBatches) : this._managerEmptyContext(),
        coverage: this._coverage(sortedMemberBatches),
        batchCount: sortedMemberBatches.length,
        physicalSessions: this._sessions(sortedMemberBatches),
      },
      managerSide: {
        involvementTotals: this._sumBatches(sortedManagerBatches),
        exclusiveBatchIds,
        sharedBatchIds,
        involvedMemberIds,
        batchCount: sortedManagerBatches.length,
        physicalSessions: managerSessions,
        contextReference: sortedManagerBatches.length ? this._latestContext(sortedManagerBatches) : this._managerEmptyContext(),
        coverage: this._coverage(sortedManagerBatches),
      },
      batches: paged.page,
      nextCursor: paged.nextCursor,
      summary: {
        memberBatchIds,
        managerBatchIds,
        exclusiveManagerBatchIds: exclusiveBatchIds,
        sharedManagerBatchIds: sharedBatchIds,
        note: '管理者侧为相关性视图：共享批次整批只计一次，禁止拆分或与成员侧/协调总量相加',
      },
      provenance: this._provenance([...sortedMemberBatches, ...sortedManagerBatches]),
    };
  }

  conversation(groupId, memberId, peerId, options = {}) {
    const base = this._base(groupId);
    const member = this.store.get('SELECT * FROM members WHERE id=? AND removed IS NULL', memberId);
    const peer = this.store.get('SELECT * FROM members WHERE id=? AND removed IS NULL', peerId);
    if (!member || !peer || member.group_id !== groupId || peer.group_id !== groupId) throw new TelemetryQueryError('成员不属于该群', 404);
    if (memberId === peerId) throw new TelemetryQueryError('会话双方不能是同一成员');
    const range = this._range(options.from, options.to);
    const endpoints = [
      this.store.get("SELECT * FROM endpoints WHERE member_id=? AND context=?", memberId, `pair:${peerId}`),
      this.store.get("SELECT * FROM endpoints WHERE member_id=? AND context=?", peerId, `pair:${memberId}`),
    ].filter(Boolean);
    const endpointIds = new Set(endpoints.map(endpoint => endpoint.id));
    const allBatches = this._batches(groupId, range).filter(batch => endpointIds.has(batch.physicalSession.endpointId));
    const paged = this._page(allBatches, options);
    const participants = [member, peer].map(item => ({ memberId: item.id, name: item.name, host: item.host }));
    const executors = [member, peer].map(item => {
      const batches = allBatches.filter(batch => batch.executor.memberId === item.id);
      return {
        executor: { kind: 'member', memberId: item.id, name: item.name, host: item.host },
        physicalSessions: this._sessions(batches),
        batchCount: batches.length,
        totals: this._sumBatches(batches),
        contextReference: this._latestContext(batches),
        coverage: this._coverage(batches),
      };
    });
    return {
      ...base,
      range,
      conversation: {
        participantIds: [memberId, peerId],
        participants,
      },
      executors,
      batches: paged.page,
      nextCursor: paged.nextCursor,
      summary: conversationSummary(this._summary(allBatches)),
      provenance: this._provenance(allBatches),
    };
  }

  coordination(groupId, controller, options = {}) {
    const base = this._base(groupId);
    const range = this._range(options.from, options.to);
    const endpointIds = new Set();
    if (controller?.kind === 'member') {
      for (const endpoint of this.store.all("SELECT id FROM endpoints WHERE member_id=? AND context='coordination'", controller.id)) endpointIds.add(endpoint.id);
    } else if (controller?.kind === 'panel_agent') {
      for (const session of this.store.all("SELECT id FROM panel_sessions WHERE panel_agent_id=? AND group_id=? AND context='coordination'", controller.id, groupId)) endpointIds.add(session.id);
    }
    const allBatches = this._batches(groupId, range).filter(batch => endpointIds.has(batch.physicalSession.endpointId));
    const paged = this._page(allBatches, options);
    const summary = this._summary(allBatches);
    const executor = controller?.kind === 'member'
      ? { kind: 'member', memberId: controller.member.id, name: controller.member.name, host: controller.member.host }
      : controller?.kind === 'panel_agent'
        ? { kind: 'panel_agent', memberId: controller.agent.id, name: controller.agent.name, host: controller.agent.host }
        : null;
    return {
      ...base,
      range,
      coordination: executor ? { executor, physicalSessions: this._sessions(allBatches) } : null,
      batches: paged.page,
      nextCursor: paged.nextCursor,
      summary,
      provenance: this._provenance(allBatches),
    };
  }

  members(groupId, options = {}) {
    const base = this._base(groupId);
    const range = this._range(options.from, options.to);
    const allBatches = this._batches(groupId, range);
    const members = this.store.all('SELECT * FROM members WHERE group_id=? AND removed IS NULL ORDER BY rowid', groupId);
    const panelAgent = this.store.panelAgent();
    const entries = members.map(member => ({ kind: 'member', id: member.id, name: member.name, host: member.host }));
    if (panelAgent) entries.push({ kind: 'panel_agent', id: panelAgent.id, name: panelAgent.name, host: panelAgent.host });
    const memberRows = entries.map(entry => {
      const batches = allBatches.filter(batch => batch.executor.kind === entry.kind && batch.executor.memberId === entry.id);
      const physicalSessions = this._sessions(batches);
      return {
        executor: { kind: entry.kind, memberId: entry.id, name: entry.name, host: entry.host },
        physicalSessions,
        physicalSessionCount: physicalSessions.length,
        batchCount: batches.length,
        totals: this._sumBatches(batches),
        contextReference: this._latestContext(batches),
        coverage: this._coverage(batches),
      };
    });
    return {
      ...base,
      range,
      members: memberRows,
      sourceAnalysis: {
        note: '仅按消息来源分析，合并批次不拆分；不得与执行归属总量相加',
        actors: this._sourceSubtotals(allBatches),
        mergedBatchIds: allBatches.filter(batch => batch.inputBatch.merge.merged).map(batch => batch.batchId),
        sharedSourceBatchIds: allBatches.filter(batch => batch.inputBatch.merge.sharedSources).map(batch => batch.batchId),
      },
      provenance: this._provenance(allBatches),
    };
  }

  capabilities(groupId, controllers = []) {
    const base = this._base(groupId);
    const hosts = new Set(this.store.all('SELECT DISTINCT host FROM members WHERE group_id=? AND removed IS NULL', groupId).map(row => row.host));
    const panelAgent = this.store.panelAgent();
    if (panelAgent) hosts.add(panelAgent.host);
    for (const controller of controllers) if (controller?.host) hosts.add(controller.host);
    return {
      ...base,
      hosts: [...hosts].sort().map(host => {
        const declaration = this._capabilitiesForHost(host);
        return { host: declaration.host, metrics: declaration.metrics };
      }),
    };
  }
}

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
export { telemetryCapabilitiesFor } from './telemetry-capabilities.mjs';
export { METRIC_KEYS, CONTEXT_KEYS, UNIFIED_FIELDS } from './telemetry-capabilities.mjs';
