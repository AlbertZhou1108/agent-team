import test from 'node:test';
import assert from 'node:assert/strict';
import { busScenario } from '../support/fixture.mjs';

const tick = () => new Promise(r => setImmediate(r));
async function until(fn) { for (let i = 0; i < 300; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error('timeout'); }
async function fixture(t, run) {
  const scenario = busScenario(t, {
    run,
    name: 'isolated',
    members: ['executor', 'reviewer'],
    profileText: 'test profile',
    finalText: 'done',
    sessionOf: endpoint => endpoint.id,
    emitHostEvent: false,
  });
  await until(() => !scenario.bus.running.size);
  return scenario;
}

test('main coordination serializes and batches reports from distinct members in one session', async t => {
  const releases = [];
  const { bus, group, members, calls } = await fixture(t, c => new Promise(resolve => releases.push(() => { c.onAccepted(); resolve('done'); })));
  const send = member => { const e = bus.store.endpoint(member.id, `pair:${group.lead}`, group.lead); return bus.tool(e.id, e.key, 'send', { to: group.lead, text: `来自${member.name}` }); };
  await send(members[1]); await until(() => releases.length === 1);
  await send(members[2]); await send(members[1]);
  assert.equal(bus.running.size, 1);
  releases.shift()(); await until(() => releases.length === 1);
  const main = calls.filter(c => c.endpoint.context === 'coordination');
  assert.equal(main.length, 2); assert.equal(main[0].endpoint.id, main[1].endpoint.id);
  assert.equal(main[0].endpoint.session, main[1].endpoint.session);
  const input = JSON.parse(bus.store.all('SELECT payload FROM outbox')[1].payload);
  assert.deepEqual([input.message.sender, ...input.additionalMessages.map(m => m.sender)], [members[2].id, members[1].id]);
  releases.shift()(); await until(() => !bus.running.size); await tick();
});

test('pair turns stream reasoning and text under the pair key', async t => {
  const { bus, members } = await fixture(t, async c => {
    c.onAccepted();
    c.onReasoningDelta('想', { part: 1 });
    c.onReasoningDelta('法', { part: 2 });
    c.onTextDelta('做', { part: 3 });
    c.onTextDelta('完', { part: 4 });
    return '做完';
  });
  const events = [];
  bus.on('team-stream', event => events.push(event));
  const sender = members[1];
  const receiver = members[2];
  const endpoint = bus.store.endpoint(sender.id, `pair:${receiver.id}`, receiver.id);
  await bus.tool(endpoint.id, endpoint.key, 'send', { to: receiver.id, text: '你好' });
  await until(() => !bus.running.size);

  const start = events.find(event => event.type === 'start');
  assert.equal(start.stream.memberName, receiver.name);
  assert.equal(start.stream.context, `pair:${sender.id}`);
  assert.equal(start.stream.recipientName, sender.name);
  assert.equal(start.stream.pairKey, [sender.id, receiver.id].sort().join(':'));
  assert.deepEqual(
    events.filter(event => event.type === 'reasoning-delta').map(event => event.delta),
    ['想', '法'],
  );
  assert.deepEqual(
    events.filter(event => event.type === 'delta').map(event => event.delta),
    ['做', '完'],
  );
  const complete = events.find(event => event.type === 'complete');
  assert.equal(complete.stream.text, '做完');
  assert.equal(complete.stream.reasoning, '想法');
  assert.equal(complete.stream.messageId, undefined);
});
