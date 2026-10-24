import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../src/bus.mjs';
import { createCodexHost } from '../src/hosts/codex.mjs';
import { createDshHost } from '../src/hosts/cli-hosts.mjs';
import { dshSessionEventFrame, observeTextStream } from '../src/hosts/dsh-telemetry-observer.mjs';
import { telemetryCapabilitiesFor, telemetryObservation } from '../src/telemetry.mjs';
import { startServer } from '../src/server.mjs';
import { confirmedGroup } from './helpers.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(fn) { const end = Date.now() + 3000; while (!fn()) { if (Date.now() > end) throw new Error('condition timed out'); await new Promise(resolve => setTimeout(resolve, 10)); } }

function fixture(t, run) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-telemetry-'));
  let counter = 0;
  const calls = [];
  const host = {
    telemetryCapabilities: telemetryCapabilitiesFor('codex'),
    async run(ctx) {
      calls.push(ctx);
      counter += 1;
      const nativeTurnId = `native-${counter}`;
      ctx.onSession(`session-${ctx.endpoint.id}`);
      ctx.onNativeTurn(nativeTurnId);
      if (run && ctx.endpoint.context !== 'profile') return run(ctx, { counter, nativeTurnId });
      emitDefault(ctx, counter, nativeTurnId);
      ctx.onAccepted();
      return 'ok';
    },
  };
  const bus = new Bus({ directory, hosts: new Map([['fake', host]]) });
  const group = confirmedGroup(bus, {
    name: 'telemetry-group',
    workspace: directory,
    lead: { name: 'lead', host: 'fake' },
    members: [{ name: 'one', host: 'fake' }, { name: 'two', host: 'fake' }],
  });
  const members = bus.members(group.id);
  t.after(async () => { if (!bus.closing) await bus.close(); rmSync(directory, { recursive: true, force: true }); });
  return { bus, group, members, directory, calls, host };
}

