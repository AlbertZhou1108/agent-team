// panel 域聚合不变式:Agent 单例与配置、团队绑定、私聊消息游标、更新/通知投影、
// 互动卡与控制者、私聊幂等记录、附件绑定投影。
// 这些是内部表示断言(internal 层),随聚合实现重写时同步更新。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store.mjs';
import * as panel from '../../src/aggregates/panel.mjs';

const NOW = '2026-01-01T00:00:00.000Z';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'panel-aggregates-'));
  const store = new Store(directory);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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
