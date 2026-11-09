// 聚合模块不变式:messages(投递/来源)、turns(状态机)、conversations(owner/绑定)。
// 这些是内部表示断言(internal 层),随聚合实现重写时同步更新。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store.mjs';
import * as messages from '../../src/aggregates/messages.mjs';
import * as turns from '../../src/aggregates/turns.mjs';
import * as conversations from '../../src/aggregates/conversations.mjs';

const NOW = '2026-01-01T00:00:00.000Z';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'aggregates-'));
  const store = new Store(directory);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  store.run('INSERT INTO groups(id,name,workspace,created) VALUES(?,?,?,?)', 'g', 'G', '/tmp', NOW);
  store.run(
    "INSERT INTO members(id,group_id,name,host,role) VALUES('m1','g','one','fake','lead'),('m2','g','two','fake','member')",
  );
  store.run(
    "INSERT INTO panel_agents(id,singleton,name,host,access,created,updated) VALUES('pa',1,'Panel','fake','read-only',?,?)",
    NOW, NOW,
  );
  return { store, directory };
}

test('messages.append 不变式:send 待投递、note/user 不待投递、expects_reply 只对 send 生效', t => {
  const { store } = fixture(t);
  const send = messages.append(store, 'g', 'm2', 'm1', 'send', 'one', null, true);
  const note = messages.append(store, 'g', 'm2', 'm1', 'note', 'later');
  const toUser = messages.append(store, 'g', 'm2', 'user', 'send', 'answer');
  assert.equal(send.awaiting, 1);
  assert.equal(send.expects_reply, 1);
  assert.equal(note.awaiting, 0);
  assert.equal(note.expects_reply, 0);
  assert.equal(toUser.awaiting, 0);
  assert.equal(toUser.expects_reply, 0);
  assert.deepEqual(messages.pending(store).map(message => message.id), [send.id]);

  // 读取面:byId/byIdInGroup/senderOf/textOf/replyTarget 与团队边界一致。
  assert.equal(messages.byId(store, send.id).text, 'one');
  assert.equal(messages.byIdInGroup(store, send.id, 'g').id, send.id);
  assert.equal(messages.byIdInGroup(store, send.id, 'other'), null);
  assert.equal(messages.senderOf(store, send.id), 'm2');
  assert.equal(messages.textOf(store, send.id), 'one');
  assert.equal(messages.replyTarget(store, send.id, 'g').id, send.id);
  assert.equal(messages.replyTarget(store, send.id, 'other'), null);
  assert.equal(messages.existsInGroup(store, send.id, 'g'), true);
  assert.equal(messages.existsInGroup(store, send.id, 'other'), false);
});

test('消息进入 attached 后 awaiting 清零,isAttached 与待投递守卫随之翻转', t => {
  const { store } = fixture(t);
  const conversation = conversations.forMember(store, 'm1', 'coordination');
  const message = messages.append(store, 'g', 'm2', 'm1', 'send', 'deliver me');
  assert.equal(messages.isAttached(store, message.id), false);
  assert.equal(messages.hasPendingDelivery(store, conversation.id), false);
  assert.equal(messages.hasPendingDeliveryForGroup(store, 'g'), false);

  const entry = messages.prepareDelivery(store, conversation, message);
  assert.ok(entry);
  assert.equal(messages.isAttached(store, message.id), true);
  assert.equal(messages.pending(store).length, 0);
  assert.equal(store.get('SELECT awaiting FROM messages WHERE id=?', message.id).awaiting, 0);
  assert.equal(messages.hasPendingDelivery(store, conversation.id), true);
  assert.equal(messages.hasPendingDeliveryForGroup(store, 'g'), true);

  // 失败只写 error,不自动重试;resetDeliveryErrorsForGroup 只清 error。
  messages.setDeliveryError(store, entry, 'host unavailable');
  assert.equal(messages.deliveryStateForMessage(store, message.id).error, 'host unavailable');
  messages.resetDeliveryErrorsForGroup(store, 'g');
  assert.equal(messages.deliveryStateForMessage(store, message.id).error, null);
  assert.equal(messages.deliveryStateForMessage(store, message.id).accepted, null);

  // 接受后不再是待投递;discardPendingDeliveriesForMember 只清未接受的条目。
  messages.markDeliveryAccepted(store, entry);
  assert.equal(messages.deliveryStateForMessage(store, message.id).accepted != null, true);
  assert.equal(messages.hasPendingDelivery(store, conversation.id), false);
  const pending = messages.append(store, 'g', 'm2', 'm1', 'send', 'pending one');
  assert.ok(messages.prepareDelivery(store, conversation, pending));
  assert.equal(messages.hasPendingDelivery(store, conversation.id), true);
  messages.discardPendingDeliveriesForMember(store, 'm1');
  assert.equal(messages.hasPendingDelivery(store, conversation.id), false);
  // 已接受的行保留。
  assert.equal(messages.deliveryStateForMessage(store, message.id).accepted != null, true);
});