function emitDefault(ctx, counter, nativeTurnId, overrides = {}) {
  const base = 100 + counter * 10;
  ctx.onTelemetry(telemetryObservation({
    source: 'fake.usage',
    scope: 'turn',
    aggregation: 'delta',
    nativeTurnId,
    usage: {
      inputTokensTotal: base,
      uncachedInputTokens: base - 20,
      cacheReadTokens: 10,
      cacheWriteTokens: 10,
      outputTokens: 5,
      totalTokens: base + 5,
    },
    context: { lastRequestInputTokens: base, contextWindowTokens: 1000, model: { provider: 'fake', model: 'fake-model', source: 'fake.model', observedAt: new Date().toISOString() } },
    timing: { hostTurnWallMs: 30 },
    completeness: Object.fromEntries(['inputTokensTotal', 'uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'totalTokens', 'hostTurnWallMs'].map(field => [field, 'complete'])),
    attempt: { id: `attempt-${counter}`, state: 'succeeded' },
    ...overrides,
  }));
}

async function sendFrom(bus, from, to, text) {
  const endpoint = bus.store.endpoint(from.id, `pair:${to.id}`);
  await bus.tool(endpoint.id, endpoint.key, 'send', { to: to.id, text });
  await until(() => bus.running.size === 0);
}

function setupManagerFixture(t) {
  const base = fixture(t);
  const { bus, group, members } = base;
  const [, one, two] = members;
  const agentId = 'panel-manager';
  const now = '2026-01-01T00:00:00.000Z';
  bus.store.run(
    'INSERT INTO panel_agents(id,singleton,name,host,model_provider,model,reasoning_effort,created,updated) VALUES(?,?,?,?,?,?,?,?,?)',
    agentId, 1, 'Manager', 'fake', 'fake', 'fake-model', 'low', now, now,
  );
  const session = bus.store.panelSession(agentId, 'coordination', group.id);
  bus.store.run(
    `INSERT INTO team_lead_controllers(group_id,controller_kind,controller_id,state,original_lead_id,revision,updated)
     VALUES(?,'panel_agent',?,'active',?,1,?)
     ON CONFLICT(group_id) DO UPDATE SET controller_kind='panel_agent',controller_id=excluded.controller_id,state='active',original_lead_id=excluded.original_lead_id,revision=revision+1,updated=excluded.updated`,
    group.id, agentId, group.lead, now,
  );
  return { ...base, one, two, agentId, session };
}

function addPanelTurn(bus, { group, session, agentId, id, created, inputs = [], outputs = [] }) {
  bus.store.run(
    'INSERT INTO panel_turns(id,session_id,panel_agent_id,context,group_id,active_team_id,state,created,ended) VALUES(?,?,?,?,?,?,?,?,?)',
    id, session.id, agentId, 'coordination', group.id, null, 'completed', created, new Date(Date.parse(created) + 1000).toISOString(),
  );
  for (const [index, sender] of inputs.entries()) {
    const messageId = `${id}:input:${index}`;
    bus.store.run('INSERT INTO messages(id,group_id,sender,recipient,kind,text,reply_to,created) VALUES(?,?,?,?,?,?,?,?)',
      messageId, group.id, sender, agentId, 'send', 'private input', null, created);
    bus.store.run('INSERT INTO panel_turn_inputs(turn_id,message_id,ordinal) VALUES(?,?,?)', id, messageId, index);
  }
  for (const [index, recipient] of outputs.entries()) {
    const messageId = `${id}:output:${index}`;
    bus.store.run('INSERT INTO messages(id,group_id,sender,recipient,kind,text,reply_to,created) VALUES(?,?,?,?,?,?,?,?)',
      messageId, group.id, agentId, recipient, 'send', 'private body must not leak', null, created);
    bus.store.run('INSERT INTO panel_message_origins(message_id,turn_id,event_seq,call_id,native_call_id) VALUES(?,?,?,?,?)',
      messageId, id, null, `${id}:call:${index}`, null);
  }
  bus.telemetry.record({
    groupId: group.id,
    executorKind: 'panel_agent',
    executorId: agentId,
    endpointId: session.id,
    sessionKey: 'panel',
    turnId: id,
    turnKind: 'panel',
    host: 'fake',
    hostSessionNamespace: 'fake:panel',
    context: 'panel-coordination',
    observation: telemetryObservation({
      source: 'fake.usage', scope: 'turn', aggregation: 'delta', nativeTurnId: `native-${id}`,
      usage: { inputTokensTotal: 100, uncachedInputTokens: 80, cacheReadTokens: 10, cacheWriteTokens: 10, outputTokens: 10, totalTokens: 110 },
      context: { lastRequestInputTokens: 100, contextWindowTokens: 1000, model: { provider: 'fake', model: 'fake-model', source: 'fake.model', observedAt: created } },
      timing: { hostTurnWallMs: 30 },
      completeness: Object.fromEntries(['inputTokensTotal','uncachedInputTokens','cacheReadTokens','cacheWriteTokens','outputTokens','totalTokens','hostTurnWallMs'].map(field => [field, 'complete'])),
      attempt: { id: `${id}:attempt`, state: 'succeeded' },
    }),
  });
}

test('conversation exposes per-executor attribution, context reference, sessions, and no zero fill', async t => {
  const { bus, group, members } = fixture(t);
  const [, one, two] = members;
  await until(() => bus.running.size === 0);
  await sendFrom(bus, one, two, 'hello two');
  await sendFrom(bus, two, one, 'hello one');
  const conversation = bus.telemetryConversation(group.id, one.id, two.id);
  assert.equal(conversation.readOnly, true);
  assert.equal(conversation.schemaVersion, 1);
  assert.deepEqual(conversation.conversation.participantIds, [one.id, two.id]);
  assert.equal(conversation.executors.length, 2);
  const oneExecutor = conversation.executors.find(executor => executor.executor.memberId === one.id);
  const twoExecutor = conversation.executors.find(executor => executor.executor.memberId === two.id);
  assert.ok(oneExecutor.totals.inputTokensTotal.value > 0);
  assert.ok(twoExecutor.totals.inputTokensTotal.value > 0);
  for (const executor of conversation.executors) {
    for (const metricValue of [...Object.values(executor.totals), ...Object.values(executor.contextReference).filter(value => value && typeof value === 'object' && 'quality' in value)]) {
      if (metricValue.quality === 'derived') assert.ok(metricValue.formula, 'derived metrics must keep a formula');
    }
  }
  for (const batch of conversation.batches) {
    for (const metricValue of [...Object.values(batch.metrics), ...Object.values(batch.contextReference).filter(value => value && typeof value === 'object' && 'quality' in value)]) {
      if (metricValue.quality === 'derived') assert.ok(metricValue.formula, 'derived metrics must keep a formula');
    }
  }
  assert.equal(oneExecutor.contextReference.contextWindowTokens.value, 1000);
  assert.ok(oneExecutor.contextReference.lastRequestInputRatio.value > 0);
  assert.equal(oneExecutor.physicalSessions.length, 1);
  assert.equal(oneExecutor.physicalSessions[0].consumption.inputTokensTotal.value, oneExecutor.totals.inputTokensTotal.value);
  assert.ok(oneExecutor.physicalSessions[0].status === 'active');
  for (const batch of conversation.batches) {
    assert.ok(batch.inputBatch.messages.length >= 1);
    assert.equal(batch.inputBatch.allocation, 'whole_to_executor');
    assert.match(batch.batchId, /^batch:/);
    assert.equal(batch.physicalSession.context, 'pair');
    assert.ok(batch.physicalSession.peer);
  }
  const caps = bus.telemetryCapabilities(group.id);
  assert.equal(caps.readOnly, true);
  assert.equal(caps.hosts.length, 1);
  assert.equal(Object.keys(caps.hosts[0].metrics).length, 12);
  assert.equal(caps.hosts[0].metrics.inputTokensTotal.capability, 'direct');
});

test('context ratio requires the same model route', async t => {
  let runIndex = 0;
  const { bus, group, members } = fixture(t, (ctx, { nativeTurnId }) => {
    runIndex += 1;
    const current = runIndex;
    const model = { provider: 'fake', model: current === 1 ? 'model-a' : 'model-b', source: 'fake.model', observedAt: new Date().toISOString() };
    ctx.onTelemetry(telemetryObservation({
      source: 'fake.request',
      scope: 'request',
      aggregation: 'snapshot',
      nativeTurnId,
      context: { lastRequestInputTokens: 100, model },
      quality: { lastRequestInputTokens: 'host_reported' },
      completeness: { lastRequestInputTokens: 'complete' },
    }));
    ctx.onTelemetry(telemetryObservation({
      source: 'fake.window',
      scope: 'request',
      aggregation: 'snapshot',
      nativeTurnId,
      context: { contextWindowTokens: 1000, model: current === 1 ? { ...model, model: 'model-c' } : model },
      quality: { contextWindowTokens: 'host_reported' },
      completeness: { contextWindowTokens: 'complete' },
    }));
    ctx.onAccepted();
    return 'ok';
  });
  const [lead, one] = members;
  await until(() => bus.running.size === 0);
  await sendFrom(bus, lead, one, 'mismatch route');
  await sendFrom(bus, lead, one, 'matched route');
  const result = bus.telemetryConversation(group.id, lead.id, one.id);
  const [mismatch, matched] = result.batches;
  assert.equal(mismatch.contextReference.lastRequestInputRatio.value, null);
  assert.equal(mismatch.contextReference.lastRequestInputRatio.quality, 'unknown');
  assert.equal(mismatch.contextReference.lastRequestInputRatio.missingReason, 'scope_mismatch');
  assert.equal(mismatch.contextReference.model, null);
  assert.equal(matched.contextReference.lastRequestInputRatio.value, 0.1);
  assert.equal(matched.contextReference.lastRequestInputRatio.formula, 'lastRequestInputTokens / contextWindowTokens');
  assert.equal(matched.contextReference.model.model, 'model-b');
  for (const batch of result.batches) {
    for (const metricValue of Object.values(batch.metrics)) {
      if (metricValue.quality === 'derived') assert.ok(metricValue.formula, `${batch.batchId} derived metric requires formula`);
    }
  }
});

test('missing metrics stay null with a reason and explicit zero remains zero', async t => {
  const { bus, group, members } = fixture(t, (ctx, { counter, nativeTurnId }) => {
    ctx.onTelemetry(telemetryObservation({
      source: 'fake.partial',
      scope: 'turn',
      aggregation: 'delta',
      nativeTurnId,
      usage: { inputTokensTotal: 400, cacheReadTokens: 0 },
      context: { lastRequestInputTokens: 400 },
      completeness: { inputTokensTotal: 'partial', cacheReadTokens: 'complete' },
      attempt: { id: `attempt-${counter}`, state: 'failed' },
    }));
    ctx.onAccepted();
    return 'ok';
  });
  const [lead, one] = members;
  await until(() => bus.running.size === 0);
  await sendFrom(bus, lead, one, 'partial');
  const result = bus.telemetryConversation(group.id, lead.id, one.id);
  const batch = result.batches[0];
  assert.equal(batch.metrics.inputTokensTotal.value, 400);
  assert.equal(batch.metrics.cacheReadTokens.value, 0);
  assert.equal(batch.metrics.outputTokens.value, null);
  assert.notEqual(batch.metrics.outputTokens.value, 0);
  assert.ok(batch.metrics.outputTokens.missingReason);
  assert.equal(batch.metrics.totalTokens.value, null);
  assert.equal(batch.completeness, 'partial');
});

test('duplicate snapshots update one observation and restored old native turns route to their original turn', async t => {
  const { bus, group, members } = fixture(t);
  const [lead, one] = members;
  await until(() => bus.running.size === 0);
  await sendFrom(bus, lead, one, 'first');
  const firstResult = bus.telemetryConversation(group.id, lead.id, one.id);
  const firstBatch = firstResult.batches[0];
  const firstRef = bus.store.get('SELECT ref FROM native_turn_refs WHERE turn_id=? ORDER BY rowid LIMIT 1', firstBatch.frameworkTurnId)?.ref;
  assert.ok(firstRef);
  await sendFrom(bus, lead, one, 'second');
  const beforeDuplicate = bus.telemetryConversation(group.id, lead.id, one.id).batches.length;
  for (let i = 0; i < 2; i += 1) {
    bus.telemetry.record({
      groupId: group.id,
      executorKind: 'member',
      executorId: firstBatch.executor.memberId,
      endpointId: firstBatch.physicalSession.endpointId,
      sessionKey: firstBatch.physicalSession.sessionKey,
      turnId: firstBatch.frameworkTurnId,
      turnKind: 'member',
      host: 'fake',
      hostSessionId: firstBatch.physicalSession.hostSessionId,
      observation: telemetryObservation({
        source: 'fake.old',
        scope: 'turn',
        aggregation: 'delta',
        nativeTurnId: firstRef,
        usage: { inputTokensTotal: 777, outputTokens: 1, totalTokens: 778 },
        attempt: { id: 'old-attempt', state: 'succeeded' },
      }),
    });
  }
  const oldRows = bus.store.all("SELECT turn_id FROM telemetry_observations WHERE group_id=? AND source='fake.old'", group.id);
  assert.equal(oldRows.length, 1);
  assert.equal(oldRows[0].turn_id, firstBatch.frameworkTurnId);
  const result = bus.telemetryConversation(group.id, lead.id, one.id);
  assert.equal(result.batches.length, beforeDuplicate);
  assert.equal(result.batches.find(batch => batch.batchId === firstBatch.batchId).metrics.inputTokensTotal.value, 777);
});

test('context ratio is null when the model route is unknown', async t => {
  const { bus, group, members } = fixture(t, (ctx, { counter, nativeTurnId }) => {
    emitDefault(ctx, counter, nativeTurnId);
    ctx.onTelemetry(telemetryObservation({
      source: 'fake.context.no-model', scope: 'request', aggregation: 'snapshot', nativeTurnId,
      context: { lastRequestInputTokens: 100, contextWindowTokens: 1000 },
    }));
    ctx.onAccepted();
    return 'ok';
  });
  const [lead, one] = members;
  await until(() => bus.running.size === 0);
  await sendFrom(bus, lead, one, 'unknown route');
  const batch = bus.telemetryConversation(group.id, lead.id, one.id).batches[0];
  assert.equal(batch.contextReference.lastRequestInputRatio.value, null);
  assert.equal(batch.contextReference.lastRequestInputRatio.quality, 'unknown');
  assert.equal(batch.contextReference.lastRequestInputRatio.missingReason, 'scope_mismatch');
  assert.equal(batch.contextReference.model, null);
});

test('context ratio is withheld unless input and window samples share the same model route', async t => {
  const { bus, group, members } = fixture(t, (ctx, { counter, nativeTurnId }) => {
    emitDefault(ctx, counter, nativeTurnId);
    ctx.onTelemetry(telemetryObservation({
      source: 'fake.context.input', scope: 'request', aggregation: 'snapshot', nativeTurnId,
      context: { lastRequestInputTokens: 100, model: { provider: 'p', model: 'route-a', source: 'fake', observedAt: new Date().toISOString() } },
    }));
    ctx.onTelemetry(telemetryObservation({
      source: 'fake.context.window', scope: 'request', aggregation: 'snapshot', nativeTurnId,
      context: { contextWindowTokens: 1000, model: { provider: 'p', model: 'route-b', source: 'fake', observedAt: new Date().toISOString() } },
    }));
    ctx.onAccepted();
    return 'ok';
  });
  const [lead, one] = members;
  await until(() => bus.running.size === 0);
  await sendFrom(bus, lead, one, 'route mismatch');
  const batch = bus.telemetryConversation(group.id, lead.id, one.id).batches[0];
  assert.equal(batch.contextReference.lastRequestInputRatio.value, null);
  assert.equal(batch.contextReference.lastRequestInputRatio.quality, 'unknown');
  assert.equal(batch.contextReference.lastRequestInputRatio.missingReason, 'scope_mismatch');
  assert.equal(batch.contextReference.model, null);
});

test('session reset starts a new physical session and does not carry the old baseline', async t => {
  const { bus, group, members } = fixture(t);
  const [lead, one] = members;
  await until(() => bus.running.size === 0);
  const endpoint = bus.store.endpoint(one.id, `pair:${lead.id}`);
  await sendFrom(bus, lead, one, 'before reset');
  const before = bus.telemetryMembers(group.id).members.find(member => member.executor.memberId === one.id);
  assert.equal(before.physicalSessionCount, 1);
  bus.resetSession(endpoint.id, 'telemetry reset test');
  await sendFrom(bus, lead, one, 'after reset');
  const after = bus.telemetryMembers(group.id).members.find(member => member.executor.memberId === one.id);
  assert.equal(after.physicalSessionCount, 2);
  assert.equal(after.physicalSessions.filter(session => session.status === 'reset').length, 1);
  assert.ok(after.physicalSessions.some(session => session.status === 'active'));
  assert.deepEqual(new Set(after.physicalSessions.map(session => session.instanceId)).size, 2);
});

test('merged delivery is counted once and excluded from single-source subtotals', async t => {
  let release;
  let blocked = false;
  const { bus, group, members } = fixture(t, (ctx, { counter, nativeTurnId }) => {
    emitDefault(ctx, counter, nativeTurnId);
    ctx.onAccepted();
    if (!blocked) {
      blocked = true;
      return new Promise(resolve => { release = () => resolve('ok'); });
    }
    return 'ok';
  });
  const [lead, one, two] = members;
  await until(() => bus.running.size === 0);
  const leadEndpoint = bus.store.endpoint(lead.id, 'coordination');
  const oneEndpoint = bus.store.endpoint(one.id, `pair:${lead.id}`);
  const twoEndpoint = bus.store.endpoint(two.id, `pair:${lead.id}`);
  await bus.tool(oneEndpoint.id, oneEndpoint.key, 'send', { to: lead.id, text: 'running' });
  await until(() => bus.running.size >= 1);
  await bus.tool(oneEndpoint.id, oneEndpoint.key, 'send', { to: lead.id, text: 'queued one' });
  await bus.tool(twoEndpoint.id, twoEndpoint.key, 'send', { to: lead.id, text: 'queued two' });
  release();
  await until(() => bus.running.size === 0);
  const coordination = bus.telemetryCoordination(group.id);
  const shared = coordination.batches.find(batch => batch.inputBatch.merge.sharedSources);
  assert.ok(shared, 'expected a merged delivery batch');
  assert.equal(shared.inputBatch.merge.merged, true);
  assert.equal(shared.inputBatch.merge.countedOnce, true);
  assert.equal(shared.inputBatch.merge.splitBySource, false);
  assert.equal(shared.inputBatch.merge.exclusiveSubtotal, false);
  assert.equal(shared.inputBatch.sourceActors.length, 2);
  assert.ok(coordination.summary.sharedSourceBatchIds.includes(shared.batchId));
  assert.ok(coordination.summary.mergedBatchIds.includes(shared.batchId));
  assert.ok(!coordination.summary.singleSourceBatchIds.includes(shared.batchId));
  assert.equal(shared.physicalSession.context, 'coordination');
  assert.equal(shared.physicalSession.peer, null);
  for (const subtotal of coordination.summary.sourceSubtotals) {
    assert.ok(!subtotal.includedBatchIds.includes(shared.batchId));
    assert.ok(subtotal.excludedMergedBatchIds.includes(shared.batchId) || !subtotal.includedBatchIds.length);
  }
  const totalBatches = coordination.batches.length;
  assert.equal(coordination.summary.coverage.batchCount, totalBatches);
  assert.ok(leadEndpoint.id);
});

test('a merged batch from one source is still excluded from single-source subtotals', async t => {
  let release;
  let blocked = false;
  const { bus, group, members } = fixture(t, (ctx, { counter, nativeTurnId }) => {
    emitDefault(ctx, counter, nativeTurnId);
    ctx.onAccepted();
    if (!blocked) {
      blocked = true;
      return new Promise(resolve => { release = () => resolve('ok'); });
    }
    return 'ok';
  });
  const [lead, one] = members;
  await until(() => bus.running.size === 0);
  const oneEndpoint = bus.store.endpoint(one.id, `pair:${lead.id}`);
  await bus.tool(oneEndpoint.id, oneEndpoint.key, 'send', { to: lead.id, text: 'running' });
  await until(() => bus.running.size >= 1);
  await bus.tool(oneEndpoint.id, oneEndpoint.key, 'send', { to: lead.id, text: 'queued one' });
  await bus.tool(oneEndpoint.id, oneEndpoint.key, 'send', { to: lead.id, text: 'queued two' });
  release();
  await until(() => bus.running.size === 0);
  const coordination = bus.telemetryCoordination(group.id);
  const merged = coordination.batches.find(batch => batch.inputBatch.merge.merged && !batch.inputBatch.merge.sharedSources);
  assert.ok(merged, 'expected a same-source merged batch');
  assert.ok(coordination.summary.mergedBatchIds.includes(merged.batchId));
  assert.ok(!coordination.summary.singleSourceBatchIds.includes(merged.batchId));
  for (const subtotal of coordination.summary.sourceSubtotals) {
    assert.ok(!subtotal.includedBatchIds.includes(merged.batchId));
  }
});

test('pagination only pages batches while totals and summary cover the full range', async t => {
  const { bus, group, members } = fixture(t);
  const [lead, one] = members;
  await until(() => bus.running.size === 0);
  for (let i = 0; i < 4; i += 1) await sendFrom(bus, lead, one, `page ${i}`);
  const full = bus.telemetryConversation(group.id, lead.id, one.id);
  const page = bus.telemetryConversation(group.id, lead.id, one.id, { limit: 1 });
  assert.equal(page.batches.length, 1);
  assert.ok(page.nextCursor);
  assert.deepEqual(page.summary.executorTotals, full.summary.executorTotals);
  const second = bus.telemetryConversation(group.id, lead.id, one.id, { limit: 1, cursor: page.nextCursor });
  assert.equal(second.batches.length, 1);
  assert.notEqual(second.batches[0].batchId, page.batches[0].batchId);
});


test('multi-step deltas sum once and a failed attempt keeps its own partial metrics', async t => {
  const { bus, group, members } = fixture(t, (ctx, { nativeTurnId }) => {
    ctx.onTelemetry(telemetryObservation({
      source: 'fake.step', scope: 'step', aggregation: 'delta', nativeTurnId, stepId: '1',
      usage: { inputTokensTotal: 100, outputTokens: 2, totalTokens: 102 },
      completeness: { inputTokensTotal: 'complete', outputTokens: 'complete', totalTokens: 'complete' },
      attempt: { id: 'attempt-a', state: 'succeeded' },
    }));
    ctx.onTelemetry(telemetryObservation({
      source: 'fake.step', scope: 'step', aggregation: 'delta', nativeTurnId, stepId: '2',
      usage: { inputTokensTotal: 50, outputTokens: 1, totalTokens: 51 },
      completeness: { inputTokensTotal: 'complete', outputTokens: 'complete', totalTokens: 'complete' },
      attempt: { id: 'attempt-a', state: 'succeeded' },
    }));
    ctx.onTelemetry(telemetryObservation({
      source: 'fake.step', scope: 'step', aggregation: 'delta', nativeTurnId, stepId: '3',
      usage: { inputTokensTotal: 30, outputTokens: null },
      completeness: { inputTokensTotal: 'partial', outputTokens: 'unknown' },
      attempt: { id: 'attempt-b', state: 'failed' },
      anomalies: [{ code: 'anomaly', fields: ['outputTokens'], detail: '重试部分用量', observedAt: new Date().toISOString(), raw: { outputTokens: null } }],
    }));
    ctx.onAccepted();
    return 'ok';
  });
  const [lead, one] = members;
  await until(() => bus.running.size === 0);
  await sendFrom(bus, lead, one, 'steps');
  const batch = bus.telemetryConversation(group.id, lead.id, one.id).batches[0];
  assert.equal(batch.metrics.inputTokensTotal.value, 180);
  assert.equal(batch.metrics.outputTokens.value, 3);
  assert.equal(batch.metrics.totalTokens.value, 183);
  assert.equal(batch.metrics.outputTokens.completeness, 'partial');
  assert.equal(batch.completeness, 'partial');
  assert.equal(batch.attempts.length, 2);
  assert.equal(batch.attempts.find(attempt => attempt.attemptId === 'attempt-a').metrics.inputTokensTotal.value, 150);
  assert.equal(batch.attempts.find(attempt => attempt.attemptId === 'attempt-b').state, 'failed');
  assert.ok(batch.attempts.find(attempt => attempt.attemptId === 'attempt-b').metrics.inputTokensTotal.value === 30);
  assert.ok(batch.anomalies.length >= 1);
});

test('multi-bucket sums are declared derived and direct fields stay direct', () => {
  const claude = telemetryCapabilitiesFor('claude').metrics;
  assert.equal(claude.inputTokensTotal.capability, 'derived');
  assert.equal(claude.lastRequestInputTokens.capability, 'derived');
  assert.equal(claude.totalTokens.capability, 'derived');
  assert.equal(claude.cacheReadTokens.capability, 'direct');
  assert.equal(claude.outputTokens.capability, 'direct');
  const dsh = telemetryCapabilitiesFor('dsh').metrics;
  assert.equal(dsh.inputTokensTotal.capability, 'derived');
  assert.equal(dsh.totalTokens.capability, 'direct');
  assert.equal(dsh.lastRequestInputTokens.capability, 'direct');
  const codex = telemetryCapabilitiesFor('codex').metrics;
  assert.equal(codex.inputTokensTotal.capability, 'direct');
  assert.equal(codex.uncachedInputTokens.capability, 'derived');
  for (const host of [claude, dsh, codex]) {
    assert.equal(Object.keys(host).length, 12);
    for (const field of Object.values(host)) {
      assert.ok(['direct', 'derived', 'unsupported'].includes(field.capability));
      assert.ok(Array.isArray(field.requires));
    }
  }
});

test('telemetry HTTP routes are read-only JSON and errors use JSON {error}', async t => {
  const { bus, group, members, directory } = fixture(t);
  const [, one, two] = members;
  await until(() => bus.running.size === 0);
  await sendFrom(bus, one, two, 'http');
  await bus.close();
  const server = await startServer({ directory, hosts: new Map([['fake', { async run() { return 'unused'; } }]]) });
  t.after(() => server.close());
  const ok = await fetch(`${server.url}api/telemetry/conversation?group=${group.id}&member=${one.id}&peer=${two.id}`);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type'), /application\/json/);
  const body = await ok.json();
  assert.equal(body.readOnly, true);
  assert.equal(body.executors.length, 2);
  const missing = await fetch(`${server.url}api/telemetry/conversation?group=${group.id}&member=missing&peer=${one.id}`);
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get('content-type'), /application\/json/);
  const failure = await missing.json();
  assert.equal(typeof failure.error, 'string');
  const capabilities = await fetch(`${server.url}api/telemetry/capabilities?group=${group.id}`);
  assert.equal(capabilities.status, 200);
  assert.equal((await capabilities.json()).hosts[0].host, 'fake');
});

test('manager conversation separates member and manager sides, covers output-only relevance, and pages one union', async t => {
  const { bus, group, one, two, agentId, session } = setupManagerFixture(t);
  const memberCreated = '2026-01-01T00:00:00.000Z';
  const memberEndpoint = bus.store.endpoint(one.id, `pair:${agentId}`, agentId);
  const memberTurnId = 'member-turn-1';
  bus.store.run('INSERT INTO turns(id,endpoint_id,session,created) VALUES(?,?,?,?)',
    memberTurnId, memberEndpoint.id, 'member-session', memberCreated);
  bus.store.run('INSERT INTO messages(id,group_id,sender,recipient,kind,text,reply_to,created) VALUES(?,?,?,?,?,?,?,?)',
    'member-input-1', group.id, one.id, agentId, 'send', 'private input', null, memberCreated);
  bus.store.run('INSERT INTO turn_inputs(turn_id,message_id,ordinal) VALUES(?,?,?)',
    memberTurnId, 'member-input-1', 0);
  bus.store.run("INSERT INTO runtime_attempts(turn_id,group_id,endpoint_id,state,policy,created,ended) VALUES(?,?,?,?,?,?,?)",
    memberTurnId, group.id, memberEndpoint.id, 'completed', '{}', memberCreated, memberCreated);
  bus.telemetry.record({
    groupId: group.id, executorKind: 'member', executorId: one.id, endpointId: memberEndpoint.id,
    sessionKey: 'member', turnId: memberTurnId, turnKind: 'member', host: 'fake',
    hostSessionNamespace: 'fake:member', context: `pair:${agentId}`,
    observation: telemetryObservation({
      source: 'fake.usage', scope: 'turn', aggregation: 'delta', nativeTurnId: 'native-member-1',
      usage: { inputTokensTotal: 400, uncachedInputTokens: 300, cacheReadTokens: 50, cacheWriteTokens: 50, outputTokens: 40, totalTokens: 440 },
      context: { lastRequestInputTokens: 400, contextWindowTokens: 1000, model: { provider: 'fake', model: 'fake-model', source: 'fake.model', observedAt: memberCreated } },
      timing: { hostTurnWallMs: 30 },
      completeness: Object.fromEntries(['inputTokensTotal','uncachedInputTokens','cacheReadTokens','cacheWriteTokens','outputTokens','totalTokens','hostTurnWallMs'].map(field => [field, 'complete'])),
      attempt: { id: 'member-attempt-1', state: 'succeeded' },
    }),
  });
  addPanelTurn(bus, {
    group, session, agentId, id: 'panel-turn-exclusive', created: '2026-01-01T00:01:00.000Z',
    inputs: [one.id], outputs: [one.id],
  });
  addPanelTurn(bus, {
    group, session, agentId, id: 'panel-turn-shared', created: '2026-01-01T00:02:00.000Z',
    outputs: [one.id, two.id],
  });
  addPanelTurn(bus, {
    group, session, agentId, id: 'panel-turn-irrelevant', created: '2026-01-01T00:03:00.000Z',
    inputs: [two.id], outputs: [two.id],
  });

  const response = bus.telemetryManagerConversation(group.id, one.id);
  assert.equal(response.readOnly, true);
  assert.equal(response.manager.kind, 'panel_agent');
  assert.equal(response.manager.memberId, agentId);
  assert.equal(response.member.memberId, one.id);
  assert.equal(response.memberSide.batchCount, 1);
  assert.equal(response.memberSide.totals.inputTokensTotal.value, 400);
  assert.equal(response.managerSide.batchCount, 2);
  assert.equal(response.managerSide.involvementTotals.inputTokensTotal.value, 200);
  assert.deepEqual(response.managerSide.involvedMemberIds, [one.id, two.id].sort());
  assert.equal(response.managerSide.exclusiveBatchIds.length, 1);
  assert.equal(response.managerSide.sharedBatchIds.length, 1);
  assert.equal(response.summary.memberBatchIds.length, 1);
  assert.equal(response.summary.managerBatchIds.length, 2);
  assert.equal(response.summary.exclusiveManagerBatchIds.length, 1);
  assert.equal(response.summary.sharedManagerBatchIds.length, 1);
  assert.equal(new Set(response.batches.map(batch => batch.batchId)).size, response.batches.length);
  assert.deepEqual(response.batches.map(batch => batch.side), ['member', 'manager', 'manager']);

  const shared = response.batches.find(batch => batch.involvement?.sharedWithOtherMembers);
  assert.ok(shared);
  assert.equal(shared.side, 'manager');
  assert.equal(shared.involvement.exclusiveToMember, false);
  assert.deepEqual(shared.involvement.involvedMemberIds, [one.id, two.id].sort());
  assert.equal(shared.outgoingMessages.length, 2);
  assert.ok(shared.outgoingMessages.every(message => message.recipientKind === 'member' && !('text' in message) && !('body' in message)));

  const memberBatch = response.batches.find(batch => batch.side === 'member');
  assert.equal(memberBatch.involvement, null);
  assert.deepEqual(memberBatch.outgoingMessages, []);
  assert.equal(response.memberSide.physicalSessions.length, 1);
  assert.equal(response.memberSide.physicalSessions[0].consumption.inputTokensTotal.value, 400);
  // Session cumulative includes all three manager turns; involvementTotals only includes two related turns.
  assert.equal(response.managerSide.physicalSessions.length, 1);
  assert.equal(response.managerSide.physicalSessions[0].consumption.inputTokensTotal.value, 300);
  assert.ok(response.managerSide.physicalSessions[0].consumption.inputTokensTotal.value > response.managerSide.involvementTotals.inputTokensTotal.value);

  const first = bus.telemetryManagerConversation(group.id, one.id, { limit: 1 });
  assert.equal(first.batches.length, 1);
  assert.ok(first.nextCursor);
  const second = bus.telemetryManagerConversation(group.id, one.id, { cursor: first.nextCursor, limit: 1 });
  assert.equal(second.batches.length, 1);
  assert.equal(second.memberSide.totals.inputTokensTotal.value, response.memberSide.totals.inputTokensTotal.value);
  assert.equal(second.managerSide.involvementTotals.inputTokensTotal.value, response.managerSide.involvementTotals.inputTokensTotal.value);
  assert.deepEqual(second.summary, response.summary);
  assert.notEqual(first.batches[0].batchId, second.batches[0].batchId);

  const ranged = bus.telemetryManagerConversation(group.id, one.id, { from: '2026-01-01T00:01:30.000Z', to: '2026-01-01T00:03:30.000Z' });
  assert.equal(ranged.memberSide.batchCount, 0);
  assert.equal(ranged.managerSide.batchCount, 1);
  assert.deepEqual(ranged.summary.managerBatchIds, [shared.batchId]);

  assert.throws(() => bus.telemetryManagerConversation(group.id, one.id, { limit: 0 }), error => error.status === 400);
  assert.throws(() => bus.telemetryManagerConversation(group.id, one.id, { cursor: 'not-a-cursor' }), error => error.status === 400);
  assert.throws(() => bus.telemetryManagerConversation(group.id, 'missing-member'), error => error.status === 404);
});

test('manager conversation keeps merged shared manager batches whole and returns fixed empty shapes', async t => {
  const { bus, group, members, one, two, agentId, session } = setupManagerFixture(t);
  addPanelTurn(bus, {
    group, session, agentId, id: 'panel-turn-merged', created: '2026-01-01T00:01:00.000Z',
    inputs: [one.id, two.id], outputs: [one.id, two.id],
  });
  const response = bus.telemetryManagerConversation(group.id, one.id);
  assert.equal(response.managerSide.batchCount, 1);
  assert.equal(response.managerSide.involvementTotals.inputTokensTotal.value, 100);
  const batch = response.batches[0];
  assert.equal(batch.side, 'manager');
  assert.equal(batch.inputBatch.merge.merged, true);
  assert.equal(batch.inputBatch.merge.sharedSources, true);
  assert.equal(batch.inputBatch.merge.countedOnce, true);
  assert.equal(batch.inputBatch.merge.splitBySource, false);
  assert.equal(batch.inputBatch.merge.exclusiveSubtotal, false);
  assert.equal(batch.involvement.exclusiveToMember, false);
  assert.equal(batch.involvement.sharedWithOtherMembers, true);
  assert.deepEqual(batch.involvement.involvedMemberIds, [one.id, two.id].sort());
  assert.equal(batch.outgoingMessages.length, 2);

  const unrelated = members[0];
  const empty = bus.telemetryManagerConversation(group.id, unrelated.id);
  assert.equal(empty.memberSide.batchCount, 0);
  assert.equal(empty.managerSide.batchCount, 0);
  for (const totals of [empty.memberSide.totals, empty.managerSide.involvementTotals]) {
    assert.equal(Object.keys(totals).length, 9);
    for (const metricValue of Object.values(totals)) {
      assert.equal(metricValue.value, null);
      assert.equal(metricValue.quality, 'unknown');
      assert.ok(metricValue.missingReason);
    }
  }
  assert.deepEqual(empty.memberSide.physicalSessions, []);
  assert.deepEqual(empty.managerSide.physicalSessions, []);
  assert.ok(empty.memberSide.coverage.reasons.includes('no_observations'));
  assert.ok(empty.managerSide.coverage.reasons.includes('no_observations'));
  assert.equal(empty.memberSide.contextReference.model, null);
  assert.equal(empty.managerSide.contextReference.model, null);
  assert.equal(empty.batches.length, 0);
  assert.equal(empty.nextCursor, null);
});

test('manager conversation HTTP route is read-only JSON with manager fields and JSON errors', async t => {
  const { bus, group, one, agentId, session, directory } = setupManagerFixture(t);
  addPanelTurn(bus, {
    group, session, agentId, id: 'panel-turn-http', created: '2026-01-01T00:01:00.000Z',
    inputs: [one.id], outputs: [one.id],
  });
  await bus.close();
  const server = await startServer({ directory, hosts: new Map([['fake', { async run() { return 'unused'; } }]]) });
  t.after(() => server.close());
  const base = server.url;
  const ok = await fetch(`${base}api/telemetry/manager-conversation?group=${group.id}&member=${one.id}`);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type'), /application\/json/);
  const body = await ok.json();
  assert.equal(body.readOnly, true);
  assert.equal(body.manager.kind, 'panel_agent');
  assert.ok(body.memberSide.batchCount >= 0);
  assert.equal(body.managerSide.batchCount, 1);
  assert.equal(body.managerSide.involvementTotals.inputTokensTotal.value, 100);
  const missing = await fetch(`${base}api/telemetry/manager-conversation?group=${group.id}&member=missing`);
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get('content-type'), /application\/json/);
  assert.equal(typeof (await missing.json()).error, 'string');
  const bad = await fetch(`${base}api/telemetry/manager-conversation?group=${group.id}&member=${one.id}&limit=0`);
  assert.equal(bad.status, 400);
  assert.match(bad.headers.get('content-type'), /application\/json/);
});

