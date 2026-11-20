// 桌面域内部表示:主控 workspace 切换流程、团队主控关系与桌面应用注册表。
// 这些是行级事实(事件历史、会话失效、关系 origin),由 internal 层钉住;
// 对外行为由 contract/desktop-controller.test.mjs 经控制工具断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../store.mjs';
import * as externalAgg from '../../aggregates/external-control.mjs';
import * as teamsAgg from '../../aggregates/teams.mjs';

const NOW = '2026-01-01T00:00:00.000Z';

function tempDir(t) {
  const directory = mkdtempSync(join(tmpdir(), 'desktop-flow-'));
  t.after(() => { try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* Windows 上文件可能仍被占用 */ } });
  return directory;
}

/** 一位桌面主控 + 一个带成员会话的团队;返回 store 与关键 id。 */
function seedControllerTeam(t, { workspace = '/w1', memberSession = 'native-1', runningTurn = false } = {}) {
  const store = new Store(tempDir(t));
  const now = NOW;
  store.run("INSERT INTO external_principals(id,name,created,updated) VALUES('p1','本机用户',?,?)", now, now);
  store.run(
    `INSERT INTO external_client_bindings(id,principal_id,name,host,key_hash,session,declared_capabilities,surface,controller_cwd,status,created,updated)
     VALUES('b1','p1','桌面会话','codex','hash','thread-1','[]','desktop',?,'active',?,?)`,
    workspace, now, now,
  );
  store.run("INSERT INTO groups(id,name,workspace,lead,created,charter,policy,allow_shell) VALUES('g1','G',?,NULL,?,NULL,'read-only',0)", workspace, now);
  store.run(
    `INSERT INTO team_lead_controllers(group_id,controller_kind,controller_id,controller_binding_id,state,original_lead_id,revision,updated)
     VALUES('g1','external_agent','p1','b1','active',NULL,1,?)`,
    now,
  );
  externalAgg.establishRelation(store, { groupId: 'g1', principalId: 'p1', bindingId: 'b1', origin: 'creator', created: now, now });
  store.run("INSERT INTO members(id,group_id,name,host,role) VALUES('m1','g1','成员','fake','member')");
  store.run("INSERT INTO conversations(id,group_id,member_id,panel_agent_id,context,session,key,created,updated) VALUES('c1','g1','m1',NULL,'pair:lead',?,'k1',?,?)", memberSession, now, now);
  if (runningTurn) {
    store.run("INSERT INTO turns(id,conversation_id,executor_kind,executor_id,group_id,state,created) VALUES('t1','c1','member','m1','g1','running',?)", now);
  }
  return { store };
}

test('requestControllerWorkspace applies immediately when no turn is running and invalidates member sessions', t => {
  const { store } = seedControllerTeam(t, { workspace: '/w1', memberSession: 'native-1' });
  const result = externalAgg.requestControllerWorkspace(store, { groupId: 'g1', cwd: '/w2', now: NOW });
  assert.deepEqual(result, { changed: true, pending: false });
  const group = store.get('SELECT workspace,workspace_pending,workspace_revision FROM groups WHERE id=?', 'g1');
  assert.equal(group.workspace, '/w2');
  assert.equal(group.workspace_pending, null);
  assert.equal(group.workspace_revision, 1);
  // 旧目录上下文的成员会话被失效。
  assert.equal(store.get('SELECT session FROM conversations WHERE id=?', 'c1').session, null);
  const events = teamsAgg.workspaceEvents(store, 'g1');
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'applied');
  assert.equal(events[0].from_path, '/w1');
  assert.equal(events[0].to_path, '/w2');
  assert.equal(events[0].revision, 1);
});

test('requestControllerWorkspace defers while a turn is running and settles afterwards', t => {
  const { store } = seedControllerTeam(t, { workspace: '/w1', runningTurn: true });
  const result = externalAgg.requestControllerWorkspace(store, { groupId: 'g1', cwd: '/w2', now: NOW });
  assert.deepEqual(result, { changed: true, pending: true });
  const group = store.get('SELECT workspace,workspace_pending FROM groups WHERE id=?', 'g1');
  assert.equal(group.workspace, '/w1');
  assert.equal(group.workspace_pending, '/w2');
  // 成员会话仍指旧目录上下文;派发守卫此刻应拦下新工。
  assert.equal(store.get('SELECT session FROM conversations WHERE id=?', 'c1').session, 'native-1');
  assert.equal(teamsAgg.hasPendingWorkspace(store, 'g1'), true);

  // 运行回合未结算:结算跳过。
  assert.deepEqual(externalAgg.settlePendingWorkspaces(store, NOW), []);
  assert.equal(store.get('SELECT workspace FROM groups WHERE id=?', 'g1').workspace, '/w1');

  // 旧回合结算 → 生效并清会话。
  store.run("UPDATE turns SET state='completed' WHERE id=?", 't1');
  assert.deepEqual(externalAgg.settlePendingWorkspaces(store, NOW), ['g1']);
  assert.equal(store.get('SELECT workspace FROM groups WHERE id=?', 'g1').workspace, '/w2');
  assert.equal(store.get('SELECT session FROM conversations WHERE id=?', 'c1').session, null);
  const kinds = teamsAgg.workspaceEvents(store, 'g1').map(event => event.kind);
  assert.deepEqual(kinds, ['pending', 'applied']);
});