test('用户发给成员的指令同样保持 awaiting,直到进入投递队列才清零', t => {
  const { store } = fixture(t);
  const conversation = conversations.forMember(store, 'm1', 'coordination');
  const directive = messages.append(store, 'g', 'user', 'm1', 'send', 'do it');
  assert.equal(directive.awaiting, 1);
  assert.deepEqual(messages.pending(store).map(message => message.id), [directive.id]);
  assert.ok(messages.prepareDelivery(store, conversation, directive));
  assert.equal(messages.byId(store, directive.id).awaiting, 0);
  assert.equal(messages.pending(store).length, 0);
});

test('clearAwaitingForRecipient 让被移除成员的消息退出 pending 扫描', t => {
  const { store } = fixture(t);
  const message = messages.append(store, 'g', 'm2', 'm1', 'send', 'no longer needed');
  assert.equal(messages.pending(store).length, 1);
  messages.clearAwaitingForRecipient(store, 'm1');
  assert.equal(messages.pending(store).length, 0);
  assert.equal(messages.byId(store, message.id).awaiting, 0);
  // 已进入 attached 的消息不受影响。
  const other = messages.append(store, 'g', 'm2', 'm1', 'send', 'in flight');
  messages.prepareDelivery(store, conversations.forMember(store, 'm1', 'coordination'), other);
  messages.clearAwaitingForRecipient(store, 'm1');
  assert.equal(messages.isAttached(store, other.id), true);
});

test('message_origins 来源标注与 outbox 投递任务都经聚合写入', t => {
  const { store } = fixture(t);
  const conversation = conversations.forMember(store, 'm1', 'coordination');
  const turnId = turns.create(store, conversation, { executorKind: 'member', executorId: 'm1' });
  const message = messages.append(store, 'g', 'user', 'm1', 'send', 'do it');
  messages.insertOrigin(store, { messageId: message.id, turnId, callId: 'call-1' });
  const origin = store.get('SELECT * FROM message_origins WHERE message_id=?', message.id);
  assert.equal(origin.turn_id, turnId);
  assert.equal(origin.call_id, 'call-1');
  assert.equal(origin.native_call_id, null);

  // 无出处时不写 origins(appendRoutedMessage 的语义在这里由调用方保证)。
  const plain = messages.append(store, 'g', 'user', 'm1', 'note', 'no origin');
  assert.equal(store.get('SELECT * FROM message_origins WHERE message_id=?', plain.id), undefined);

  messages.enqueueDelivery(store, 'outbox-1', conversation.id, { kind: 'panel-private', panelMessageId: 'pm-1' });
  assert.deepEqual(
    JSON.parse(store.get('SELECT payload FROM outbox WHERE id=?', 'outbox-1').payload),
    { kind: 'panel-private', panelMessageId: 'pm-1' },
  );
});

