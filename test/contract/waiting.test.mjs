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

  const directive = bus.store.append(group.id, 'user', controller.id, 'send', '请整理发布说明');
  const waiting = homeWorkbench(bus).waiting;
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].id, directive.id);
  assert.equal(waiting[0].recipientName, 'lead');
  assert.equal(waiting[0].recipientKind, 'member');
  assert.equal(waiting[0].groupName, group.name);
  assert.match(waiting[0].title, /发布说明/);
  assert.match(waiting[0].path, new RegExp(`/groups/${group.id}`));

  // 最终回复通过 reply_to 指回指令后，不再是未应答。
  bus.store.append(group.id, controller.id, 'user', 'send', '已完成', directive.id);
  assert.deepEqual(homeWorkbench(bus).waiting, []);

  // 归档团队不进入等待视图。
  bus.store.append(group.id, 'user', controller.id, 'send', '另一条未回复指令');
  assert.equal(homeWorkbench(bus).waiting.length, 1);
  bus.setGroupState(group.id, 'archived');
  assert.deepEqual(homeWorkbench(bus).waiting, []);
});
