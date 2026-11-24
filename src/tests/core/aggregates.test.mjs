import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../store.mjs';
import * as messages from '../../aggregates/messages.mjs';
import * as turns from '../../aggregates/turns.mjs';
import * as conversations from '../../aggregates/conversations.mjs';
import { Collaboration } from '../../collaboration.mjs';
import { TeamRequests } from '../../team-requests.mjs';
import * as teams from '../../aggregates/teams.mjs';
import * as settings from '../../aggregates/settings.mjs';
import * as panel from '../../aggregates/panel.mjs';
import { EventLog } from '../../event-log.mjs';
import { busScenario, seedPanelAgent } from '../support/fixture.mjs';
import { until } from '../support/wait.mjs';

describe('aggregates', () => {
const NOW = '2026-01-01T00:00:00.000Z';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'aggregates-'));
  const store = new Store(directory);
  t.after(() => {
    store.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
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
});

describe('aggregates-teams-settings', () => {
const NOW = '2026-01-01T00:00:00.000Z';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'aggregates-teams-settings-'));
  const store = new Store(directory);
  // 生产由 Bus 构造这些模块:Collaboration 建 role_names/global_model_policy 并种入默认行,
  // TeamRequests 建 team_request* 表。这里按同样顺序补齐,避免测试依赖 Bus 全量构造。
  new Collaboration(store);
  new TeamRequests({ store });
  t.after(() => {
    store.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  });
  return store;
}

function seedGroup(store, id = 'g', lead = null, created = NOW) {
  teams.insertGroup(store, {
    id,
    name: `team-${id}`,
    workspace: '/tmp',
    created,
    charter: null,
    policy: 'workspace-write',
    allowShell: 1,
  });
  if (lead) {
    teams.insertMember(store, { id: lead, groupId: id, name: lead, host: 'fake', role: 'lead' });
    teams.setGroupLead(store, id, lead);
  }
  return id;
}

// Collaboration 构造时已种入 global_model_policy 单行,测试沿用,不再重复插入。
function seedGlobalPolicy(store) {
  assert.equal(store.get('SELECT count(*) AS c FROM global_model_policy').c, 1);
}

test('teams:成员关系、有效成员过滤与历史角色名占用', t => {
  const store = fixture(t);
  seedGroup(store, 'g', 'lead');
  teams.insertMember(store, { id: 'm1', groupId: 'g', name: '成员一', host: 'fake', role: 'member', selection: { model_provider: 'p', model: 'x', reasoning_effort: 'low' } });
  store.run("INSERT INTO role_names(group_id,name_key,member_id) VALUES('g','成员一','m1')");

  assert.deepEqual(teams.activeMembers(store, 'g').map(row => row.id), ['lead', 'm1']);
  assert.equal(teams.findMember(store, 'g', 'm1').model, 'x');
  assert.equal(teams.findMember(store, 'g', 'missing'), null);
  assert.equal(teams.findMemberByRoleName(store, 'g', '成员一').id, 'm1');
  assert.equal(teams.findMemberByRoleName(store, 'g', '不存在'), null);
  assert.equal(teams.roleNameTaken(store, 'g', '成员一'), true);
  assert.equal(teams.roleNameTaken(store, 'g', '新名字'), false);

  // 改名/模型/资料更新走聚合,成员关系不变。
  teams.updateMemberModel(store, 'm1', { model_provider: null, model: 'y', reasoning_effort: null });
  teams.updateMemberProfile(store, 'm1', '负责审查');
  assert.equal(teams.activeMemberById(store, 'm1').model, 'y');
  assert.equal(teams.activeMemberById(store, 'm1').profile, '负责审查');
  assert.equal(teams.activeMemberById(store, 'm1').reasoning_effort, null);

  // 移除是软删除:有效成员与按 id 查询不再命中,历史角色名仍然占用。
  teams.markMemberRemoved(store, 'm1', NOW);
  assert.deepEqual(teams.activeMembers(store, 'g').map(row => row.id), ['lead']);
  assert.equal(teams.activeMemberById(store, 'm1'), null);
  assert.equal(teams.findMember(store, 'g', 'm1'), null);
  assert.equal(teams.roleNameTaken(store, 'g', '成员一'), true);
  assert.ok(store.get('SELECT removed FROM members WHERE id=?', 'm1').removed);
});

