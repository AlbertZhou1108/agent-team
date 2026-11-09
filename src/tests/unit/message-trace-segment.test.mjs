import test from 'node:test';
import assert from 'node:assert/strict';
import { busScenario } from '../support/fixture.mjs';

async function settled(bus) {
  for (let i = 0; i < 400; i++) {
    if (!bus.running.size) return;
    await new Promise(r => setTimeout(r, 5));
  }
  throw Error('timeout');
}

test('message trace returns only the events of the producing call', async t => {
  // 一次回合里连续发两条消息:每次发送各有一段独立的事件。
  const { bus, group } = busScenario(t, {
    members: ['one', 'two'],
    run: async context => {
      const [first, second] = bus.members(context.endpoint.group_id).filter(m => m.role !== 'lead');
      context.onEvent({ type: 'framework.model', model: 'm1', phase: 'session' });
      await context.onTool('send', { to: first.id, text: 'first' });
      context.onEvent({ type: 'framework.model', model: 'm2', phase: 'session' });
      await context.onTool('send', { to: second.id, text: 'second' });
      context.onAccepted();
      return '';
    },
  });
  await settled(bus);
  const lead = bus.store.get("SELECT * FROM members WHERE group_id=? AND role='lead'", group.id);
  const endpoint = bus.store.endpoint(lead.id, 'coordination');
  const message = bus.store.append(group.id, 'user', lead.id, 'send', 'go');
  bus.store.prepareDelivery(endpoint, message);
  bus.retry(group.id);
  await settled(bus);

  const rows = bus.store.all(
    "SELECT m.id FROM messages m JOIN message_origins o ON o.message_id=m.id WHERE m.group_id=? AND m.sender!='user' ORDER BY m.seq",
    group.id,
  );
  assert.ok(rows.length >= 2, `应当产出至少两条消息,实际 ${rows.length}`);
  const traces = rows.map(row => bus.store.messageTrace(row.id, { segment: true }));
  for (const trace of traces) {
    assert.ok(trace.segment, '有回合来源的消息应当有事件段');
    assert.ok(trace.segment.events.length > 0);
    assert.ok(trace.segment.startSeq <= trace.segment.endSeq);
    assert.equal(trace.turn.id, trace.source.turnId);
  }
  // 段只覆盖产出这条消息的那次调用:同回合内多段互不重叠。
  const byTurn = new Map();
  for (const trace of traces) {
    byTurn.set(trace.turn.id, [...(byTurn.get(trace.turn.id) ?? []), trace.segment]);
  }
  for (const [turnId, segments] of byTurn) {
    const sorted = [...segments].sort((a, b) => a.startSeq - b.startSeq);
    for (let i = 1; i < sorted.length; i++) {
      assert.ok(
        sorted[i].startSeq > sorted[i - 1].endSeq,
        `回合 ${turnId} 的第 ${i} 段应在上一段之后开始(${sorted[i].startSeq} vs ${sorted[i - 1].endSeq})`,
      );
    }
  }
});

test('message trace without a turn source has no segment', async t => {
  const { bus, group } = busScenario(t, { members: [] });
  await settled(bus);
  const message = bus.store.append(group.id, 'system', 'system', 'system', 'notice');
  const trace = bus.store.messageTrace(message.id, { segment: true });
  assert.deepEqual(trace.source, { kind: 'system' });
  assert.equal(trace.segment, null);
  assert.equal(trace.turn, null);
});