test('requesting the effective workspace again cancels a pending switch and keeps the effective directory', t => {
  const { store } = seedControllerTeam(t, { workspace: '/w1', runningTurn: true });
  externalAgg.requestControllerWorkspace(store, { groupId: 'g1', cwd: '/w2', now: NOW });
  // 用户中途改回生效目录:待定切换取消并留痕,生效目录不变。
  const result = externalAgg.requestControllerWorkspace(store, { groupId: 'g1', cwd: '/w1', now: NOW });
  assert.deepEqual(result, { changed: false });
  const group = store.get('SELECT workspace,workspace_pending FROM groups WHERE id=?', 'g1');
  assert.equal(group.workspace, '/w1');
  assert.equal(group.workspace_pending, null);
  const kinds = teamsAgg.workspaceEvents(store, 'g1').map(event => event.kind);
  assert.deepEqual(kinds, ['pending', 'cancelled']);
  // 相同目录重复上报是无变化,不产生事件噪音。
  const repeated = externalAgg.requestControllerWorkspace(store, { groupId: 'g1', cwd: '/w1', now: NOW });
  assert.deepEqual(repeated, { changed: false });
  assert.equal(teamsAgg.workspaceEvents(store, 'g1').length, 2);
});

test('controller relations keep every past binding; takeover moves the seat and keeps history read-only', t => {
  const { store } = seedControllerTeam(t, { workspace: '/w1' });
  store.run(
    `INSERT INTO external_client_bindings(id,principal_id,name,host,key_hash,session,declared_capabilities,surface,status,created,updated)
     VALUES('b2','p1','第二个会话','codex','hash2','thread-2','[]','desktop','active',?,?)`,
    NOW, NOW,
  );
  // 同用户凭精确团队 ID 接管:确立 takeover 关系并移交席位。
  const takeover = externalAgg.takeoverTeam(store, { groupId: 'g1', principalId: 'p1', bindingId: 'b2', now: NOW });
  assert.equal(takeover.previousBindingId, 'b1');
  assert.equal(store.get('SELECT controller_binding_id FROM team_lead_controllers WHERE group_id=?', 'g1').controller_binding_id, 'b2');
  assert.equal(store.get('SELECT revision FROM team_lead_controllers WHERE group_id=?', 'g1').revision, 2);

  const relations = externalAgg.relationsForTeam(store, 'g1');
  assert.equal(relations.length, 2);
  assert.equal(relations.find(row => row.binding_id === 'b1').origin, 'creator');
  assert.equal(relations.find(row => row.binding_id === 'b2').origin, 'takeover');

  // 列表按关系收口:b2 活跃,b1 保留可见但不再是席位。
  const teamsB2 = externalAgg.teamsForBinding(store, 'b2');
  assert.equal(teamsB2.length, 1);
  assert.equal(teamsB2[0].controller_binding_id, 'b2');
  const teamsB1 = externalAgg.teamsForBinding(store, 'b1');
  assert.equal(teamsB1.length, 1);
  assert.equal(teamsB1[0].controller_binding_id, 'b2');
  // 无关 binding 看不到该团队。
  store.run(
    `INSERT INTO external_client_bindings(id,principal_id,name,host,key_hash,session,declared_capabilities,status,created,updated)
     VALUES('b3','p1','第三个会话','codex','hash3','thread-3','[]','active',?,?)`,
    NOW, NOW,
  );
  assert.deepEqual(externalAgg.teamsForBinding(store, 'b3'), []);

  // 接管把团队 workspace 跟到新主控会话目录(无运行回合 → 立即生效)。
  externalAgg.requestControllerWorkspace(store, { groupId: 'g1', cwd: '/w2', now: NOW });
  assert.equal(store.get('SELECT workspace FROM groups WHERE id=?', 'g1').workspace, '/w2');
});

test('desktop application registry upserts per installation and records one user-visible readiness', t => {
  const store = new Store(tempDir(t));
  const first = externalAgg.upsertApplication(store, {
    id: 'app1', kind: 'codex', installPath: '/Applications/ChatGPT.app',
    enginePath: '/engine/codex', engineVersion: '0.169.1', created: NOW,
  });
  assert.equal(first.created, true);
  const redetect = externalAgg.upsertApplication(store, {
    id: 'app2', kind: 'codex', installPath: '/Applications/ChatGPT.app', engineVersion: '0.170.0', created: NOW,
  });
  assert.equal(redetect.created, false);
  assert.equal(redetect.id, 'app1');
  assert.equal(redetect.engine_version, '0.170.0');
  // surface 把 Codex Desktop 与 CLI-only Codex 区分为两行。
  externalAgg.upsertApplication(store, {
    id: 'app3', kind: 'codex', surface: 'cli', installPath: '/usr/local/bin/codex', created: NOW,
  });
  assert.equal(externalAgg.applications(store).length, 2);
  const verified = externalAgg.setApplicationVerification(store, 'app1', {
    readiness: 'available',
    pullOnly: true,
    controllerState: 'controller ok',
    engineState: 'engine ok',
    diagnostics: { controller: 'ok', engine: 'ok' },
    fingerprint: 'fp-1',
    verifiedAt: NOW,
    lifecycleNote: '成员执行需要应用保持运行',
  });
  assert.equal(verified.readiness, 'available');
  assert.equal(verified.pull_only, 1);
  assert.deepEqual(JSON.parse(verified.diagnostics), { controller: 'ok', engine: 'ok' });
  assert.throws(
    () => externalAgg.setApplicationVerification(store, 'app1', { readiness: 'half-usable' }),
    /未知应用就绪状态/,
  );
  store.close();
});