test('teams:主控状态迁移 revision 单调递增,接管记录原主 Agent', t => {
  const store = fixture(t);
  seedGroup(store, 'g', 'lead');
  assert.equal(teams.controllerAssignment(store, 'g'), null);

  teams.promoteToPanelController(store, { groupId: 'g', panelAgentId: 'pa', originalLeadId: 'lead', now: NOW });
  let assignment = teams.controllerAssignment(store, 'g');
  assert.equal(assignment.controller_kind, 'panel_agent');
  assert.equal(assignment.controller_id, 'pa');
  assert.equal(assignment.state, 'active');
  assert.equal(assignment.original_lead_id, 'lead');
  assert.equal(assignment.revision, 1);

  // 重复接管:仍是一行,revision 递增。
  teams.promoteToPanelController(store, { groupId: 'g', panelAgentId: 'pa', originalLeadId: 'lead', now: NOW });
  assignment = teams.controllerAssignment(store, 'g');
  assert.equal(assignment.revision, 2);
  assert.equal(store.get("SELECT count(*) AS c FROM team_lead_controllers WHERE group_id='g'").c, 1);

  teams.handbackToMember(store, { groupId: 'g', memberId: 'lead', now: NOW });
  assignment = teams.controllerAssignment(store, 'g');
  assert.equal(assignment.controller_kind, 'member');
  assert.equal(assignment.controller_id, 'lead');
  assert.equal(assignment.original_lead_id, null);
  assert.equal(assignment.revision, 3);

  // 新建团队由 Panel Agent 直接主控:无原主 Agent。
  seedGroup(store, 'g2');
  teams.insertPanelController(store, { groupId: 'g2', panelAgentId: 'pa', now: NOW });
  assignment = teams.controllerAssignment(store, 'g2');
  assert.equal(assignment.original_lead_id, null);
  assert.equal(assignment.revision, 1);
});

test('teams:任务面板 upsert/删除与团队级投影', t => {
  const store = fixture(t);
  seedGroup(store, 'g', 'lead');
  teams.setAgentTasks(store, {
    ownerId: 'lead',
    groupId: 'g',
    tasks: [{ text: '做 A', state: 'doing' }],
    updated: NOW,
  });
  const rows = teams.agentTasksForGroup(store, 'g');
  assert.equal(rows.length, 1);
  assert.deepEqual(JSON.parse(rows[0].tasks), [{ text: '做 A', state: 'doing' }]);

  // 同一 (owner, group) 覆盖写。
  teams.setAgentTasks(store, {
    ownerId: 'lead',
    groupId: 'g',
    tasks: [{ text: '做 B', state: 'done' }],
    updated: '2026-01-02T00:00:00.000Z',
  });
  assert.equal(store.get("SELECT count(*) AS c FROM agent_tasks WHERE group_id='g'").c, 1);
  assert.deepEqual(JSON.parse(teams.agentTasksForGroup(store, 'g')[0].tasks), [{ text: '做 B', state: 'done' }]);

  // 空列表等价于删除。
  teams.setAgentTasks(store, { ownerId: 'lead', groupId: 'g', tasks: [], updated: NOW });
  assert.deepEqual(teams.agentTasksForGroup(store, 'g'), []);
});

test('teams:团队存在性/列表/状态与建群幂等记录', t => {
  const store = fixture(t);
  assert.equal(teams.groupExists(store, 'g'), false);
  seedGroup(store, 'g', 'lead');
  seedGroup(store, 'g2', null, '2026-01-02T00:00:00.000Z');
  assert.equal(teams.groupExists(store, 'g'), true);
  assert.deepEqual(teams.groupsAll(store).map(row => row.id), ['g', 'g2']);
  assert.equal(teams.latestReceiptSeq(store), 0);

  teams.updateGroupState(store, 'g', 'archived');
  assert.equal(store.get('SELECT state FROM groups WHERE id=?', 'g').state, 'archived');

  // 建群幂等:按 client_key 回读,ref 指回已建团队。
  assert.equal(teams.groupCreateOperation(store, 'op-1'), null);
  teams.recordGroupCreate(store, { operationId: 'op-1', payload: '{"name":"t"}', groupId: 'g', created: NOW });
  const previous = teams.groupCreateOperation(store, 'op-1');
  assert.equal(previous.ref, 'g');
  assert.equal(previous.payload, '{"name":"t"}');
});

test('settings:全局策略单行与 preset 引用的不变式', t => {
  const store = fixture(t);
  seedGlobalPolicy(store);
  assert.equal(settings.modelPolicy(store).mode, 'user');
  assert.ok(settings.modelPolicy(store).rules.length > 0);
  assert.equal(settings.activePresetId(store), null);

  settings.insertPreset(store, { id: 'p1', name: '配置一', mode: 'user', rules: '规则一', created: NOW, updated: NOW });
  settings.updateModelPolicy(store, { mode: 'user', rules: '新规则', presetId: 'p1', updated: NOW });
  assert.equal(settings.modelPolicy(store).rules, '新规则');
  assert.equal(settings.modelPolicy(store).preset_id, 'p1');
  assert.equal(settings.activePresetId(store), 'p1');
  assert.equal(store.get('SELECT count(*) AS c FROM global_model_policy').c, 1);

  settings.updateModelPolicy(store, { mode: 'user', rules: '切回内置', presetId: null, updated: NOW });
  assert.equal(settings.activePresetId(store), null);
  assert.equal(settings.modelPolicy(store).preset_id, null);
});