test('turns 聚合:创建/读取/状态转移与 unknown 事实', t => {
  const { store } = fixture(t);
  const conversation = conversations.forMember(store, 'm1', 'coordination');
  const input = messages.append(store, 'g', 'user', 'm1', 'send', 'turn input');
  const turnId = turns.create(store, conversation, {
    executorKind: 'member',
    executorId: 'm1',
    inputs: [input],
    activeTeamId: 'g',
  });

  const created = turns.find(store, turnId, conversation.id);
  assert.equal(created.state, 'running');
  assert.equal(created.executor_kind, 'member');
  assert.equal(created.executor_id, 'm1');
  assert.equal(created.active_team_id, 'g');
  assert.equal(created.session_id, conversation.id);
  assert.equal(turns.find(store, turnId).active_team_id, 'g');
  assert.equal(turns.find(store, turnId, 'other-conversation'), null);
  assert.deepEqual(turns.inputMessageIds(store, turnId), [input.id]);

  // 状态机:running -> completed 的 ended 由状态写点收敛。
  turns.setState(store, turnId, 'completed', { detail: 'done' });
  assert.equal(turns.find(store, turnId).state, 'completed');
  assert.equal(turns.find(store, turnId).detail, 'done');
  assert.ok(turns.find(store, turnId).ended);

  // unknown 是待用户核实事实,hasUnknown 阻断会话继续投递。
  assert.equal(turns.hasUnknown(store, conversation.id), false);
  turns.setState(store, turnId, 'unknown');
  assert.equal(turns.hasUnknown(store, conversation.id), true);
  assert.equal(turns.find(store, turnId, conversation.id, { state: 'unknown' }).state, 'unknown');
  assert.equal(turns.find(store, turnId, conversation.id, { state: 'completed' }), null);
  assert.equal(turns.unknownTurnForMessage(store, input.id).turn_id, turnId);
});

test('Panel unknown 运行:单条核实入口与按团队列表共用一个事实源', t => {
  const { store } = fixture(t);
  const coordination = conversations.forPanelAgent(store, 'pa', 'coordination', { groupId: 'g' });
  const turnId = turns.create(store, coordination, { executorKind: 'panel_agent', executorId: 'pa' });
  const privateConversation = conversations.forPanelAgent(store, 'pa', 'private');
  const privateTurnId = turns.create(store, privateConversation, { executorKind: 'panel_agent', executorId: 'pa' });

  assert.equal(turns.unknownPanelTurn(store, turnId), null);
  turns.setState(store, turnId, 'unknown');
  turns.setState(store, privateTurnId, 'unknown');
  assert.equal(turns.unknownPanelTurn(store, turnId).id, turnId);
  const all = turns.unknownPanelTurns(store);
  assert.deepEqual(all.map(turn => turn.id).sort(), [turnId, privateTurnId].sort());
  const scoped = turns.unknownPanelTurns(store, 'g');
  assert.deepEqual(scoped.map(turn => turn.id), [turnId]);
  assert.equal(scoped[0].session_context, 'coordination');
  // 非 panel 执行者的 unknown 不进入 Panel 核实列表。
  const memberConversation = conversations.forMember(store, 'm1', 'coordination');
  const memberTurn = turns.create(store, memberConversation, { executorKind: 'member', executorId: 'm1' });
  turns.setState(store, memberTurn, 'unknown');
  assert.equal(turns.unknownPanelTurns(store).length, 2);
});

test('conversations owner 互斥与复用:同一 owner+context 不重复建会话', t => {
  const { store } = fixture(t);
  const memberConversation = conversations.forMember(store, 'm1', 'coordination');
  const same = conversations.forMember(store, 'm1', 'coordination');
  assert.equal(same.id, memberConversation.id);
  assert.equal(memberConversation.member_id, 'm1');
  assert.equal(memberConversation.panel_agent_id, null);
  assert.equal(memberConversation.owner_kind, 'member');
  assert.equal(memberConversation.owner_id, 'm1');

  const pair = conversations.forMember(store, 'm1', 'pair:m2', { peer: 'm2' });
  assert.notEqual(pair.id, memberConversation.id);
  assert.equal(pair.context, 'pair:m2');
  assert.equal(pair.peer, 'm2');

  const panelPrivate = conversations.forPanelAgent(store, 'pa', 'private');
  assert.equal(panelPrivate.owner_kind, 'panel_agent');
  assert.equal(panelPrivate.panel_agent_id, 'pa');
  assert.equal(panelPrivate.member_id, null);
  assert.equal(conversations.forPanelAgent(store, 'pa', 'private').id, panelPrivate.id);
  const panelCoordination = conversations.forPanelAgent(store, 'pa', 'coordination', { groupId: 'g' });
  assert.notEqual(panelCoordination.id, panelPrivate.id);
  assert.equal(panelCoordination.group_id, 'g');
  assert.equal(conversations.byId(store, panelCoordination.id).owner_kind, 'panel_agent');

  // owner 互斥不变式来自 schema CHECK:两列同时为空或同时非空都写不进去。
  assert.throws(() => store.run(
    "INSERT INTO conversations(id,context,key,created,updated) VALUES('bad','private','k',?,?)", NOW, NOW,
  ), /CHECK/);
  // pair 会话归属成员所在团队,也在该团队的会话列表里;private 不再挂团队。
  assert.deepEqual(conversations.idsForGroup(store, 'g').map(row => row.id).sort(),
    [memberConversation.id, pair.id, panelCoordination.id].sort());
});

