import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../../bus.mjs';
import { startServer } from '../../server.mjs';
import { telemetryCapabilitiesFor, telemetryObservation } from '../../telemetry.mjs';
import { createTestGroup } from '../support/fixture.mjs';

const until = async fn => {
  for (let index = 0; index < 500; index += 1) {
    if (fn()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('condition timed out');
};

function seedComplete(usage, context, { source = 'fake.panel.usage', timing = { hostTurnWallMs: 40 }, incomplete = false } = {}) {
  return telemetryObservation({
    source,
    scope: 'turn',
    aggregation: 'delta',
    nativeTurnId: usage.nativeTurnId,
    usage: {
      inputTokensTotal: usage.inputTokensTotal,
      uncachedInputTokens: usage.inputTokensTotal - 10,
      cacheReadTokens: 10,
      cacheWriteTokens: 0,
      outputTokens: 5,
      totalTokens: usage.inputTokensTotal + 5,
    },
    context,
    timing,
    completeness: incomplete
      ? { inputTokensTotal: 'partial', cacheReadTokens: 'complete' }
      : {
          inputTokensTotal: 'complete', uncachedInputTokens: 'complete', cacheReadTokens: 'complete',
          cacheWriteTokens: 'complete', outputTokens: 'complete', totalTokens: 'complete', hostTurnWallMs: 'complete',
        },
    attempt: { id: `attempt-${usage.nativeTurnId}`, state: 'succeeded' },
  });
}

async function fixture(t) {
  const cleanup = [];
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-manager-conversation-'));
  const host = {
    telemetryCapabilities: telemetryCapabilitiesFor('codex'),
    async run(ctx) {
      ctx.onSession(ctx.endpoint.session ?? ctx.endpoint.id);
      ctx.onAccepted();
      return 'ok';
    },
  };
  const bus = new Bus({ directory, hosts: new Map([['fake', host]]) });
  const group = createTestGroup(bus, {
    name: 'manager-conversation-group',
    workspace: directory,
    lead: { name: 'lead', host: 'fake' },
    members: [{ name: 'one', host: 'fake' }, { name: 'two', host: 'fake' }],
  });
  await until(() => bus.running.size === 0);
  const [lead, one, two] = bus.members(group.id);
  const now = new Date().toISOString();
  const panelId = 'panel-agent-manager-test';
  bus.store.run(
    'INSERT INTO panel_agents(id,singleton,name,host,model_provider,model,reasoning_effort,created,updated) VALUES(?,1,?,?,?,?,?,?,?)',
    panelId, 'Panel Agent', 'fake', 'fake-provider', 'fake-model', 'low', now, now,
  );
  bus.store.run(
    `INSERT INTO team_lead_controllers(group_id,controller_kind,controller_id,state,original_lead_id,revision,updated)
     VALUES(?,'panel_agent',?,'active',?,1,?)
     ON CONFLICT(group_id) DO UPDATE SET controller_kind='panel_agent',controller_id=excluded.controller_id,
       state='active',original_lead_id=excluded.original_lead_id,revision=revision+1,updated=excluded.updated`,
    group.id, panelId, lead.id, now,
  );
  const session = bus.store.panelSession(panelId, 'coordination', group.id);
  let panelCounter = 0;
  let memberCounter = 0;

  const addPanelTurn = ({ startedAt, inputs = [], outputs = [], inputTokens = 100, model = 'fake-model', incomplete = false, partial = false }) => {
    panelCounter += 1;
    const turnId = `panel-conversation-turn-${panelCounter}`;
    bus.store.run(
      'INSERT INTO turns(id,conversation_id,executor_kind,executor_id,group_id,session,active_team_id,state,created) VALUES(?,?,?,?,?,?,?,?,?)',
      turnId, session.id, 'panel_agent', panelId, group.id, session.session ?? null, group.id, 'succeeded', startedAt,
    );
    inputs.forEach((input, index) => {
      const message = bus.store.append(group.id, input.sender, panelId, input.kind ?? 'send', input.text ?? `input ${index}`);
      bus.store.run('INSERT INTO turn_inputs VALUES(?,?,?)', turnId, message.id, index);
    });
    outputs.forEach((output, index) => {
      const message = bus.store.append(group.id, panelId, output.recipient, output.kind ?? 'send', output.text ?? `SECRET_BODY_${turnId}_${index}`);
      bus.store.run('INSERT INTO message_origins(message_id,turn_id,event_seq,call_id,native_call_id) VALUES(?,?,?,?,?)', message.id, turnId, null, `call-${turnId}-${index}`, null);
    });
    const context = model === null
      ? { lastRequestInputTokens: inputTokens, contextWindowTokens: 1000 }
      : { lastRequestInputTokens: inputTokens, contextWindowTokens: 1000, model: { provider: 'fake-provider', model, source: 'fake.model', observedAt: startedAt } };
    bus.telemetry.record({
      groupId: group.id,
      executorKind: 'panel_agent',
      executorId: panelId,
      endpointId: session.id,
      sessionKey: 'default',
      turnId,
      turnKind: 'panel',
      host: 'fake',
      hostSessionId: 'panel-thread',
      context: 'coordination',
      observation: partial
        ? telemetryObservation({
            source: 'fake.panel.usage',
            scope: 'turn',
            aggregation: 'delta',
            nativeTurnId: `native-${turnId}`,
            usage: { inputTokensTotal: inputTokens, cacheReadTokens: 10 },
            context,
            completeness: { inputTokensTotal: 'partial', cacheReadTokens: 'complete' },
            attempt: { id: `attempt-native-${turnId}`, state: 'failed' },
          })
        : seedComplete({ nativeTurnId: `native-${turnId}`, inputTokensTotal: inputTokens }, context, { incomplete }),
    });
    return turnId;
  };

  const addMemberPairTurn = ({ startedAt, inputTokens = 111, incomplete = false }) => {
    memberCounter += 1;
    const turnId = `member-pair-turn-${memberCounter}`;
    const endpoint = bus.store.endpoint(one.id, `pair:${panelId}`, panelId);
    bus.store.run('INSERT INTO turns(id,conversation_id,executor_kind,executor_id,group_id,session,state,created) VALUES(?,?,?,?,?,?,?,?)', turnId, endpoint.id, 'member', one.id, group.id, endpoint.session, 'completed', startedAt);
    const input = bus.store.append(group.id, panelId, one.id, 'send', 'pair input');
    bus.store.run('INSERT INTO turn_inputs VALUES(?,?,?)', turnId, input.id, 0);
    bus.telemetry.record({
      groupId: group.id,
      executorKind: 'member',
      executorId: one.id,
      endpointId: endpoint.id,
      sessionKey: 'default',
      turnId,
      turnKind: 'member',
      host: 'fake',
      hostSessionId: 'member-thread',
      context: endpoint.context,
      observation: seedComplete(
        { nativeTurnId: `native-${turnId}`, inputTokensTotal: inputTokens },
        {
          lastRequestInputTokens: inputTokens,
          contextWindowTokens: 1000,
          model: { provider: 'fake-provider', model: 'fake-model', source: 'fake.model', observedAt: startedAt },
        },
        { source: 'fake.member.usage', incomplete },
      ),
    });
    return { turnId, endpoint };
  };

  t.after(async () => {
    for (const close of cleanup) await close();
    if (!bus.closing) await bus.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { bus, group, lead, one, two, panelId, session, addPanelTurn, addMemberPairTurn, directory, cleanup };
}

test('manager-conversation separates member and manager sides, covers input and output involvement, and keeps shared batches whole', async t => {
  const { bus, group, lead, one, two, addPanelTurn, addMemberPairTurn } = await fixture(t);
  const memberTurn = addMemberPairTurn({ startedAt: '2026-10-23T10:00:00.000Z', inputTokens: 111 });
  const inputTurn = addPanelTurn({ startedAt: '2026-10-23T10:00:10.000Z', inputs: [{ sender: one.id }], outputs: [], inputTokens: 200 });
  const outputOnlyTurn = addPanelTurn({ startedAt: '2026-10-23T10:00:20.000Z', inputs: [], outputs: [{ recipient: one.id, kind: 'note' }], inputTokens: 300 });
  const sharedTurn = addPanelTurn({
    startedAt: '2026-10-23T10:00:30.000Z',
    inputs: [{ sender: one.id }, { sender: two.id }],
    outputs: [{ recipient: one.id }, { recipient: two.id }],
    inputTokens: 400,
  });
  const otherTurn = addPanelTurn({ startedAt: '2026-10-23T10:00:40.000Z', inputs: [{ sender: two.id }], outputs: [{ recipient: two.id }], inputTokens: 500 });
  const modelNullTurn = addPanelTurn({ startedAt: '2026-10-23T10:00:50.000Z', inputs: [{ sender: one.id }], outputs: [], inputTokens: 600, model: null });

  const response = bus.telemetryManagerConversation(group.id, one.id);
  assert.equal(response.readOnly, true);
  assert.equal(response.member.memberId, one.id);
  assert.equal(response.manager.kind, 'panel_agent');
  assert.deepEqual(response.summary.memberBatchIds, [memberTurn.turnId].map(id => `batch:${id}`));
  assert.deepEqual(response.summary.managerBatchIds.sort(), [inputTurn, outputOnlyTurn, sharedTurn, modelNullTurn].map(id => `batch:${id}`).sort());
  assert.deepEqual(response.summary.exclusiveManagerBatchIds.sort(), [inputTurn, outputOnlyTurn, modelNullTurn].map(id => `batch:${id}`).sort());
  assert.deepEqual(response.summary.sharedManagerBatchIds, [`batch:${sharedTurn}`]);
  assert.deepEqual(response.managerSide.involvedMemberIds, [one.id, two.id].sort());
  assert.equal(response.managerSide.batchCount, 4);
  assert.equal(response.memberSide.batchCount, 1);
  assert.equal(response.memberSide.totals.inputTokensTotal.value, 111);
  assert.equal(response.managerSide.involvementTotals.inputTokensTotal.value, 200 + 300 + 400 + 600);

  const memberBatch = response.batches.find(batch => batch.batchId === `batch:${memberTurn.turnId}`);
  assert.equal(memberBatch.side, 'member');
  assert.equal(memberBatch.involvement, null);
  assert.deepEqual(memberBatch.outgoingMessages, []);
  assert.equal(memberBatch.physicalSession.context, 'pair');
  assert.equal(memberBatch.physicalSession.peer, response.manager.memberId);

  const outputOnlyBatch = response.batches.find(batch => batch.batchId === `batch:${outputOnlyTurn}`);
  assert.equal(outputOnlyBatch.side, 'manager');
  assert.equal(outputOnlyBatch.inputBatch.messages.length, 0);
  assert.equal(outputOnlyBatch.outgoingMessages.length, 1);
  assert.equal(outputOnlyBatch.outgoingMessages[0].recipientKind, 'member');
  assert.equal(outputOnlyBatch.outgoingMessages[0].kind, 'note');
  assert.equal(outputOnlyBatch.involvement.exclusiveToMember, true);
  assert.equal(outputOnlyBatch.involvement.sharedWithOtherMembers, false);

  const sharedBatch = response.batches.find(batch => batch.batchId === `batch:${sharedTurn}`);
  assert.deepEqual(sharedBatch.involvement, {
    involvedMemberIds: [one.id, two.id].sort(),
    exclusiveToMember: false,
    sharedWithOtherMembers: true,
  });
  assert.equal(sharedBatch.inputBatch.merge.merged, true);
  assert.equal(sharedBatch.inputBatch.merge.countedOnce, true);
  assert.equal(sharedBatch.outgoingMessages.length, 2);
  assert.ok(!JSON.stringify(response).includes('SECRET_BODY_'), 'outgoingMessages must not expose message text');

  assert.ok(response.managerSide.physicalSessions.length >= 1);
  assert.equal(response.managerSide.physicalSessions[0].consumption.inputTokensTotal.value, 200 + 300 + 400 + 500 + 600);
  // Session 累计包含与本成员无关的回合,involvementTotals 只累计相关回合。
  assert.ok(response.managerSide.physicalSessions[0].consumption.inputTokensTotal.value
    > response.managerSide.involvementTotals.inputTokensTotal.value);
  assert.equal(response.managerSide.contextReference.model, null);
  assert.equal(response.managerSide.contextReference.lastRequestInputRatio.value, null);
  assert.equal(response.managerSide.contextReference.lastRequestInputRatio.quality, 'unknown');
  assert.equal(response.managerSide.contextReference.lastRequestInputRatio.missingReason, 'scope_mismatch');
  assert.notEqual(otherTurn, undefined);

  const second = bus.telemetryManagerConversation(group.id, two.id);
  assert.equal(second.summary.memberBatchIds.length, 0);
  assert.deepEqual(second.summary.managerBatchIds.sort(), [sharedTurn, otherTurn].map(id => `batch:${id}`).sort());
  const secondShared = second.batches.find(batch => batch.batchId === `batch:${sharedTurn}`);
  assert.deepEqual(secondShared.involvement, sharedBatch.involvement);
  assert.equal(second.memberSide.batchCount, 0);
  assert.equal(second.memberSide.totals.inputTokensTotal.value, null);
  assert.equal(second.memberSide.totals.inputTokensTotal.missingReason, 'not_captured');
  assert.equal(second.memberSide.contextReference.lastRequestInputRatio.missingReason, 'dependency_missing');
  assert.deepEqual(second.memberSide.physicalSessions, []);
  assert.ok(second.memberSide.coverage.reasons.includes('no_observations'));

  const existing = bus.telemetryMembers(group.id);
  assert.equal(existing.readOnly, true);
  assert.ok(existing.members.every(member => !('outgoingMessages' in member) && !('involvement' in member)));

  // 完全没有观察值时,两侧 totals 仍是固定形状的空值(不缺字段、不补零)。
  const empty = bus.telemetryManagerConversation(group.id, lead.id);
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
  assert.deepEqual(empty.batches, []);
  assert.equal(empty.nextCursor, null);
  assert.throws(() => bus.telemetryManagerConversation(group.id, 'missing-member'), error => error.status === 404);
});

test('manager-conversation paginates with a stable key-set cursor and validates parameters', async t => {
  const { bus, group, one, addPanelTurn, addMemberPairTurn } = await fixture(t);
  addMemberPairTurn({ startedAt: '2026-10-23T11:00:00.000Z' });
  for (let index = 0; index < 5; index += 1) {
    addPanelTurn({
      startedAt: `2026-10-23T11:00:0${index + 1}.000Z`,
      inputs: [{ sender: one.id }],
      inputTokens: 100 + index * 10,
    });
  }
  addPanelTurn({ startedAt: '2026-10-23T11:00:02.500Z', inputs: [{ sender: one.id }], inputTokens: 999 });
  const full = bus.telemetryManagerConversation(group.id, one.id, { limit: 100 });
  const orderedTimes = full.batches.map(batch => batch.startedAt);
  assert.deepEqual(orderedTimes, [...orderedTimes].sort());
  const collected = [];
  let cursor;
  let pages = 0;
  do {
    const page = bus.telemetryManagerConversation(group.id, one.id, { limit: 2, cursor });
    assert.deepEqual(page.memberSide.totals, full.memberSide.totals);
    assert.deepEqual(page.managerSide.involvementTotals, full.managerSide.involvementTotals);
    assert.deepEqual(page.summary, full.summary);
    collected.push(...page.batches.map(batch => batch.batchId));
    cursor = page.nextCursor;
    pages += 1;
    assert.ok(pages < 10);
  } while (cursor);
  assert.equal(collected.length, full.batches.length);
  assert.equal(new Set(collected).size, collected.length);
  assert.deepEqual(collected, full.batches.map(batch => batch.batchId));

  assert.throws(() => bus.telemetryManagerConversation(group.id, one.id, { cursor: 'not-a-cursor' }), /cursor 无效/);
  assert.throws(() => bus.telemetryManagerConversation(group.id, one.id, { limit: '' }), /limit/);
  assert.throws(() => bus.telemetryManagerConversation(group.id, one.id, { limit: 0 }), /limit/);
  assert.throws(() => bus.telemetryManagerConversation(group.id, one.id, { limit: 101 }), /limit/);
  assert.throws(() => bus.telemetryManagerConversation(group.id, one.id, { from: '2026-10-23T12:00:00.000Z', to: '2026-10-23T11:00:00.000Z' }), /from/);

  const ranged = bus.telemetryManagerConversation(group.id, one.id, {
    from: '2026-10-23T11:00:03.000Z',
    to: '2026-10-23T11:00:05.000Z',
    limit: 100,
  });
  assert.ok(ranged.batches.length > 0);
  assert.ok(ranged.batches.every(batch => batch.startedAt >= '2026-10-23T11:00:03.000Z' && batch.startedAt < '2026-10-23T11:00:05.000Z'));

  // 窗口完全落在数据之后时,成员侧与管理侧都必须精确为空。
  const outside = bus.telemetryManagerConversation(group.id, one.id, {
    from: '2026-10-23T13:00:00.000Z',
    to: '2026-10-23T14:00:00.000Z',
    limit: 100,
  });
  assert.equal(outside.memberSide.batchCount, 0);
  assert.equal(outside.managerSide.batchCount, 0);
  assert.deepEqual(outside.summary.managerBatchIds, []);
  assert.deepEqual(outside.batches, []);
});

test('manager-conversation keeps partial usage non-zero-filled and duplicate observations update one batch', async t => {
  const { bus, group, panelId, session, one, addPanelTurn } = await fixture(t);
  const turnId = addPanelTurn({
    startedAt: '2026-10-23T12:00:00.000Z',
    inputs: [{ sender: one.id }],
    inputTokens: 400,
    partial: true,
  });
  const first = bus.telemetryManagerConversation(group.id, one.id);
  const batch = first.batches.find(item => item.batchId === `batch:${turnId}`);
  assert.equal(batch.completeness, 'partial');
  assert.equal(batch.metrics.inputTokensTotal.value, 400);
  assert.equal(batch.metrics.outputTokens.value, null);
  assert.ok(batch.metrics.outputTokens.missingReason);
  assert.equal(first.managerSide.coverage.partialBatchCount, 1);

  bus.telemetry.record({
    groupId: group.id,
    executorKind: 'panel_agent',
    executorId: panelId,
    endpointId: session.id,
    sessionKey: 'default',
    turnId,
    turnKind: 'panel',
    host: 'fake',
    hostSessionId: 'panel-thread',
    context: 'coordination',
    observation: telemetryObservation({
      source: 'fake.panel.usage',
      scope: 'turn',
      aggregation: 'delta',
      nativeTurnId: `native-${turnId}`,
      usage: { inputTokensTotal: 450, cacheReadTokens: 10 },
      context: { lastRequestInputTokens: 450, contextWindowTokens: 1000 },
      completeness: { inputTokensTotal: 'partial', cacheReadTokens: 'complete' },
      attempt: { id: `attempt-native-${turnId}`, state: 'failed' },
    }),
  });
  const second = bus.telemetryManagerConversation(group.id, one.id);
  assert.equal(second.managerSide.batchCount, 1);
  assert.equal(second.batches.find(item => item.batchId === `batch:${turnId}`).metrics.inputTokensTotal.value, 450);
  assert.equal(second.batches.find(item => item.batchId === `batch:${turnId}`).metrics.outputTokens.value, null);
});

test('manager-conversation HTTP route is read-only JSON and preserves existing endpoints', async t => {
  const { bus, group, one, directory, addPanelTurn, cleanup } = await fixture(t);
  const turnId = addPanelTurn({ startedAt: '2026-10-23T10:00:10.000Z', inputs: [{ sender: one.id }], outputs: [{ recipient: one.id }] });
  const server = await startServer({ directory, hosts: new Map([['fake', { async run() { return 'unused'; } }]]) });
  cleanup.push(() => server.close());
  await new Promise(resolve => setTimeout(resolve, 100));
  const before = bus.telemetryMembers(group.id);
  const response = await fetch(`${server.url}api/telemetry/manager-conversation?group=${group.id}&member=${one.id}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/json/);
  const body = await response.json();
  assert.equal(body.readOnly, true);
  assert.equal(body.manager.kind, 'panel_agent');
  assert.equal(body.managerSide.batchCount, 1);
  assert.equal(body.managerSide.involvementTotals.inputTokensTotal.value, 100);
  assert.equal(body.batches.some(batch => batch.batchId === `batch:${turnId}`), true);
  assert.ok(!JSON.stringify(body).includes('SECRET_BODY_'));

  const missingMember = await fetch(`${server.url}api/telemetry/manager-conversation?group=${group.id}`);
  assert.equal(missingMember.status, 400);
  assert.match(missingMember.headers.get('content-type'), /application\/json/);
  assert.equal(typeof (await missingMember.json()).error, 'string');
  const missingGroup = await fetch(`${server.url}api/telemetry/manager-conversation?member=${one.id}`);
  assert.equal(missingGroup.status, 400);
  const unknownMember = await fetch(`${server.url}api/telemetry/manager-conversation?group=${group.id}&member=missing-member`);
  assert.equal(unknownMember.status, 404);
  assert.match(unknownMember.headers.get('content-type'), /application\/json/);
  assert.equal(typeof (await unknownMember.json()).error, 'string');
  const badLimit = await fetch(`${server.url}api/telemetry/manager-conversation?group=${group.id}&member=${one.id}&limit=0`);
  assert.equal(badLimit.status, 400);
  assert.match(badLimit.headers.get('content-type'), /application\/json/);
  assert.equal(typeof (await badLimit.json()).error, 'string');

  const existing = bus.telemetryMembers(group.id);
  assert.equal(existing.readOnly, true);
  assert.ok(existing.members.every(member => !('outgoingMessages' in member) && !('involvement' in member)));
  assert.equal(before.readOnly, true);
});

test('manager-conversation rejects a member controller and keeps member-side shape empty when no pair exists', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-manager-empty-'));
  const host = { telemetryCapabilities: telemetryCapabilitiesFor('codex'), async run(ctx) { ctx.onAccepted(); return 'ok'; } };
  const bus = new Bus({ directory, hosts: new Map([['fake', host]]) });
  const group = createTestGroup(bus, {
    name: 'member-controller-group', workspace: directory, lead: { name: 'lead', host: 'fake' }, members: [{ name: 'worker', host: 'fake' }],
  });
  await until(() => bus.running.size === 0);
  const [lead, worker] = bus.members(group.id);
  assert.throws(() => bus.telemetryManagerConversation(group.id, worker.id), /不是 Panel Agent/);
  t.after(async () => { if (!bus.closing) await bus.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.ok(lead);
});