test('settings:preset 名称唯一、列表顺序与增删改', t => {
  const store = fixture(t);
  seedGlobalPolicy(store);
  settings.insertPreset(store, { id: 'p1', name: 'A', mode: 'user', rules: 'r1', created: NOW, updated: '2026-01-01T00:00:00.000Z' });
  settings.insertPreset(store, { id: 'p2', name: 'B', mode: 'user', rules: 'r2', created: NOW, updated: '2026-01-02T00:00:00.000Z' });
  assert.deepEqual(settings.listPresets(store).map(row => row.id), ['p2', 'p1']);
  assert.equal(settings.presetNameTaken(store, 'A'), true);
  assert.equal(settings.presetNameTaken(store, 'C'), false);
  assert.equal(settings.presetNameConflict(store, 'B', 'p1'), true);
  assert.equal(settings.presetNameConflict(store, 'A', 'p1'), false);
  assert.equal(settings.presetById(store, 'p1').rules, 'r1');

  settings.renamePreset(store, 'p1', 'A2', '2026-01-03T00:00:00.000Z');
  assert.equal(settings.presetById(store, 'p1').name, 'A2');
  settings.updatePreset(store, 'p1', { mode: 'user', rules: 'r1-new', updated: '2026-01-04T00:00:00.000Z' });
  assert.equal(settings.presetById(store, 'p1').rules, 'r1-new');
  settings.deletePreset(store, 'p2');
  assert.equal(settings.presetById(store, 'p2'), null);
  assert.deepEqual(settings.listPresets(store).map(row => row.id), ['p1']);
});

test('settings:主题包名称唯一与读回/删除', t => {
  const store = fixture(t);
  const light = JSON.stringify({ '--x': 'a' });
  const dark = JSON.stringify({ '--x': 'b' });
  settings.insertThemePack(store, { id: 't1', name: '夜色', light, dark, created: NOW, updated: NOW });
  assert.equal(settings.themeNameTaken(store, '夜色'), true);
  assert.equal(settings.themeNameTaken(store, '黎明'), false);
  const pack = settings.themePackById(store, 't1');
  assert.equal(pack.name, '夜色');
  assert.equal(pack.light, light);
  assert.deepEqual(settings.listThemePacks(store).map(row => row.id), ['t1']);
  settings.deleteThemePack(store, 't1');
  assert.equal(settings.themePackById(store, 't1'), null);
  assert.deepEqual(settings.listThemePacks(store), []);
});

test('settings:附件设置单行默认值与覆盖写', t => {
  const store = fixture(t);
  const defaults = settings.attachmentSettings(store);
  assert.equal(typeof defaults.max_file_bytes, 'undefined'); // DTO 字段为 camelCase
  assert.ok(defaults.maxFileBytes > 0);
  const updated = settings.updateAttachmentSettings(store, {
    maxFileBytes: 1024 * 1024,
    maxFilesPerMessage: 3,
    maxImagePixels: 4_000_000,
  });
  assert.equal(updated.maxFileBytes, 1024 * 1024);
  assert.equal(store.get('SELECT count(*) AS c FROM attachment_settings').c, 1);
  assert.equal(settings.attachmentSettings(store).maxFilesPerMessage, 3);
});

test('conversations:上下文格式存储只写 schema/format 列,可整体清空', t => {
  const store = fixture(t);
  seedGroup(store, 'g', 'lead');
  const conversation = conversations.forMember(store, 'lead', 'coordination');
  // 先写 session/policy,确认格式写入不会覆盖它们。
  conversations.saveBinding(store, conversation.id, 'default', 'sess-1');
  conversations.setPolicySignature(store, conversation.id, 'sig-1', 'default');

  // binding 行存在但未记录格式:schema_version 为 null(与 information 的原查询语义一致)。
  assert.equal(conversations.contextFormat(store, conversation.id, 'default').schema_version, null);
  assert.equal(conversations.latestSchemaForConversation(store, conversation.id), null);
  conversations.saveContextFormat(store, conversation.id, 'default', { schemaVersion: 2, source: 'new-session' });
  let format = conversations.contextFormat(store, conversation.id, 'default');
  assert.equal(format.schema_version, 2);
  assert.equal(format.format_source, 'new-session');
  assert.equal(conversations.latestSchemaForConversation(store, conversation.id), 2);

  // 只写格式列:session 与 policy_signature 保持原值。
  const row = store.get('SELECT session,policy_signature FROM conversation_session_meta WHERE conversation_id=? AND session_key=?', conversation.id, 'default');
  assert.equal(row.session, 'sess-1');
  assert.equal(row.policy_signature, 'sig-1');

  // 覆盖写:同一行更新触发时间,不新增行。
  conversations.saveContextFormat(store, conversation.id, 'default', { schemaVersion: 0, source: 'legacy-detected' });
  assert.equal(store.get('SELECT count(*) AS c FROM conversation_session_meta WHERE conversation_id=?', conversation.id).c, 1);
  format = conversations.contextFormat(store, conversation.id, 'default');
  assert.equal(format.schema_version, 0);
  assert.equal(format.format_source, 'legacy-detected');

  // 按 key 清空后其余绑定保留;全清后整行消失。
  conversations.saveContextFormat(store, conversation.id, 'k2', { schemaVersion: 2, source: 'new-session' });
  conversations.forgetContextFormats(store, conversation.id, 'default');
  assert.equal(conversations.contextFormat(store, conversation.id, 'default'), null);
  assert.equal(conversations.contextFormat(store, conversation.id, 'k2').schema_version, 2);
  conversations.forgetContextFormats(store, conversation.id);
  assert.deepEqual(store.all('SELECT * FROM conversation_session_meta WHERE conversation_id=?', conversation.id), []);
});
});