test('conversation_session_meta:binding 读取/覆盖/全清与策略签名回落', t => {
  const { store } = fixture(t);
  const conversation = conversations.forMember(store, 'm1', 'coordination');

  // 无 binding:fallbackSession 与 conversations.policy_signature 决定上一份策略。
  store.run('UPDATE conversations SET session=?,policy_signature=? WHERE id=?', 'legacy-session', 'legacy-policy', conversation.id);
  let state = conversations.sessionState(store, conversation.id, 'default', { fallbackSession: 'legacy-session' });
  assert.equal(state.binding, null);
  assert.equal(state.previousPolicy, 'legacy-policy');
  state = conversations.sessionState(store, conversation.id, 'default');
  assert.equal(state.previousPolicy, null);

  conversations.saveBinding(store, conversation.id, 'default', 'sess-1');
  state = conversations.sessionState(store, conversation.id, 'default');
  assert.equal(state.binding.session, 'sess-1');
  assert.equal(state.binding.session_key, 'default');
  assert.equal(state.previousPolicy, null);
  // 同一 key 覆盖 session,不产生第二行。
  conversations.saveBinding(store, conversation.id, 'default', 'sess-2');
  assert.equal(conversations.sessionState(store, conversation.id, 'default').binding.session, 'sess-2');
  store.setConversationPolicySignature(conversation.id, 'policy-1', 'default');
  assert.equal(conversations.sessionState(store, conversation.id, 'default').previousPolicy, 'policy-1');

  // 按 key 清:返回其余绑定里最新的 session。
  conversations.saveBinding(store, conversation.id, 'k2', 'sess-k2');
  assert.deepEqual(conversations.sessionKeysForRotation(store, conversation.id).sort(), ['default', 'k2']);
  assert.equal(conversations.resetBindings(store, conversation.id, 'default'), 'sess-k2');
  assert.equal(conversations.sessionState(store, conversation.id, 'default').binding, null);
  assert.deepEqual(conversations.sessionKeysForRotation(store, conversation.id), ['k2']);

  // 全清:绑定与 conversations.policy_signature 一起清空,剩余 session 为 null。
  assert.equal(conversations.resetBindings(store, conversation.id), null);
  assert.deepEqual(conversations.sessionKeysForRotation(store, conversation.id), []);
  assert.equal(store.get('SELECT policy_signature FROM conversations WHERE id=?', conversation.id).policy_signature, null);
});

test('Panel Agent 会话投影与清空:列表/按团队/私聊范围', t => {
  const { store } = fixture(t);
  const privateConversation = conversations.forPanelAgent(store, 'pa', 'private');
  const coordination = conversations.forPanelAgent(store, 'pa', 'coordination', { groupId: 'g' });
  conversations.saveBinding(store, privateConversation.id, 'default', 'private-session');
  conversations.saveBinding(store, coordination.id, 'default', 'coord-session');
  store.setConversationSession(privateConversation.id, 'private-session');
  store.setConversationSession(coordination.id, 'coord-session');

  const sessions = conversations.sessionsForPanelAgent(store, 'pa');
  assert.deepEqual(sessions.map(row => row.id).sort(), [privateConversation.id, coordination.id].sort());
  assert.equal(sessions.find(row => row.id === privateConversation.id).session, 'private-session');

  // 只清私聊(模型/工作区变更但不换宿主时)。
  conversations.clearSessionsForPanelAgent(store, 'pa', { privateOnly: true });
  assert.equal(store.get('SELECT session FROM conversations WHERE id=?', privateConversation.id).session, null);
  assert.equal(store.get('SELECT session FROM conversations WHERE id=?', coordination.id).session, 'coord-session');
  // 宿主/模型变化:全部清空。
  conversations.clearSessionsForPanelAgent(store, 'pa');
  assert.equal(store.get('SELECT session FROM conversations WHERE id=?', coordination.id).session, null);
  assert.equal(store.get('SELECT policy_signature FROM conversations WHERE id=?', coordination.id).policy_signature, null);
});
