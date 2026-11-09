// 未读投影的对外语义：哪些消息算「发给用户且没读」，以及它们如何分桶。
// 全部断言 homeWorkbench 的返回值，不直接读表。
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { busScenario, createTestGroup, seedPanelAgent } from '../support/fixture.mjs';
import { homeWorkbench } from '../../productivity.mjs';
import { advanceReadState } from '../../read-state.mjs';

const unreadFor = (workbench, conversation) => workbench.unread.find(row => row.conversation === conversation);

function askAnchor(bus, group, member) {
  const message = bus.store.append(group.id, member.id, 'user', 'send', '需要你确认一下');
  bus.store.createInteraction({
    id: randomUUID(),
    groupId: group.id,
    memberId: member.id,
    context: 'coordination',
    turnId: 'turn-1',
    callId: 'call-1',
    messageId: message.id,
    kind: 'choice',
    payload: { kind: 'choice', text: '需要你确认一下', options: ['同意', '拒绝'], cardOnly: true },
  });
  return message;
}

test('卡片锚点只算待办，答完之后也不会变成未读', async t => {
  const { bus, group, members } = await busScenario(t, { members: [] });
  askAnchor(bus, group, bus.teamController(group.id));
  let workbench = homeWorkbench(bus);
  assert.equal(workbench.pending.length, 1);
  assert.equal(workbench.unreadTotal, 0);

  const interaction = workbench.pending[0];
  bus.decideInteraction(interaction.id, { selected: '同意' });
  workbench = homeWorkbench(bus);
  assert.equal(workbench.pending.length, 0);
  assert.equal(workbench.unreadTotal, 0);
  assert.ok(members.length >= 1);
});

test('主控回执在群里算一条未读，私聊副本不重复计数', async t => {
  const { bus, group } = await busScenario(t, { members: [] });
  const agentId = seedPanelAgent(bus);
  const receiptId = randomUUID();
  const message = bus.store.append(group.id, agentId, 'user', 'send', '回执：本轮已完成');
  bus.store.run(
    'INSERT INTO panel_messages(id,panel_agent_id,context,role,text,active_team_id,created,receipt_id) VALUES(?,?,?,?,?,?,?,?)',
    randomUUID(), agentId, 'private', 'assistant', '回执：本轮已完成', group.id, new Date().toISOString(), receiptId,
  );

  const workbench = homeWorkbench(bus);
  assert.equal(unreadFor(workbench, `group:${group.id}`).count, 1);
  assert.equal(workbench.unread.filter(row => row.scope === 'panel').length, 0);
  assert.ok(message.id);
});

test('投递失败这类系统通知算未读', async t => {
  const { bus, group } = await busScenario(t, { members: [] });
  bus.notify(group.id, 'user', '消息 m-1 发给成员的会话失败：不会自动重试。');
  const workbench = homeWorkbench(bus);
  assert.equal(unreadFor(workbench, `group:${group.id}`).count, 1);
});

test('读一个团队不会清掉另一个团队的未读', async t => {
  const { bus, group, directory } = await busScenario(t, { members: [] });
  const other = createTestGroup(bus, { name: 'other', workspace: directory, lead: { name: 'lead2', host: 'fake' } });
  const leadA = bus.teamController(group.id);
  const leadB = bus.teamController(other.id);
  bus.store.append(group.id, leadA.id, 'user', 'send', 'A 的汇报');
  bus.store.append(other.id, leadB.id, 'user', 'send', 'B 的汇报');

  assert.equal(homeWorkbench(bus).unreadTotal, 2);
  advanceReadState(bus, { scope: 'group', scopeId: group.id, seq: 99999 });
  const workbench = homeWorkbench(bus);
  assert.equal(unreadFor(workbench, `group:${group.id}`), undefined);
  assert.equal(unreadFor(workbench, `group:${other.id}`).count, 1);
});

test('归档期间不计数，恢复时视为全部已读', async t => {
  const { bus, group } = await busScenario(t, { members: [] });
  const lead = bus.teamController(group.id);
  bus.store.append(group.id, lead.id, 'user', 'send', '归档前的汇报');
  assert.equal(homeWorkbench(bus).unreadTotal, 1);

  await bus.archiveGroup(group.id);
  assert.equal(homeWorkbench(bus).unreadTotal, 0);

  bus.store.append(group.id, lead.id, 'user', 'send', '归档期间的汇报');
  bus.restoreGroup(group.id);
  assert.equal(homeWorkbench(bus).unreadTotal, 0);
});

test('已删除团队的私聊旧消息不制造清不掉的未读', async t => {
  const { bus, group } = await busScenario(t, { members: [] });
  const agentId = seedPanelAgent(bus);
  bus.store.panelAppend(agentId, 'private', 'assistant', '团队还在时的回复', group.id);
  const ghost = bus.store.panelAppend(agentId, 'private', 'assistant', '团队已删除后的旧消息', 'gone-team');

  const workbench = homeWorkbench(bus);
  assert.equal(unreadFor(workbench, `panel:${group.id}`).count, 1);
  assert.equal(workbench.unreadTotal, 1);
  assert.ok(ghost);
});

test('面板私聊按团队分桶，读一个团队不影响另一个', async t => {
  const { bus, group, directory } = await busScenario(t, { members: [] });
  const other = createTestGroup(bus, { name: 'other', workspace: directory, lead: { name: 'lead2', host: 'fake' } });
  const agentId = seedPanelAgent(bus);
  bus.store.panelAppend(agentId, 'private', 'assistant', 'A 团队的口头汇报', group.id);
  bus.store.panelAppend(agentId, 'private', 'assistant', 'B 团队的口头汇报', other.id);
  bus.store.panelAppend(agentId, 'private', 'assistant', '不属于任何团队的私聊', null);

  assert.equal(homeWorkbench(bus).unreadTotal, 3);
  advanceReadState(bus, { scope: 'panel', scopeId: `${agentId}:${group.id}`, seq: 99999 });
  const workbench = homeWorkbench(bus);
  assert.equal(unreadFor(workbench, `panel:${group.id}`), undefined);
  assert.equal(unreadFor(workbench, `panel:${other.id}`).count, 1);
  assert.equal(unreadFor(workbench, 'panel:__global__').count, 1);
});