describe('panel-aggregates', () => {
const NOW = '2026-01-01T00:00:00.000Z';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'panel-aggregates-'));
  const store = new Store(directory);
  t.after(() => {
    store.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  });
  store.run(
    "INSERT INTO groups(id,name,workspace,lead,created,state) VALUES('g1','G1','/tmp',NULL,?,NULL),('g2','G2','/tmp',NULL,?,'active'),('g3','G3','/tmp',NULL,?,'archived')",
    NOW, NOW, NOW,
  );
  return { store };
}

function seedAgent(store) {
  panel.insertAgent(store, { id: 'pa', name: 'Panel', host: 'fake', created: NOW, updated: NOW });
  return 'pa';
}

test('panelAgent 单例与配置读写:insertAgent 唯一约束、updateAgent 覆盖字段', t => {
  const { store } = fixture(t);
  assert.equal(panel.panelAgent(store), null);
  const agentId = seedAgent(store);
  assert.equal(panel.panelAgent(store).id, agentId);
  assert.throws(
    () => panel.insertAgent(store, { id: 'pa2', name: 'Other', host: 'fake', created: NOW, updated: NOW }),
    /UNIQUE constraint failed/,
  );
  panel.updateAgent(store, {
    id: agentId,
    name: 'Panel 2',
    host: 'fake2',
    modelProvider: 'provider',
    model: 'model',
    reasoningEffort: 'high',
    workspace: '/tmp/ws',
    access: 'workspace-write',
    updated: '2026-01-02T00:00:00.000Z',
  });
  const agent = panel.panelAgent(store);
  assert.equal(agent.name, 'Panel 2');
  assert.equal(agent.host, 'fake2');
  assert.equal(agent.model_provider, 'provider');
  assert.equal(agent.model, 'model');
  assert.equal(agent.reasoning_effort, 'high');
  assert.equal(agent.workspace, '/tmp/ws');
  assert.equal(agent.access, 'workspace-write');
  assert.equal(agent.updated, '2026-01-02T00:00:00.000Z');
});

test('authenticateSession 校验会话 key 并回带 Panel Agent 身份', t => {
  const { store } = fixture(t);
  const agentId = seedAgent(store);
  const session = store.conversation('panel_agent', agentId, 'private');
  const authenticated = panel.authenticateSession(store, session.id, session.key);
  assert.equal(authenticated.session.id, session.id);
  assert.equal(authenticated.session.owner_kind, 'panel_agent');
  assert.equal(authenticated.session.owner_id, agentId);
  assert.equal(authenticated.panelAgent.id, agentId);
  assert.throws(() => panel.authenticateSession(store, session.id, 'wrong-key'), /Panel Agent 会话来源无效/);
});

test('ensureBindings 幂等建立 observer 绑定,已有 main 关系不被覆盖', t => {
  const { store } = fixture(t);
  const agentId = seedAgent(store);
  panel.ensureBindings(store, agentId, NOW);
  assert.deepEqual(
    store.all('SELECT group_id,relation FROM panel_team_bindings ORDER BY group_id').map(row => ({ ...row })),
    [
      { group_id: 'g1', relation: 'observer' },
      { group_id: 'g2', relation: 'observer' },
      { group_id: 'g3', relation: 'observer' },
    ],
  );
  store.run("UPDATE panel_team_bindings SET relation='main' WHERE group_id='g1'");
  panel.ensureBindings(store, agentId, '2026-02-01T00:00:00.000Z');
  assert.equal(store.all('SELECT * FROM panel_team_bindings').length, 3);
  assert.equal(panel.bindingRelation(store, agentId, 'g1'), 'main');
  assert.equal(panel.bindingRelation(store, agentId, 'g2'), 'observer');
  assert.equal(panel.bindingRelation(store, agentId, 'missing-group'), 'observer');
  // 未归档团队才进入状态投影。
  assert.deepEqual(panel.activeGroupIds(store).sort(), ['g1', 'g2']);
  assert.deepEqual(panel.activeGroups(store).map(group => group.id).sort(), ['g1', 'g2']);
});

