// 投递恢复:消息落库后崩溃、投递意图（outbox）落库后崩溃、unknown 回合阻断、
// 以及 prepare 阶段失败后不产生"半条投递"。断言对象都是可观察行为（宿主是否收到输入）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Bus } from '../../src/bus.mjs';
import { busScenario, fakeHost } from '../support/fixture.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(fn, label = 'condition') {
  const end = Date.now() + 5000;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`${label} timed out`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
const hint = (call, text) => String(call?.prompt ?? '').includes(text);

test('a message persisted without a delivery intent is picked up by the next pump', async t => {
  const { bus, group, members, calls } = busScenario(t);
  const [lead, one] = members;
  await until(() => bus.running.size === 0, 'idle');

  // 模拟 append 已提交、prepareDelivery 尚未发生的崩溃窗口。
  bus.store.append(group.id, one.id, lead.id, 'send', 'recovered awaiting message');
  assert.equal(calls.some(call => hint(call, 'recovered awaiting message')), false);

  bus.pump();
  await until(() => calls.some(call => hint(call, 'recovered awaiting message')), 'delivery');
  await until(() => bus.running.size === 0, 'idle after delivery');
  assert.equal(calls.filter(call => hint(call, 'recovered awaiting message')).length, 1);
});

test('a pending outbox delivery is retried after a restart', async t => {
  const { bus, group, members, directory } = busScenario(t);
  const [lead, one] = members;
  await until(() => bus.running.size === 0, 'idle');

  // 模拟投递意图已落库、但宿主尚未接受时进程退出。
  const message = bus.store.append(group.id, one.id, lead.id, 'send', 'persisted delivery intent');
  const conversation = bus.store.conversation('member', lead.id, `pair:${one.id}`);
  assert.ok(bus.store.prepareDelivery(conversation, message));
  await bus.close();

  const host = fakeHost();
  const reopened = new Bus({ directory, hosts: new Map([['fake', host]]) });
  reopened.start();
  await until(() => host.calls.some(call => hint(call, 'persisted delivery intent')), 'retry after restart');
  await until(() => reopened.running.size === 0, 'idle after retry');
  assert.equal(host.calls.filter(call => hint(call, 'persisted delivery intent')).length, 1);
  await reopened.close();
});

test('delivery waits while a turn is unknown and resumes after the user verifies it', async t => {
  const { bus, group, members, calls } = busScenario(t);
  const [lead, one] = members;
  await until(() => bus.running.size === 0, 'idle');

  const conversation = bus.store.conversation('member', one.id, `pair:${lead.id}`);
  const turnId = bus.store.createTurn(conversation, { executorKind: 'member', executorId: one.id });
  bus.store.run("UPDATE turns SET state='unknown' WHERE id=?", turnId);

  bus.store.append(group.id, one.id, lead.id, 'send', 'blocked by unknown turn');
  bus.pump();
  await tick();
  await tick();
  assert.equal(calls.some(call => hint(call, 'blocked by unknown turn')), false);

  // 用户核实宿主已停止后，投递继续。
  bus.store.run("UPDATE turns SET state='completed' WHERE id=?", turnId);
  bus.pump();
  await until(() => calls.some(call => hint(call, 'blocked by unknown turn')), 'delivery after verification');
  await until(() => bus.running.size === 0, 'idle after delivery');
  assert.equal(calls.filter(call => hint(call, 'blocked by unknown turn')).length, 1);
});

test('a failed delivery preparation leaves no half-delivered input', async t => {
  const { bus, group, members, calls } = busScenario(t);
  const [lead, one] = members;
  await until(() => bus.running.size === 0, 'idle');

  bus.store.append(group.id, one.id, lead.id, 'send', 'injected failure');
  const original = bus.store.prepareDelivery;
  let injected = false;
  bus.store.prepareDelivery = (...args) => {
    if (!injected) { injected = true; throw new Error('injected prepare failure'); }
    return original.apply(bus.store, args);
  };
  try {
    assert.throws(() => bus.pump(), /injected prepare failure/);
    assert.equal(calls.some(call => hint(call, 'injected failure')), false);
  } finally {
    bus.store.prepareDelivery = original;
  }

  bus.pump();
  await until(() => calls.some(call => hint(call, 'injected failure')), 'delivery after recovery');
  await until(() => bus.running.size === 0, 'idle after delivery');
  assert.equal(calls.filter(call => hint(call, 'injected failure')).length, 1);
});
