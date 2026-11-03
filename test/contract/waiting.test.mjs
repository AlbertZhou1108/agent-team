// 未应答列表:只列可靠信号(用户指令尚无 reply_to 回复)，并随归档/回复消失。
import test from 'node:test';
import assert from 'node:assert/strict';
import { busScenario } from '../support/fixture.mjs';
import { until } from '../support/wait.mjs';
import { homeWorkbench } from '../../src/productivity.mjs';

test('workbench lists unanswered user directives until a reply points back to them', async t => {
  const { bus, group } = busScenario(t);
  await until(() => !bus.running.size);
  const controller = bus.teamController(group.id);

  const immediate = { waitingThresholdMs: 0 };
  const directive = bus.store.append(group.id, 'user', controller.id, 'send', '请整理发布说明');
  // 默认 5 分钟阈值内不打扰。
  assert.deepEqual(homeWorkbench(bus).waiting, []);
  const waiting = homeWorkbench(bus, immediate).waiting;
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].id, directive.id);
  assert.equal(waiting[0].recipientName, 'lead');
  assert.equal(waiting[0].recipientKind, 'member');
  assert.equal(waiting[0].groupName, group.name);
  assert.match(waiting[0].title, /发布说明/);
  assert.match(waiting[0].path, new RegExp(`/groups/${group.id}`));

  // 最终回复通过 reply_to 指回指令后，不再是未应答。
  bus.store.append(group.id, controller.id, 'user', 'send', '已完成', directive.id);
  assert.deepEqual(homeWorkbench(bus, immediate).waiting, []);

  // 用户回答互动卡的消息自身是 reply，不是新指令，不能算未应答。
  const question = bus.store.append(group.id, controller.id, 'user', 'send', '选哪个方案？');
  bus.store.append(group.id, 'user', controller.id, 'send', '选 A', question.id);
  assert.deepEqual(homeWorkbench(bus, immediate).waiting, []);

  // 超过阈值即列出；是否正在运行不参与判断。
  const stale = bus.store.append(group.id, 'user', controller.id, 'send', '另一条未回复指令');
  bus.store.run('UPDATE messages SET created=? WHERE id=?', new Date(Date.now() - 10 * 60 * 1000).toISOString(), stale.id);
  assert.equal(homeWorkbench(bus).waiting.length, 1);

  // 归档团队不进入等待视图。
  bus.setGroupState(group.id, 'archived');
  assert.deepEqual(homeWorkbench(bus, immediate).waiting, []);
});