test('私聊消息游标:分页/增量读取/状态投影/最新消息/active_team_id 回填', t => {
  const { store } = fixture(t);
  const agentId = seedAgent(store);
  const ids = [];
  for (let index = 1; index <= 205; index += 1) {
    ids.push(panel.appendMessage(store, agentId, 'private', 'user', `m${index}`, null).id);
  }
  // 协作消息不进入私聊读取面。
  panel.appendMessage(store, agentId, 'coordination', 'assistant', 'coord', 'g1');

  assert.equal(panel.messageText(store, ids[0]).text, 'm1');
  assert.equal(panel.messageText(store, 'missing'), null);
  assert.equal(panel.messageSeq(store, ids[4]), 5);
  assert.equal(panel.messageSeq(store, 'missing'), null);

  // 默认分页:bootSeq 之后,按 seq 降序多取一行(201)用于判定 hasMore。
  const page = panel.privateMessagePage(store, agentId, { bootSeq: 0 });
  assert.equal(page.length, 201);
  assert.equal(page[0].id, ids[204]);
  assert.equal(page.at(-1).id, ids[4]);

  // 历史分页:history=true 取 seq<=bootSeq,before 继续向前。
  const history = panel.privateMessagePage(store, agentId, { history: true, bootSeq: 50, before: 10 });
  assert.deepEqual(history.map(row => row.seq), [9, 8, 7, 6, 5, 4, 3, 2, 1]);

  // 增量:seq 游标之后只取私聊。
  assert.deepEqual(panel.privateMessagesAfter(store, agentId, 200).map(row => row.seq), [201, 202, 203, 204, 205]);

  // 状态投影:最近 200 条按 seq 升序;summary 不带正文列。
  const full = panel.privateMessagesForState(store, agentId);
  assert.equal(full.length, 200);
  assert.equal(full.at(-1).id, ids[204]);
  assert.ok(full[0].seq < full.at(-1).seq);
  assert.ok('text' in full[0]);
  assert.ok(!('text' in panel.privateMessagesForState(store, agentId, true)[0]));

  assert.equal(panel.latestPrivateMessage(store, agentId).id, ids[204]);
  assert.equal(panel.latestPrivateAssistantAfter(store, agentId, 0), null);
  panel.setMessageActiveTeamId(store, ids[0], 'g1');
  assert.equal(panel.messageById(store, ids[0]).active_team_id, 'g1');
  const assistant = panel.appendMessage(store, agentId, 'private', 'assistant', 'answer', null);
  assert.equal(panel.latestPrivateAssistantAfter(store, agentId, 205)?.id, assistant.id);
  assert.equal(panel.latestPrivateAssistantAfter(store, agentId, assistant.seq), null);
});

test('面板更新只追加,通知投影被 workbench_dismissals 过滤', t => {
  const { store } = fixture(t);
  const agentId = seedAgent(store);
  panel.insertUpdate(store, { id: 'u1', panelAgentId: agentId, groupId: 'g1', text: 'first', created: '2026-01-01T00:00:00.000Z' });
  panel.insertUpdate(store, {
    id: 'u2',
    panelAgentId: agentId,
    groupId: 'g2',
    kind: 'continuation',
    text: 'second',
    sourceMessageIds: ['m1'],
    created: '2026-01-02T00:00:00.000Z',
  });
  assert.deepEqual(panel.notifications(store, agentId).map(row => row.id), ['u2', 'u1']);
  assert.equal(panel.updateById(store, 'u2').kind, 'continuation');
  assert.equal(panel.updateById(store, 'missing'), null);
  store.run("INSERT INTO workbench_dismissals(category,item_id,created) VALUES('panel:update','u2',?)", NOW);
  assert.deepEqual(panel.notifications(store, agentId).map(row => row.id), ['u1']);
});

test('互动卡与控制者:待处理计数、待定控制卡回读、主控行读取', t => {
  const { store } = fixture(t);
  const agentId = seedAgent(store);
  store.run(
    "INSERT INTO team_lead_controllers(group_id,controller_kind,controller_id,state,original_lead_id,revision,updated) VALUES('g1','panel_agent',?,'active',NULL,1,?)",
    agentId, NOW,
  );
  assert.equal(panel.controller(store, 'g1').revision, 1);
  assert.equal(panel.controller(store, 'g2'), null);

  const create = (id, groupId, kind) => store.createInteraction({
    id,
    groupId,
    panelAgentId: agentId,
    endpointId: 'session',
    context: 'private',
    turnId: '',
    callId: '',
    kind,
    payload: { baseRevision: 1 },
  });
  create('i1', 'g1', 'takeover');
  create('i2', 'g1', 'choice');
  create('i3', 'g1', 'takeover');
  create('i4', 'g2', 'takeover');
  store.setInteractionState('i3', 'answered', { value: 'ok' });
  assert.deepEqual(panel.pendingInteractionCounts(store), { g1: 2, g2: 1 });
  assert.equal(panel.pendingPanelInteraction(store, { panelAgentId: agentId, groupId: 'g1', kind: 'takeover' }).id, 'i1');
  assert.equal(panel.pendingPanelInteraction(store, { panelAgentId: agentId, groupId: 'g1', kind: 'member_model' }), null);
});