test('manager conversation rejects a non-Panel main agent', async t => {
  const { bus, group, members } = fixture(t);
  const [, one] = members;
  assert.throws(() => bus.telemetryManagerConversation(group.id, one.id), error => error.status === 400);
});

test('Codex adapter emits turn deltas and host timing through onTelemetry', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-codex-telemetry-'));
  const fake = join(directory, 'fake-codex.mjs');
  writeFileSync(fake, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
createInterface({ input: process.stdin }).on('line', line => {
  const row = JSON.parse(line);
  if (row.method === 'initialize') return send({ id: row.id, result: {} });
  if (row.method === 'config/read') return send({ id: row.id, result: { config: { mcp_servers: {} } } });
  if (row.method === 'thread/start') return send({ id: row.id, result: { thread: { id: 'thread-1' }, model: 'test', modelProvider: 'test', reasoningEffort: 'low' } });
  if (row.method === 'turn/start') {
    send({ id: row.id, result: { turn: { id: 'turn-1' } } });
    setImmediate(() => {
      const tokenUsage = { total: { totalTokens: 130, inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: 5, outputTokens: 5, reasoningOutputTokens: 0 }, last: { totalTokens: 130, inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: 5, outputTokens: 5, reasoningOutputTokens: 0 }, modelContextWindow: 1000 };
      send({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', turnId: 'turn-1', tokenUsage } });
      send({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', turnId: 'turn-1', tokenUsage } });
      send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: '已' } });
      send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: '完成' } });
      send({ method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'tool-1', type: 'dynamicToolCall', tool: 'agent_team_send', arguments: { to: 'peer', text: 'tool message' } } } });
      send({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'message-1', type: 'agentMessage', text: '已完成' } } });
      send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', durationMs: 700 } } });
    });
    return;
  }
});
`);
  chmodSync(fake, 0o700);
  const host = createCodexHost({ command: fake });
  t.after(async () => { await host.close(); rmSync(directory, { recursive: true, force: true }); });
  const telemetry = [], deltas = [], toolDeltas = [];
  const output = await host.run({
    endpoint: { id: 'endpoint', key: 'key', session: null },
    turnId: 'framework-turn', workspace: directory, prompt: 'metrics', instructions: 'follow',
    tools: [], policy: { mode: 'communication', allowShell: false }, previousPolicy: null,
    signal: new AbortController().signal,
    onSession() {}, onAccepted() {}, onNativeTurn() {}, onModel() {}, onPolicy() {}, onEvent() {},
    onTextDelta(text, metadata) { deltas.push({ text, metadata }); },
    onToolCallDelta(delta) { toolDeltas.push(delta); },
    onTelemetry(observation) { telemetry.push(observation); },
  });
  assert.equal(output, '已完成');
  assert.deepEqual(deltas.map(item => item.text), ['已', '完成']);
  assert.equal(deltas[0].metadata.itemId, 'message-1');
  assert.equal(toolDeltas[0].name, 'send');
  assert.deepEqual(JSON.parse(toolDeltas[0].argumentsDelta), {
    to: 'peer',
    text: 'tool message',
  });
  const usage = telemetry.find(observation => observation.source === 'codex.thread_token_usage');
  assert.equal(usage.usage.inputTokensTotal, 100);
  assert.equal(usage.usage.uncachedInputTokens, 75);
  assert.equal(usage.usage.cacheReadTokens, 20);
  assert.equal(usage.usage.cacheWriteTokens, 5);
  assert.equal(usage.usage.outputTokens, 5);
  assert.ok(telemetry.filter(observation => observation.source === 'codex.thread_token_usage').length >= 1);
  assert.equal(telemetry.find(observation => observation.source === 'codex.turn_completed').timing.hostTurnWallMs, 700);
  assert.equal(host.telemetryCapabilities.metrics.inputTokensTotal.capability, 'direct');
  assert.equal(host.telemetryCapabilities.metrics.uncachedInputTokens.capability, 'derived');
});

test('DSH adapter consumes telemetry events and projections from its observer plugin', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-dsh-telemetry-'));
  const fake = join(directory, 'fake-dsh.mjs');
  writeFileSync(fake, `#!/usr/bin/env node
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
send({ type: 'session', sessionId: 'dsh-session-1' });
send({ type: 'assistant_delta', text: 'o', turn: 1, step: 1 });
send({ type: 'framework.telemetry.event', event: 'turn/start', at: 1000, turn: 1 });
send({ type: 'framework.telemetry.projection', key: 'contextPressure', value: { pressureTokens: 700, contextWindow: 1000 } });
send({ type: 'framework.telemetry.event', event: 'assistant/message', at: 1100, turn: 1, step: 1, usage: { inputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 0, outputTokens: 5, totalTokens: 125 } });
send({ type: 'framework.telemetry.event', event: 'turn/end', at: 1300, turn: 1, reason: 'completed' });
send({ type: 'assistant_delta', text: 'k', turn: 1, step: 1 });
send({ type: 'final', text: 'ok' });
send({ type: 'status', phase: 'turn_end', reason: { kind: 'completed' } });
`);
  chmodSync(fake, 0o700);
  const host = createDshHost({ command: fake, directory, socketPath: join(directory, 'unused.sock') });
  t.after(async () => { await host.close?.(); rmSync(directory, { recursive: true, force: true }); });
  const telemetry = [], deltas = [];
  const output = await host.run({
    endpoint: { id: 'endpoint', key: 'key', session: null },
    turnId: 'framework-turn', workspace: directory, prompt: 'metrics', instructions: 'follow',
    tools: [], policy: { mode: 'communication', allowShell: false }, previousPolicy: null,
    signal: new AbortController().signal,
    onSession() {}, onAccepted() {}, onNativeTurn() {}, onModel() {}, onPolicy() {}, onEvent() {},
    onTextDelta(text, metadata) { deltas.push({ text, metadata }); },
    onTelemetry(observation) { telemetry.push(observation); },
  });
  assert.equal(output, 'ok');
  assert.deepEqual(deltas.map(item => item.text), ['o', 'k']);
  assert.equal(deltas[0].metadata.nativeTurnId, '1');
  const usage = telemetry.find(observation => observation.source === 'dsh.assistant_message_usage');
  assert.equal(usage.usage.inputTokensTotal, 120);
  assert.equal(usage.usage.uncachedInputTokens, 100);
  assert.equal(usage.usage.cacheReadTokens, 20);
  assert.equal(usage.usage.outputTokens, 5);
  assert.equal(usage.quality.inputTokensTotal, 'derived');
  assert.equal(usage.quality.totalTokens, 'host_reported');
  const context = telemetry.find(observation => observation.source === 'dsh.context_pressure');
  assert.equal(context.context.lastRequestInputTokens, 700);
  assert.equal(context.context.contextWindowTokens, 1000);
  assert.equal(telemetry.find(observation => observation.source === 'dsh.turn_time').timing.hostTurnWallMs, 300);
  assert.equal(host.telemetryCapabilities.metrics.hostTurnWallMs.capability, 'direct');
  assert.equal(host.telemetryCapabilities.metrics.inputTokensTotal.capability, 'derived');
});

test('DSH observer forwards raw text chunks and deduplicates committed text in the adapter', async t => {
  assert.equal(dshSessionEventFrame({
    type: 'assistant/live-chunk',
    time: 100,
    data: { turn: 1, step: 2, chunk: { type: 'text-delta', index: 3, text: 'stream' } },
  }), null);
  async function* chunks() {
    yield { type: 'text-delta', index: 3, text: 'stream' };
    yield { type: 'reasoning-delta', index: 4, text: 'private reasoning' };
    yield {
      type: 'tool-call-delta',
      index: 5,
      id: 'tool-1',
      name: 'send',
      argumentsDelta: '{"to":"peer","text":"hello"}',
    };
  }
  const frames = [];
  for await (const _chunk of observeTextStream(chunks(), frame => frames.push(frame), {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
  })) {
    // Consume the wrapped iterator as the DSH loop would.
  }
  assert.deepEqual(frames, [
    {
      type: 'framework.text.delta',
      index: 3,
      text: 'stream',
      provider: 'deepseek-official',
      model: 'deepseek-flash',
    },
    {
      type: 'framework.tool.delta',
      callId: 'tool-1',
      name: 'send',
      index: 5,
      argumentsDelta: '{"to":"peer","text":"hello"}',
      provider: 'deepseek-official',
      model: 'deepseek-flash',
    },
  ]);

  const directory = mkdtempSync(join(tmpdir(), 'agent-dsh-live-stream-'));
  const fake = join(directory, 'fake-dsh.mjs');
  writeFileSync(fake, `#!/usr/bin/env node
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
send({ type: 'session', sessionId: 'dsh-session-live' });
send({ type: 'framework.text.delta', turn: 1, step: 1, text: 'live ' });
send({ type: 'framework.text.delta', turn: 1, step: 1, text: 'text' });
send({ type: 'framework.tool.delta', callId: 'tool-live', name: 'send', index: 1, argumentsDelta: '{"to":"peer","text":"he' });
send({ type: 'tool_call', callId: 'tool-live', tool: 'send', input: { to: 'peer', text: 'hello' } });
send({ type: 'text', text: 'live text' });
send({ type: 'final', text: 'live text' });
send({ type: 'status', phase: 'turn_end', reason: { kind: 'completed' } });
`);
  chmodSync(fake, 0o700);
  const host = createDshHost({ command: fake, directory, socketPath: join(directory, 'unused.sock') });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const deltas = [], toolDeltas = [];
  const output = await host.run({
    endpoint: { id: 'endpoint', key: 'key', session: null },
    turnId: 'framework-turn', workspace: directory, prompt: 'stream', instructions: 'follow',
    tools: [], policy: { mode: 'communication', allowShell: false }, previousPolicy: null,
    signal: new AbortController().signal,
    onSession() {}, onAccepted() {}, onNativeTurn() {}, onModel() {}, onPolicy() {}, onEvent() {},
    onTextDelta(text, metadata) { deltas.push({ text, metadata }); },
    onToolCallDelta(delta) { toolDeltas.push(delta); },
  });
  assert.equal(output, 'live text');
  assert.deepEqual(deltas.map(item => item.text), ['live ', 'text']);
  assert.deepEqual(toolDeltas.map(item => item.argumentsDelta), [
    '{"to":"peer","text":"he',
    '{"to":"peer","text":"hello"}',
  ]);
  assert.equal(toolDeltas[1].complete, true);
});
