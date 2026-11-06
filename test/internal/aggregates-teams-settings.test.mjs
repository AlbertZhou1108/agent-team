// 团队域与设置域聚合不变式:groups/members/role_names/team_lead_controllers/
// agent_tasks/operation_records(团队创建幂等) 与 model policy/preset/theme pack/附件设置,
// 以及本轮为 information 迁移补齐的 conversation_session_meta 上下文格式存储。
// internal 层直接断言内部表示。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store.mjs';
import { Collaboration } from '../../src/collaboration.mjs';
import { TeamRequests } from '../../src/team-requests.mjs';
import * as teams from '../../src/aggregates/teams.mjs';
import * as settings from '../../src/aggregates/settings.mjs';
import * as conversations from '../../src/aggregates/conversations.mjs';

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
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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