test('私聊幂等记录:panelPrivateOperation 回读 payload/ref,同 key 唯一', t => {
  const { store } = fixture(t);
  const agentId = seedAgent(store);
  panel.insertPanelPrivateOperation(store, { panelAgentId: agentId, clientKey: 'c1', payload: 'hash1', ref: 'm1', created: NOW });
  const record = panel.panelPrivateOperation(store, agentId, 'c1');
  assert.equal(record.scope, 'panel-private-message');
  assert.equal(record.scope_id, agentId);
  assert.equal(record.client_key, 'c1');
  assert.equal(record.payload, 'hash1');
  assert.equal(record.ref, 'm1');
  assert.equal(panel.panelPrivateOperation(store, agentId, 'missing'), null);
  assert.throws(
    () => panel.insertPanelPrivateOperation(store, { panelAgentId: agentId, clientKey: 'c1', payload: 'hash2', ref: 'm2', created: NOW }),
    /UNIQUE constraint failed/,
  );
});

test('附件绑定投影:同一面板消息只出现一次,其它 Agent 不复用', t => {
  const { store } = fixture(t);
  const agentId = seedAgent(store);
  const message = panel.appendMessage(store, agentId, 'private', 'user', 'with files', null);
  const plain = panel.appendMessage(store, agentId, 'private', 'user', 'no files', null);
  const insertAttachment = (id, panelMessageId, ordinal) => store.run(
    'INSERT INTO attachments(id,panel_agent_id,original_name,media_type,size,storage_name,created_at,panel_message_id,ordinal) VALUES(?,?,?,?,?,?,?,?,?)',
    id, agentId, `${id}.txt`, 'text/plain', 3, `${id}-storage`, NOW, panelMessageId, ordinal,
  );
  insertAttachment('a1', message.id, 0);
  insertAttachment('a2', message.id, 1);
  assert.deepEqual(panel.panelMessageIdsWithAttachments(store, agentId), [message.id]);
  assert.deepEqual(panel.panelMessageIdsWithAttachments(store, 'other-agent'), []);
  assert.equal(panel.messageById(store, plain.id).id, plain.id);
});
});

describe('event-log', () => {
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'agent-eventlog-'));
  const store = new Store(directory);
  // 手工补一条 panel session,事件表有外键约束。
  store.run(
    "INSERT INTO panel_agents(id,name,host,created,updated) VALUES('a','P','dsh','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')",
  );
  store.run(
    "INSERT INTO conversations(id,group_id,panel_agent_id,context,key,created,updated) VALUES('s',NULL,'a','private','secret','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')",
  );
  const group = store.run(
    "INSERT INTO groups(id,name,workspace,created,policy) VALUES('g','G','/tmp','2026-01-01T00:00:00.000Z','workspace-write')",
  );
  return { directory, store, group };
}

function rows(store, sql) {
  return store.all(sql).map(row => ({ ...row, event: JSON.parse(row.event) }));
}

test('coalesces consecutive token deltas of one stream into a single row', () => {
  const { directory, store } = fixture();
  // 用假定时器接管刷新,验证合并发生在 flush 之前。
  const log = new EventLog(store, { flushMs: 60000 });
  try {
    for (const text of ['你', '好', '！']) {
      assert.equal(log.panel('s', { type: 'framework.reasoning.delta', text }, 't1'), null);
    }
    assert.equal(rows(store, 'SELECT * FROM history').length, 0, 'flush 前不应落库');
    log.flush();
    const stored = rows(store, 'SELECT * FROM history ORDER BY seq');
    assert.equal(stored.length, 1);
    assert.equal(stored[0].event.type, 'framework.reasoning.delta');
    assert.equal(stored[0].event.text, '你好！');
    assert.equal(stored[0].event.coalesced, 3);
    assert.ok(stored[0].event.from && stored[0].event.to);
  } finally {
    log.close();
    store.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  }
});

test('flushes pending deltas before a structured event so seq order is preserved', () => {
  const { directory, store } = fixture();
  const log = new EventLog(store, { flushMs: 60000 });
  try {
    log.panel('s', { type: 'framework.reasoning.delta', text: '思考' }, 't1');
    // 结构化事件必须立刻可见,且排在增量之后。
    const seq = log.panel('s', { type: 'framework.tool_call', name: 'teams_list' }, 't1');
    assert.equal(typeof seq, 'number');
    const stored = rows(store, 'SELECT * FROM history ORDER BY seq');
    assert.deepEqual(stored.map(row => row.event.type), [
      'framework.reasoning.delta',
      'framework.tool_call',
    ]);
  } finally {
    log.close();
    store.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  }
});

test('keeps different streams and different payload kinds apart', () => {
  const { directory, store } = fixture();
  const log = new EventLog(store, { flushMs: 60000 });
  try {
    log.panel('s', { type: 'framework.reasoning.delta', text: 'A' }, 't1');
    // 交错到达的另一条流:不能合并进上一行。
    log.panel('s', { type: 'framework.reasoning.delta', text: 'B' }, 't2');
    log.panel('s', { type: 'framework.reasoning.delta', text: 'C' }, 't1');
    // claude 的 thinking 增量与 text 增量是不同载荷。
    log.panel('s', { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'X' } } }, 't1');
    log.panel('s', { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Y' } } }, 't1');
    log.flush();
    const stored = rows(store, 'SELECT * FROM history ORDER BY seq');
    // 同一流的增量即使在缓冲里被别的流插队,也合并回同一行(A + C);
    // 不同流、不同载荷各自成行。
    assert.equal(stored.length, 4);
    assert.deepEqual(
      stored.filter(row => row.event.type === 'framework.reasoning.delta').map(row => row.event.text).sort(),
      ['AC', 'B'],
    );
  } finally {
    log.close();
    store.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  }
});

test('member history returns null for private endpoints and stores elsewhere', () => {
  const { directory, store } = fixture();
  const log = new EventLog(store, { flushMs: 60000 });
  try {
    // private 端点写入 history 的语义是"不记录",必须保持返回 null。
    for (const [id, memberId, context, key] of [
      ['e1', 'm1', 'private', 'k1'],
      ['e2', 'm2', 'coordination', 'k2'],
    ]) {
      store.run(
        "INSERT INTO members(id,group_id,name,host,role) VALUES(?,'g',?,'dsh','member')",
        memberId,
        memberId,
      );
      store.run(
        'INSERT INTO conversations(id,group_id,member_id,context,key,created,updated) VALUES(?,?,?,?,?,?,?)',
        id,
        'g',
        memberId,
        context,
        key,
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
      );
    }
    assert.equal(log.member('e1', { type: 'framework.text.delta', text: 'x' }, null), null);
    log.member('e2', { type: 'framework.text.delta', text: 'y' }, null);
    log.flush();
    const stored = rows(store, 'SELECT * FROM history ORDER BY seq');
    assert.equal(stored.length, 1);
    assert.equal(stored[0].event.text, 'y');
  } finally {
    log.close();
    store.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  }
});
});

describe('group-deletion-cleanup', () => {
test('deletion removes non-FK team records and snapshot, retaining unrelated and private data', async t => {
  const { bus, group, directory } = busScenario(t, { members: [], profileText: null });
  await until(() => !bus.running.size);
  const agent = seedPanelAgent(bus, { host: 'fake' });
  const other = bus.createGroup({ name: 'other', workspace: directory, lead: { name: 'other lead', host: 'fake' }, members: [] });
  await until(() => !bus.running.size);
  const endpoint = bus.store.endpoint(group.lead, 'coordination');
  const message = bus.store.append(group.id, group.lead, 'user', 'send', 'delete');
  const ask = bus.store.createInteraction({ id: 'audit-card', groupId: group.id, memberId: group.lead, endpointId: endpoint.id, context: 'coordination', turnId: '', callId: 'audit-call', messageId: message.id, kind: 'input', payload: { text: 'question' } });
  bus.store.dismissWorkbench('interaction', ask.id);
  bus.store.dismissWorkbench('waiting:user', message.id);
  bus.store.dismissWorkbench('waiting:agent', message.id);
  bus.store.dismissWorkbench('waiting:user', 'unrelated');
  bus.telemetry.rotateSession(endpoint.id, 'default');
  const privateMessage = bus.store.panelAppend(agent, 'private', 'user', 'keep private', group.id);
  bus.store.panelAppend(agent, 'coordination', 'assistant', 'delete coordination', group.id);
  const file = join(directory, 'project.txt');
  writeFileSync(file, 'keep');
  await bus.archiveGroup(group.id);
  bus.summarizeArchive(group.id);
  await until(() => !bus.archiveSnapshot(group.id).generating);
  await bus.deleteGroup(group.id);
  for (const table of ['members', 'messages', 'conversations', 'turns', 'interactions', 'agent_tasks', 'archive_snapshots', 'information_measurements']) {
    assert.equal(bus.store.get(`SELECT count(*) n FROM ${table} WHERE group_id=?`, group.id).n, 0, table);
  }
  assert.equal(bus.store.get('SELECT count(*) n FROM telemetry_session_generations WHERE endpoint_id=?', endpoint.id).n, 0);
  assert.deepEqual(bus.store.all('SELECT item_id FROM workbench_dismissals').map(row => row.item_id), ['unrelated']);
  assert.equal(bus.store.get('SELECT count(*) n FROM panel_messages WHERE active_team_id=?', group.id).n, 0);
  assert.equal(bus.store.get('SELECT text FROM panel_messages WHERE id=?', privateMessage.id).text, 'keep private');
  assert.equal(bus.store.group(other.id).name, 'other');
  assert.equal(readFileSync(file, 'utf8'), 'keep');
  assert.deepEqual(bus.store.all('PRAGMA foreign_key_check'), []);
});

test('a failed final team delete rolls back earlier non-FK cleanup', async t => {
  const { bus, group } = busScenario(t, { members: [], profileText: null });
  await until(() => !bus.running.size);
  const agent = seedPanelAgent(bus, { host: 'fake' });
  const endpoint = bus.store.endpoint(group.lead, 'coordination');
  const message = bus.store.append(group.id, group.lead, 'user', 'send', 'retain on rollback');
  bus.store.dismissWorkbench('waiting:agent', message.id);
  bus.telemetry.rotateSession(endpoint.id, 'default');
  const panelMessage = bus.store.panelAppend(agent, 'coordination', 'assistant', 'retain', group.id);
  bus.store.db.exec("CREATE TEMP TRIGGER block_delete BEFORE DELETE ON groups BEGIN SELECT RAISE(ABORT,'delete blocked'); END");
  await assert.rejects(bus.deleteGroup(group.id), /delete blocked/);
  assert.ok(bus.store.group(group.id));
  assert.ok(bus.store.get('SELECT 1 FROM workbench_dismissals WHERE item_id=?', message.id));
  assert.ok(bus.store.get('SELECT 1 FROM telemetry_session_generations WHERE endpoint_id=?', endpoint.id));
  assert.ok(bus.store.get('SELECT 1 FROM panel_messages WHERE id=?', panelMessage.id));
  assert.ok(bus.store.get('SELECT 1 FROM information_measurements WHERE group_id=?', group.id));
});

test('deletion waits for executor completion callbacks, not only the host result', async t => {
  const { bus, group } = busScenario(t, { members: [], profileText: null });
  await until(() => !bus.running.size);
  let complete;
  const original = bus.turnExecutor.run.bind(bus.turnExecutor);
  bus.turnExecutor.run = config => original({ ...config, onComplete: () => new Promise(resolve => { complete = resolve; }) });
  const running = bus.privateTurn(group.id, 'finish callback');
  await until(() => complete);
  let deleted = false;
  const deleting = bus.deleteGroup(group.id).then(() => { deleted = true; });
  await new Promise(resolve => setImmediate(resolve));
  const deletedEarly = deleted;
  complete();
  await running;
  await deleting;
  assert.equal(deletedEarly, false);
  assert.equal(bus.running.size, 0);
});
});

describe('group-deletion', () => {
async function fixture(t, run = null) {
  const f = busScenario(t, { members: [], profileText: null, run });
  await until(() => !f.bus.running.size);
  return f;
}

test('a failed database cleanup leaves the team accessible and can be retried', async t => {
  const { bus, group } = await fixture(t);
  bus.store.db.exec("CREATE TEMP TRIGGER block_cleanup BEFORE DELETE ON information_measurements BEGIN SELECT RAISE(ABORT,'cleanup blocked'); END");
  await assert.rejects(bus.deleteGroup(group.id), /cleanup blocked/);
  assert.equal(bus.groupSummary(group.id).communicationOpen, true);
  bus.store.db.exec('DROP TRIGGER block_cleanup');
  assert.deepEqual(await bus.deleteGroup(group.id), { deleted: group.id });
  assert.throws(() => bus.groupSummary(group.id), /找不到|不存在/);
});

test('delete confirmation awaits failure and exposes a failed card instead of success', async t => {
  const { bus, group } = await fixture(t);
  const endpoint = bus.store.endpoint(group.lead, 'coordination');
  const card = await bus.tool(endpoint.id, endpoint.key, 'group_delete', {});
  bus.store.db.exec("CREATE TEMP TRIGGER block_delete BEFORE DELETE ON groups BEGIN SELECT RAISE(ABORT,'deletion blocked'); END");
  await assert.rejects(Promise.resolve(bus.decideInteraction(card.id, { approved: true })), /deletion blocked/);
  assert.equal(bus.groupSummary(group.id).communicationOpen, true);
  assert.throws(() => bus.decideInteraction(card.id, { approved: false }), /已经结束/);
});

test('deletion prevents new runs while awaiting an existing host and stops the full run', async t => {
  let finish;
  let signal;
  const { bus, group } = await fixture(t, context => {
    signal = context.signal;
    return new Promise(resolve => { finish = resolve; });
  });
  const running = bus.privateTurn(group.id, 'existing run');
  await until(() => finish);
  const deleting = bus.deleteGroup(group.id);
  await until(() => signal.aborted);
  let attempt;
  try {
    attempt = await bus.runEndpoint(bus.store.endpoint(group.lead, 'coordination'), 'new run');
  } catch (error) { attempt = error; }
  finally { finish('stopped'); }
  await running;
  await deleting;
  assert.match(attempt?.message ?? '', /正在删除/);
  assert.equal(bus.running.size, 0);
});


test('deleting an archived team waits for summary cancellation and leaves no late snapshot', async t => {
  let finish;
  let signal;
  const { bus, group } = await fixture(t, context => {
    signal = context.signal;
    return new Promise(resolve => { finish = resolve; });
  });
  seedPanelAgent(bus, { host: 'fake' });
  await bus.archiveGroup(group.id);
  bus.summarizeArchive(group.id);
  await until(() => finish);
  const deleting = bus.deleteGroup(group.id, { archivedOnly: true });
  await until(() => signal.aborted);
  finish('late summary');
  await deleting;
  assert.throws(() => bus.archiveSnapshot(group.id), /不存在/);
  assert.equal(bus.archiveSnapshots.pending.size, 0);
  assert.equal(bus.running.size, 0);
});
});
