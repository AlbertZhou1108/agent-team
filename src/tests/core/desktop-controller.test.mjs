import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, realpathSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../../bus.mjs';
import { createExternalIdentity } from '../../control-plane.mjs';
import { CONTROL_CAPABILITIES } from '../../control-capabilities.mjs';
import { fakeHost, serverScenario } from '../support/fixture.mjs';
import { until } from '../support/wait.mjs';
import { Store } from '../../store.mjs';
import * as externalAgg from '../../aggregates/external-control.mjs';
import * as teamsAgg from '../../aggregates/teams.mjs';
import { SURFACES, surfaceFollowsConversation } from '../../hosts/definitions.mjs';
import { installCodexDesktopIntegration } from '../../desktop/codex.mjs';
import { detectDesktopApplications, installDesktopIntegration, DESKTOP_DEFINITIONS, claudeEngineCandidates, defaultClaudeConfigDir, desktopDetectionContext, parseWindowsMsixRegistryOutput, readAsarPackageVersion, readBundleVersion, zcodeDesktopLaunchCommand } from '../../desktop/index.mjs';
import { DESKTOP_HOSTS_FILE, readDesktopHostSpecs, removeDesktopHostSpec, writeDesktopHostSpec } from '../../desktop/member-hosts.mjs';
import { handleRpc, loadHosts } from '../../server.mjs';
import { isolatedHomeEnv, resolveZcodeLaunch, zcodeAppPaths } from '../../member/zcode/wake.mjs';
import { launchEnvironment } from '../../launcher.mjs';
import { windowsPrivateAclArgs } from '../../private-permissions.mjs';
import { spawnHost } from '../../host-runtime/subprocess.mjs';
import { badgeCount } from '../../../electron/service.mjs';
import { badgeLabel, badgeOverlayPng } from '../../../electron/badge.mjs';
import { pickDirectory } from '../../../electron/dialogs.mjs';
import { applicationMenuTemplate, desktopMenuState, windowChromeOptions } from '../../../electron/menus.mjs';

describe('desktop-controller', () => {
function setup(t, { run = null } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-desktop-'));
  mkdirSync(join(directory, 'w1'), { recursive: true });
  mkdirSync(join(directory, 'w2'), { recursive: true });
  const host = fakeHost({
    run: run ?? (async context => {
      context.onAccepted();
      await context.onTool('send', { to: '主 Agent', text: '成员已经收到。' });
      return 'host final';
    }),
  });
  const wakeCalls = [];
  const bus = new Bus({
    directory,
    hosts: new Map([['fake', host]]),
    controlSocketPath: join(directory, 'bus.sock'),
    externalWake: async (binding, options) => {
      wakeCalls.push({ binding, options });
      return { supported: true, state: 'started', mode: 'test' };
    },
  });
  t.after(async () => {
    if (!bus.closing) await bus.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  });
  const declared = {
    capabilities: Object.values(CONTROL_CAPABILITIES),
    workspaceRoots: [directory],
    policies: ['communication', 'read-only', 'workspace-write'],
  };
  const identityA = createExternalIdentity(bus.store, {
    principalName: '本机用户',
    bindingName: 'CLI 会话',
    host: 'codex',
    session: 'cli-thread',
    declared,
  });
  const identityB = createExternalIdentity(bus.store, {
    principalName: '本机用户',
    bindingName: '桌面会话',
    host: 'codex',
    session: 'desktop-thread',
    declared,
    surface: 'desktop',
  });
  const call = (identity, name, args = {}, hostCwd = null) =>
    bus.controlTool(identity.binding.id, identity.key, name, args, undefined, null, false, hostCwd);
  // 与 team_create 的 realpath 对齐(macOS /var 是 /private/var 的符号链接)。
  const w1 = realpathSync(join(directory, 'w1'));
  const w2 = realpathSync(join(directory, 'w2'));
  return { bus, directory, identityA, identityB, call, wakeCalls, w1, w2 };
}

test('independent controller conversations list only their own teams; a sibling may inspect by exact id but not write', async t => {
  const { bus, identityA, identityB, call, w1 } = setup(t);
  const created = await call(identityA, 'team_create', {
    name: 'A 的团队',
    workspace: w1,
    members: '成员=fake',
    policy: 'read-only',
  });
  await until(() => bus.running.size === 0, 'profile turns did not settle');

  const teamsA = await call(identityA, 'control_teams');
  assert.equal(teamsA.teams.length, 1);
  assert.equal(teamsA.teams[0].active, true);
  const teamsB = await call(identityB, 'control_teams');
  assert.deepEqual(teamsB.teams, []);

  // 凭精确团队 ID 可以检视(读),但写仍要求活跃席位。
  const snapshot = await call(identityB, 'team_snapshot', { teamId: created.team.id });
  assert.equal(snapshot.team.id, created.team.id);
  await assert.rejects(
    () => call(identityB, 'team_send', { teamId: created.team.id, to: '成员', text: '越权派工' }),
    /不是团队当前 active controller session/,
  );
});

test('a sibling conversation takes over by exact team id; the previous controller keeps read-only access', async t => {
  const { bus, identityA, identityB, call, wakeCalls, w1 } = setup(t);
  const created = await call(identityA, 'team_create', {
    name: '移交团队',
    workspace: w1,
    members: '成员=fake',
    policy: 'read-only',
  });
  await until(() => bus.running.size === 0, 'profile turns did not settle');
  await call(identityB, 'control_accept_pull_only');

  const activated = await call(identityB, 'team_activate', { teamId: created.team.id });
  assert.equal(activated.activeBindingId, identityB.binding.id);

  // 接管事件对读的人可见;旧主控被尽力唤醒。
  const read = await call(identityB, 'team_read', { teamId: created.team.id });
  assert.ok(read.messages.some(m => m.kind === 'system' && m.preview.includes('主控已切换')), '缺少接管事件');
  await until(
    () => wakeCalls.some(w => w.binding.id === identityA.binding.id && String(w.options.teamName).includes('主控已移交')),
    'previous controller was not woken',
  );

  // 旧会话保留关系(active=false 只读),新会话活跃可写。
  const teamsA = await call(identityA, 'control_teams');
  assert.equal(teamsA.teams.length, 1);
  assert.equal(teamsA.teams[0].active, false);
  const teamsB = await call(identityB, 'control_teams');
  assert.equal(teamsB.teams[0].active, true);
  await assert.rejects(
    () => call(identityA, 'team_send', { teamId: created.team.id, to: '成员', text: '旧主控还想派工' }),
    /不是团队当前 active controller session/,
  );
  await call(identityB, 'team_send', { teamId: created.team.id, to: '成员', text: '新主控派工' });
});

test('a desktop controller conversation supplies the team workspace and follows directory changes immediately', async t => {
  const { bus, identityA, identityB, call, w1, w2 } = setup(t);

  // 桌面会话建群不传 workspace:跟随主控会话当前目录。
  await call(identityB, 'control_status', {}, w1);
  const created = await call(identityB, 'team_create', { name: '跟随团队', members: '成员=fake', policy: 'read-only' });
  assert.equal(created.team.workspace, w1);
  await until(() => bus.running.size === 0, 'profile turns did not settle');

  // 无运行回合:目录变化立即生效。
  await call(identityB, 'control_status', {}, w2);
  const snapshot = await call(identityB, 'team_snapshot', { teamId: created.team.id });
  assert.equal(snapshot.team.workspace, w2);
  assert.equal(snapshot.team.workspace_pending, null);

  // CLI 连接只记录 cwd,不移动团队目录。
  await call(identityA, 'team_create', {
    name: 'CLI 团队',
    workspace: w1,
    members: '成员=fake',
    policy: 'read-only',
  });
  await until(() => bus.running.size === 0, 'second profile turn did not settle');
  const cliTeamId = (await call(identityA, 'control_teams')).teams.find(team => team.name === 'CLI 团队').id;
  await call(identityA, 'control_status', {}, w2);
  const cliSnapshot = await call(identityA, 'team_snapshot', { teamId: cliTeamId });
  assert.equal(cliSnapshot.team.workspace, w1);
});

test('a workspace switch during an in-flight turn becomes pending, blocks dispatch, then settles', async t => {
  let release = null;
  const { bus, identityB, call, w1, w2 } = setup(t, {
    run: async context => {
      context.onAccepted();
      if (release) {
        // 结算后按新目录重建的回合:直接完成并回复。
        await context.onTool('send', { to: '主 Agent', text: '新目录工作完成' });
        return 'done in new workspace';
      }
      await new Promise(resolve => { release = resolve; });
      await context.onTool('send', { to: '主 Agent', text: '旧目录工作完成' });
      return 'done in old workspace';
    },
  });
  await call(identityB, 'control_status', {}, w1);
  const created = await call(identityB, 'team_create', { name: '待定切换', members: '成员=fake', policy: 'read-only' });
  await until(() => bus.running.size === 0, 'profile turns did not settle');
  await call(identityB, 'control_accept_pull_only');

  await call(identityB, 'team_send', { teamId: created.team.id, to: '成员', text: '开始工作' });
  await until(() => bus.running.size === 1, 'member turn did not start');

  // 运行中改目录:记 pending,生效目录不动;群派发被守卫拦下。
  await call(identityB, 'control_status', {}, w2);
  const pendingSnapshot = await call(identityB, 'team_snapshot', { teamId: created.team.id });
  assert.equal(pendingSnapshot.team.workspace, w1);
  assert.equal(pendingSnapshot.team.workspace_pending, w2);
  assert.equal(bus.canRun(created.team.id), false);

  // 新派工排队等结算:不进入投递,也不开新回合。
  await call(identityB, 'team_send', { teamId: created.team.id, to: '成员', text: '排队中' });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(bus.running.size, 1);

  // 旧回合结算后 pump 生效待定切换:workspace 更新,排队消息按新目录投递并产出新回复。
  release();
  await until(() => bus.running.size === 0, 'old-directory turn did not settle');
  const settledSnapshot = await call(identityB, 'team_snapshot', { teamId: created.team.id });
  assert.equal(settledSnapshot.team.workspace, w2);
  assert.equal(settledSnapshot.team.workspace_pending, null);
  assert.equal(bus.canRun(created.team.id), true);
  await untilAsync(async () => {
    const inbox = await call(identityB, 'control_inbox', { limit: 50 });
    return inbox.deliveries.some(d => d.payload.message?.text === '新目录工作完成');
  }, 'queued message was not delivered after settle');
});

test('changing the directory back to the effective workspace cancels a pending switch', async t => {
  let release = null;
  const { bus, identityB, call, w1, w2 } = setup(t, {
    run: async context => {
      context.onAccepted();
      if (release) return 'done in w1';
      await new Promise(resolve => { release = resolve; });
      return 'done in w1 first turn';
    },
  });
  await call(identityB, 'control_status', {}, w1);
  const created = await call(identityB, 'team_create', { name: '取消切换', members: '成员=fake', policy: 'read-only' });
  await until(() => bus.running.size === 0, 'profile turns did not settle');
  await call(identityB, 'control_accept_pull_only');
  await call(identityB, 'team_send', { teamId: created.team.id, to: '成员', text: '开始工作' });
  await until(() => bus.running.size === 1, 'member turn did not start');

  await call(identityB, 'control_status', {}, w2);
  assert.equal(
    (await call(identityB, 'team_snapshot', { teamId: created.team.id })).team.workspace_pending,
    w2,
  );
  // 用户把目录改回生效目录:待定切换取消。
  await call(identityB, 'control_status', {}, w1);
  const cancelled = await call(identityB, 'team_snapshot', { teamId: created.team.id });
  assert.equal(cancelled.team.workspace_pending, null);
  assert.equal(cancelled.team.workspace, w1);

  release();
  await until(() => bus.running.size === 0, 'turn did not settle');
  assert.equal((await call(identityB, 'team_snapshot', { teamId: created.team.id })).team.workspace, w1);
});

async function untilAsync(fn, message = 'condition timed out', budgetMs = 5000) {
  const end = Date.now() + budgetMs;
  while (!await fn()) {
    if (Date.now() > end) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
});

describe('desktop-activation', () => {
function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-activation-'));
  const wakeCalls = [];
  const host = fakeHost({
    run: async context => {
      context.onAccepted();
      await context.onTool('send', { to: '主 Agent', text: '成员已经收到。' });
      return 'host final';
    },
  });
  const bus = new Bus({
    directory,
    hosts: new Map([['fake', host]]),
    controlSocketPath: join(directory, 'bus.sock'),
    externalWake: async (binding, options) => {
      wakeCalls.push({ binding, options });
      return { supported: true, state: 'started', mode: 'test' };
    },
  });
  t.after(async () => {
    if (!bus.closing) await bus.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* Windows 上文件可能仍被占用 */ }
  });
  const activation = createExternalIdentity(bus.store, {
    principalName: '本机用户',
    bindingName: 'Codex Desktop 接入',
    host: 'codex',
    declared: {
      capabilities: Object.values(CONTROL_CAPABILITIES),
      workspaceRoots: [directory],
      policies: ['communication', 'read-only', 'workspace-write'],
    },
    surface: 'desktop',
    bindingKind: 'activation',
  });
  // 桌面会话的调用:一条全局凭据 + 该会话的宿主线程身份 + 会话工作目录。
  const call = (threadId, name, args = {}) =>
    bus.controlTool(activation.binding.id, activation.key, name, args, undefined, threadId, false, directory);
  return { bus, directory, activation, call, wakeCalls };
}

test('one global desktop credential resolves a separate conversation binding per host thread', async t => {
  const { bus, call } = setup(t);
  const statusA = await call('thread-A', 'control_status');
  assert.match(statusA.binding.name, /thread-A/);
  const again = await call('thread-A', 'control_status');
  assert.equal(again.binding.id, statusA.binding.id, '同一会话稳定映射到同一连接');
  const statusB = await call('thread-B', 'control_status');
  assert.notEqual(statusB.binding.id, statusA.binding.id);

  // 会话 A 创建团队;会话 B 默认不可见,凭 ID 可检视不可写。
  const created = await call('thread-A', 'team_create', {
    name: '桌面会话 A 的团队',
    members: '成员=fake',
    policy: 'read-only',
  });
  await until(() => bus.running.size === 0, 'profile turns did not settle');
  assert.deepEqual((await call('thread-B', 'control_teams')).teams, []);
  const snapshotB = await call('thread-B', 'team_snapshot', { teamId: created.team.id });
  assert.equal(snapshotB.team.id, created.team.id);
  await assert.rejects(
    () => call('thread-B', 'team_send', { teamId: created.team.id, to: '成员', text: '越权' }),
    /不是团队当前 active controller session/,
  );

  // 同用户接管:会话 B 凭精确团队 ID 接管;A 只读保留。
  await call('thread-B', 'control_accept_pull_only');
  const activated = await call('thread-B', 'team_activate', { teamId: created.team.id });
  assert.equal(activated.activeBindingId, statusB.binding.id);
  const teamsA = await call('thread-A', 'control_teams');
  assert.equal(teamsA.teams.length, 1);
  assert.equal(teamsA.teams[0].active, false);

  // 主控关系:A 建团、B 接管后各留一条;只有 B 仍持有写入席位。
  const relations = bus.store.controllerRelations(created.team.id);
  assert.equal(relations.length, 2);
  assert.deepEqual(relations.map(row => row.active).sort(), [0, 1]);
  assert.ok(relations.every(row => row.binding_name), '关系应带出连接名供界面展示');
});

test('activation credentials without a host thread identity fall back to the latest bound conversation', async t => {
  const { bus, call } = setup(t);
  // 未绑定过任何会话:明确报错并给出 bind-session 指引。
  await assert.rejects(() => call(null, 'control_status'), /bind-session/);
  // 用带线程身份的调用建立会话连接后,无线程身份的调用回落到它(桌面聊天
  // 的 MCP 子进程不注入线程身份,靠 bind-session 先行)。
  await call('thread-fallback', 'team_create', {
    name: '回落团队',
    members: '成员=fake',
    policy: 'read-only',
  });
  await until(() => bus.running.size === 0, 'profile turns did not settle');
  const status = await call(null, 'control_status');
  assert.match(status.binding.name, /thread-fallback/);
  assert.equal(status.binding.id, (await call('thread-fallback', 'control_status')).binding.id);
  assert.equal(status.controlledTeams, 1);
});

test('desktop sessions may root teams at their own working directory even outside declared roots', async t => {
  // 2026-11-21 验收发现:桌面会话开在注册 roots 之外(如仓库)时建团被拒——
  // 安装时无从知晓会话会开在哪个目录,声明的 roots 只是上界猜测。跟随语义下,
  // 会话自己的 controller_cwd 与会话同一信任层级,应并入有效 roots。
  const { bus, directory } = setup(t);
  const outside = mkdtempSync(join(tmpdir(), 'agent-team-cwd-outside-'));
  t.after(() => { try { rmSync(outside, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* Windows 上文件可能仍被占用 */ } });
  const zcode = createExternalIdentity(bus.store, {
    principalName: '本机用户',
    bindingName: 'ZCode Desktop 接入',
    host: 'zcode',
    declared: {
      capabilities: ['session.deliver', 'turn.observe'],
      workspaceRoots: [directory],
      policies: ['communication', 'read-only', 'workspace-write'],
    },
    surface: 'desktop',
    bindingKind: 'activation',
  });
  // hostCwd 在 roots 之外:桌面跟随语义下建团成功,workspace 落在会话目录。
  const created = await bus.controlTool(zcode.binding.id, zcode.key, 'team_create', {
    name: '会话目录团队',
    members: '成员=fake',
    policy: 'read-only',
  }, undefined, 'sess-outside', false, outside);
  assert.equal(created.team.workspace, realpathSync(outside));
  // CLI surface 语义不变:显式传入 roots 之外的 workspace 仍被拒。
  const cli = createExternalIdentity(bus.store, {
    principalName: '本机用户',
    bindingName: 'CLI 会话',
    host: 'zcode',
    declared: {
      capabilities: ['session.deliver', 'turn.observe'],
      workspaceRoots: [directory],
      policies: ['communication', 'read-only', 'workspace-write'],
    },
    surface: 'cli',
  });
  await assert.rejects(
    () => bus.controlTool(cli.binding.id, cli.key, 'team_create', {
      name: '越界团队',
      workspace: outside,
      members: '',
      policy: 'read-only',
    }),
    /workspace roots/,
  );
});

test('hosts without a session identity channel resolve per their declared channel', async t => {
  const { bus, directory } = setup(t);
  const declared = {
    capabilities: ['session.deliver', 'turn.observe'],
    workspaceRoots: [directory],
    policies: ['read-only'],
  };
  const claude = createExternalIdentity(bus.store, {
    principalName: '本机用户',
    bindingName: 'Claude Desktop 接入',
    host: 'claude',
    declared,
    surface: 'desktop',
    bindingKind: 'activation',
  });
  const dsh = createExternalIdentity(bus.store, {
    principalName: '本机用户',
    bindingName: 'DSH Desktop 接入',
    host: 'dsh',
    declared,
    surface: 'desktop',
    bindingKind: 'activation',
  });
  const zcode = createExternalIdentity(bus.store, {
    principalName: '本机用户',
    bindingName: 'ZCode Desktop 接入',
    host: 'zcode',
    declared,
    surface: 'desktop',
    bindingKind: 'activation',
  });
  // Claude:无会话身份通道 → 应用级单连接,两次调用落在同一连接。
  const app1 = await bus.controlTool(claude.binding.id, claude.key, 'control_status', {});
  const app2 = await bus.controlTool(claude.binding.id, claude.key, 'control_status', {});
  assert.match(app1.binding.name, /应用级/);
  assert.equal(app2.binding.id, app1.binding.id);
  // DSH 与 ZCode 同为 manual 通道:须显式绑定会话,裸调用被拒绝并给出
  // bind-session 指引。
  await assert.rejects(
    () => bus.controlTool(dsh.binding.id, dsh.key, 'control_status', {}),
    /bind-session/,
  );
  await assert.rejects(
    () => bus.controlTool(zcode.binding.id, zcode.key, 'control_status', {}),
    /bind-session/,
  );
});
});

describe('controller-workspace-flow', () => {
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

test('桌面连接跟随会话当前目录', () => {
  assert.equal(surfaceFollowsConversation(SURFACES.desktop), true);
});

test('CLI 与未知连接不跟随会话目录', () => {
  assert.equal(surfaceFollowsConversation(SURFACES.cli), false);
  assert.equal(surfaceFollowsConversation(undefined), false);
  assert.equal(surfaceFollowsConversation('desktopish'), false);
});
});

describe('desktop-member-hosts', () => {
function tempDir(t, prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => { try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ } });
  return directory;
}

test('安装 Codex 后注册桌面成员宿主,引擎走隔离 CODEX_HOME', async t => {
  const root = tempDir(t, 'desktop-member-');
  const store = new Store(join(root, 'store'));
  t.after(() => store.close());

  const result = await installCodexDesktopIntegration(store, {
    detections: [{ kind: 'codex', found: true, applicationId: 'app-1', enginePath: '/fake/codex', engineVersion: '1.0.0' }],
    codexHome: join(root, 'codex-home'),
    socketPath: join(root, 'bus.sock'),
  });

  assert.equal(result.memberHost, 'codex-desktop');
  const spec = readDesktopHostSpecs(store.directory)['codex-desktop'];
  assert.ok(spec, '成员宿主 spec 应已持久化');
  assert.equal(spec.adapter, 'codex');
  assert.equal(spec.command, '/fake/codex', '成员执行必须用桌面内嵌引擎');
  assert.equal(spec.env.CODEX_HOME, join(store.directory, 'desktop-engines', 'codex'), '必须指向框架私有目录');
  assert.equal(existsSync(spec.env.CODEX_HOME), true, '隔离 CODEX_HOME 必须真实存在,否则引擎直接退出');
});

test('服务启动时合并动态桌面宿主,且不影响内置宿主', async t => {
  const root = tempDir(t, 'desktop-member-');
  writeDesktopHostSpec(root, 'codex-desktop', { adapter: 'codex', command: '/fake/codex', env: { CODEX_HOME: join(root, 'engines') } });

  const hosts = await loadHosts({ directory: root, socketPath: join(root, 'bus.sock') });
  assert.equal(hosts.has('codex-desktop'), true);
  assert.equal(hosts.has('codex'), true, '内置 codex 宿主仍在');
  assert.equal(hosts.has('claude'), true);

  const empty = tempDir(t, 'desktop-member-');
  const base = await loadHosts({ directory: empty, socketPath: join(empty, 'bus.sock') });
  assert.equal(base.has('codex-desktop'), false, '未接入时不应出现动态宿主');
});

test('动态宿主文件损坏时按空表处理,不阻塞启动', async t => {
  const root = tempDir(t, 'desktop-member-');
  writeFileSync(join(root, DESKTOP_HOSTS_FILE), '{ not json');

  assert.deepEqual(readDesktopHostSpecs(root), {});
  const hosts = await loadHosts({ directory: root, socketPath: join(root, 'bus.sock') });
  assert.equal(hosts.has('codex-desktop'), false);
  assert.equal(hosts.has('codex'), true);
});

test('移除动态宿主是幂等空操作', async t => {
  const root = tempDir(t, 'desktop-member-');
  writeDesktopHostSpec(root, 'codex-desktop', { adapter: 'codex' });
  removeDesktopHostSpec(root, 'codex-desktop');
  assert.deepEqual(readDesktopHostSpecs(root), {});
  assert.deepEqual(removeDesktopHostSpec(root, 'missing'), {}, '不存在的宿主不应报错');
});

// --- 运行期热同步:安装/移除后 bus.hosts 立即可派单,无需重启服务 ----------------

// 用临时假 bundle 走真实检测入口:既注册桌面应用行(移除的前置事实),
// 又产出安装所需的 detections,三平台结果一致。
async function detectFakeZcode(store, root) {
  const bundlePath = join(root, 'ZCode.app');
  const enginePath = join(bundlePath, 'Contents', 'Resources', 'glm', 'zcode.cjs');
  mkdirSync(join(bundlePath, 'Contents', 'Resources', 'glm'), { recursive: true });
  writeFileSync(enginePath, '');
  const definitions = new Map([['zcode', {
    label: 'ZCode',
    bundleCandidates: ({ applicationsRoot }) => [join(applicationsRoot, 'ZCode.app')],
    engineCandidates: () => [{ path: enginePath, version: '1.0.0' }],
  }]]);
  return detectDesktopApplications(store, {
    definitions,
    context: { platform: 'darwin', applicationsRoot: root, supportRoot: root },
    readBundleVersion: async () => '1.0.0',
  });
}

async function installRuntimeZcode(server, root) {
  const detections = await detectFakeZcode(server.bus.store, root);
  return installDesktopIntegration(server.bus.store, 'zcode', {
    detections,
    socketPath: server.socketPath,
    zcodeHome: join(root, 'zcode-home'),
  });
}

test('统一安装入口按 kind 分发四家桌面集成,未知类型标记 400', async t => {
  const { bus, directory } = await serverScenario(t, {});
  await assert.rejects(installDesktopIntegration(bus.store, 'wechat', { detections: [] }), error => {
    assert.equal(error.message, '暂不支持安装桌面集成: wechat');
    assert.equal(error.status, 400);
    return true;
  });
  for (const kind of ['codex', 'dsh', 'claude', 'zcode']) {
    await assert.rejects(
      installDesktopIntegration(bus.store, kind, { detections: [], socketPath: join(directory, 'bus.sock') }),
      /未检测到/,
      `${kind} 必须已接入真实安装函数`,
    );
  }
});

test('运行期安装桌面集成后热同步成员宿主,注入宿主不被接管', async t => {
  const injected = fakeHost();
  const { server, bus, directory } = await serverScenario(t, { hosts: new Map([['injected', injected]]) });
  assert.equal(bus.hosts.has('zcode-desktop'), false, '未安装时不应出现动态宿主');

  const result = await installRuntimeZcode(server, directory);
  assert.equal(result.memberHost, 'zcode-desktop');
  assert.equal(bus.hosts.has('zcode-desktop'), false, '安装只落盘 spec,宿主由热同步注册');

  await bus.syncDesktopHosts();
  assert.equal(bus.hosts.has('zcode-desktop'), true, '运行期同步后成员宿主应可派单,无需重启');
  assert.equal(bus.hosts.get('injected'), injected, '调用方注入的宿主不得被替换');
});

test('动态宿主 spec 更新或 RPC 移除经热同步替换并关闭旧实例', async t => {
  const injected = fakeHost();
  const { server, bus, directory } = await serverScenario(t, { hosts: new Map([['injected', injected]]) });
  await installRuntimeZcode(server, directory);
  await bus.syncDesktopHosts();
  const first = bus.hosts.get('zcode-desktop');
  let firstClosed = false;
  const firstClose = first.close;
  first.close = async () => { firstClosed = true; await firstClose?.call(first); };

  writeDesktopHostSpec(directory, 'zcode-desktop', { adapter: 'zcode', command: join('/fake/ZCode2.app', 'Contents', 'MacOS', 'ZCode') });
  await bus.syncDesktopHosts();
  const second = bus.hosts.get('zcode-desktop');
  assert.notEqual(second, first, 'spec 更新应实例化新宿主');
  assert.equal(firstClosed, true, '旧宿主必须关闭');
  assert.equal(bus.hosts.get('injected'), injected, '注入宿主在更新时保留');

  let secondClosed = false;
  const secondClose = second.close;
  second.close = async () => { secondClosed = true; await secondClose?.call(second); };
  await handleRpc(bus, { op: 'desktop_remove', kind: 'zcode' });
  assert.equal(bus.hosts.has('zcode-desktop'), false, 'RPC 移除后动态宿主立即摘除');
  assert.equal(secondClosed, true, 'RPC 移除必须关闭宿主');
  assert.equal(bus.hosts.get('injected'), injected, '注入宿主在移除时保留');
});

test('HTTP 移除桌面应用后热同步关闭并摘除动态宿主', async t => {
  const injected = fakeHost();
  const { server, bus, directory, url } = await serverScenario(t, { hosts: new Map([['injected', injected]]) });
  await installRuntimeZcode(server, directory);
  await bus.syncDesktopHosts();
  const host = bus.hosts.get('zcode-desktop');
  let closed = false;
  const originalClose = host.close;
  host.close = async () => { closed = true; await originalClose?.call(host); };

  const response = await fetch(new URL('/api/desktop/remove', url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: url.slice(0, -1) },
    body: JSON.stringify({ kind: 'zcode' }),
  });
  assert.equal(response.status, 200);
  assert.equal(bus.hosts.has('zcode-desktop'), false, 'HTTP 移除后动态宿主立即摘除');
  assert.equal(closed, true, 'HTTP 移除必须关闭宿主');
  assert.equal(bus.hosts.get('injected'), injected, '注入宿主在 HTTP 移除时保留');
});
});

describe('cross-platform-desktop', () => {
function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* ignore */ } });
  return dir;
}

/** 按 Electron ASAR (Chromium Pickle) 格式构造最小合成归档,用于跨平台单测。 */
function buildSyntheticAsar(packageJsonText) {
  const payload = Buffer.from(packageJsonText, 'utf8');
  const headerJson = Buffer.from(JSON.stringify({
    files: { 'package.json': { size: payload.length, offset: '0' } },
  }), 'utf8');
  const paddedJsonLen = Math.ceil(headerJson.length / 4) * 4;
  const headerPicklePayloadSize = 4 + paddedJsonLen;
  const headerPickleTotalSize = 4 + headerPicklePayloadSize;
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(headerPickleTotalSize, 4);
  prefix.writeUInt32LE(headerPicklePayloadSize, 8);
  prefix.writeUInt32LE(headerJson.length, 12);
  const pad = Buffer.alloc(paddedJsonLen - headerJson.length);
  return Buffer.concat([prefix, headerJson, pad, payload]);
}

test('readBundleVersion extracts versions across JSON, ASAR, Info.plist, AppxManifest, plain text, and dir name', async t => {
  const root = tempDir(t, 'bundle-ver-');

  const jsonDir = join(root, 'json-app');
  mkdirSync(join(jsonDir, 'resources', 'app'), { recursive: true });
  writeFileSync(join(jsonDir, 'resources', 'app', 'package.json'), JSON.stringify({ version: '1.2.3' }));
  assert.equal(await readBundleVersion(jsonDir), '1.2.3');

  const asarDir = join(root, 'asar-app');
  mkdirSync(join(asarDir, 'resources'), { recursive: true });
  writeFileSync(join(asarDir, 'resources', 'app.asar'), buildSyntheticAsar(JSON.stringify({ version: '3.18.2' })));
  assert.equal(readAsarPackageVersion(join(asarDir, 'resources', 'app.asar')), '3.18.2');
  assert.equal(await readBundleVersion(asarDir), '3.18.2');

  const plistDir = join(root, 'mac.app');
  mkdirSync(join(plistDir, 'Contents'), { recursive: true });
  writeFileSync(
    join(plistDir, 'Contents', 'Info.plist'),
    '<?xml version="1.0"?><plist><dict><key>CFBundleShortVersionString</key><string>26.1111</string></dict></plist>',
  );
  assert.equal(await readBundleVersion(plistDir), '26.1111');

  const bplistDir = join(root, 'bplist.app');
  mkdirSync(join(bplistDir, 'Contents'), { recursive: true });
  writeFileSync(join(bplistDir, 'Contents', 'Info.plist'), 'bplist00binarydata');
  assert.equal(await readBundleVersion(bplistDir), null);

  const msixDir = join(root, 'msix-app');
  mkdirSync(msixDir, { recursive: true });
  writeFileSync(
    join(msixDir, 'AppxManifest.xml'),
    '<?xml version="1.0"?><Package><Identity Name="OpenAI.Codex" Version="26.1117.4957.0" /></Package>',
  );
  assert.equal(await readBundleVersion(msixDir), '26.1117.4957.0');

  const plainDir = join(root, 'plain-app');
  mkdirSync(plainDir, { recursive: true });
  writeFileSync(join(plainDir, 'version'), '44.7.0\n');
  assert.equal(await readBundleVersion(plainDir), '44.7.0');

  const squirrelDir = join(root, 'app-2.5.1');
  mkdirSync(squirrelDir, { recursive: true });
  assert.equal(await readBundleVersion(squirrelDir), '2.5.1');

  const emptyDir = join(root, 'unknown-app');
  mkdirSync(emptyDir, { recursive: true });
  assert.equal(await readBundleVersion(emptyDir), null);
});

test('parseWindowsMsixRegistryOutput parses packages and sorts newest version first', () => {
  const sample = [
    '',
    'HKEY_CURRENT_USER\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages\\OpenAI.Codex_26.1000.1.0_x64__abc',
    '    PackageRootFolder    REG_SZ    C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1000.1.0_x64__abc',
    '',
    'HKEY_CURRENT_USER\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages\\OpenAI.Codex_26.1117.4957.0_x64__abc',
    '    PackageRootFolder    REG_SZ    C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1117.4957.0_x64__abc',
    '',
    'HKEY_CURRENT_USER\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages\\Claude_4.29.0.0_x64__xyz',
    '    PackageRootFolder    REG_SZ    C:\\Program Files\\WindowsApps\\Claude_4.29.0.0_x64__xyz',
  ].join('\r\n');
  const parsed = parseWindowsMsixRegistryOutput(sample);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].name, 'OpenAI.Codex_26.1117.4957.0_x64__abc');
  assert.equal(parsed[0].root, 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1117.4957.0_x64__abc');
});

test('detectDesktopApplications registers all four Windows desktop installations and skips stale leftovers', async t => {
  const root = tempDir(t, 'win-desktop-');
  const localPrograms = join(root, 'LocalPrograms');
  const programFiles = join(root, 'ProgramFiles');
  const localAppData = join(root, 'LocalAppData');
  const store = new Store(tempDir(t, 'win-store-'));

  // Codex MSIX
  const codexRoot = join(root, 'WindowsApps', 'OpenAI.Codex_26.1117.4957.0_x64__abc');
  mkdirSync(join(codexRoot, 'app', 'resources'), { recursive: true });
  writeFileSync(join(codexRoot, 'AppxManifest.xml'), '<Package><Identity Name="OpenAI.Codex" Version="26.1117.4957.0" /></Package>');
  writeFileSync(join(codexRoot, 'app', 'resources', 'codex.exe'), '');

  // Claude MSIX + downloaded claude.exe
  const claudeRoot = join(root, 'WindowsApps', 'Claude_4.29.0.0_x64__xyz');
  mkdirSync(join(claudeRoot, 'app'), { recursive: true });
  writeFileSync(join(claudeRoot, 'AppxManifest.xml'), '<Package><Identity Name="Claude" Version="4.29.0.0" /></Package>');
  const claudeEngineDir = join(localAppData, 'Claude-3p', 'claude-code', '2.1.309', 'abc123');
  mkdirSync(claudeEngineDir, { recursive: true });
  writeFileSync(join(claudeEngineDir, 'claude.exe'), '');

  // DSH in LocalPrograms
  const dshRoot = join(localPrograms, 'DeepSeek Harness');
  mkdirSync(join(dshRoot, 'resources', 'runtime', 'cli', 'bin'), { recursive: true });
  writeFileSync(join(dshRoot, 'DeepSeek Harness.exe'), '');
  writeFileSync(join(dshRoot, 'version'), '44.7.0\n');
  writeFileSync(join(dshRoot, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'), '@echo off\r\n');

  // ZCode: stale empty leftover in LocalPrograms + real install in ProgramFiles
  mkdirSync(join(localPrograms, 'ZCode', 'resources', 'glm'), { recursive: true });
  const zcodeReal = join(programFiles, 'ZCode');
  mkdirSync(join(zcodeReal, 'resources', 'glm'), { recursive: true });
  writeFileSync(join(zcodeReal, 'ZCode.exe'), '');
  writeFileSync(join(zcodeReal, 'resources', 'app.asar'), buildSyntheticAsar(JSON.stringify({ version: '3.20.0' })));
  writeFileSync(join(zcodeReal, 'resources', 'glm', 'zcode.cjs'), 'module.exports = {};');

  const context = desktopDetectionContext({
    platform: 'win32',
    applicationsRoots: [localPrograms, programFiles],
    supportRoots: [localAppData],
    msixPackages: [
      { name: 'OpenAI.Codex_26.1117.4957.0_x64__abc', version: '26.1117.4957.0', root: codexRoot },
      { name: 'Claude_4.29.0.0_x64__xyz', version: '4.29.0.0', root: claudeRoot },
    ],
  });
  const results = await detectDesktopApplications(store, { definitions: DESKTOP_DEFINITIONS, context });
  const byKind = new Map(results.map(item => [item.kind, item]));

  assert.equal(byKind.get('codex').registered, true);
  assert.equal(byKind.get('codex').bundleVersion, '26.1117.4957.0');
  assert.equal(byKind.get('codex').enginePath, join(codexRoot, 'app', 'resources', 'codex.exe'));

  assert.equal(byKind.get('claude').registered, true);
  assert.equal(byKind.get('claude').bundleVersion, '4.29.0.0');
  assert.equal(byKind.get('claude').enginePath, join(claudeEngineDir, 'claude.exe'));
  assert.equal(byKind.get('claude').engineVersion, '2.1.309');

  assert.equal(byKind.get('dsh').registered, true);
  assert.equal(byKind.get('dsh').bundleVersion, '44.7.0');
  assert.equal(byKind.get('dsh').enginePath, join(dshRoot, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'));

  assert.equal(byKind.get('zcode').registered, true);
  assert.equal(byKind.get('zcode').bundlePath, zcodeReal, '必须跳过残留空目录,命中真实安装目录');
  assert.equal(byKind.get('zcode').bundleVersion, '3.20.0');
  assert.equal(byKind.get('zcode').enginePath, join(zcodeReal, 'resources', 'glm', 'zcode.cjs'));
  store.close();
});

test('claudeEngineCandidates handles macOS, Windows, and Linux engine layouts sorted numerically', t => {
  const root = tempDir(t, 'claude-engines-');
  mkdirSync(join(root, '2.1.99', 'h1'), { recursive: true });
  writeFileSync(join(root, '2.1.99', 'h1', 'claude.exe'), '');
  mkdirSync(join(root, '2.1.309', 'h2'), { recursive: true });
  writeFileSync(join(root, '2.1.309', 'h2', 'claude.exe'), '');
  const found = claudeEngineCandidates(root);
  assert.equal(found.length, 2);
  assert.equal(found[0].version, '2.1.309');
  assert.equal(found[1].version, '2.1.99');
});

test('defaultClaudeConfigDir resolves platform-appropriate Claude Desktop config directories', t => {
  const root = tempDir(t, 'claude-cfg-');
  const local = join(root, 'Local');
  const roaming = join(root, 'Roaming');
  assert.equal(defaultClaudeConfigDir({ platform: 'darwin', home: root, env: {} }), join(root, 'Library', 'Application Support', 'Claude'));
  assert.equal(defaultClaudeConfigDir({ platform: 'linux', home: root, env: { XDG_CONFIG_HOME: join(root, 'xdg') } }), join(root, 'xdg', 'Claude'));
  // Windows 无现存配置时默认 Roaming\Claude
  assert.equal(
    defaultClaudeConfigDir({ platform: 'win32', home: root, env: { LOCALAPPDATA: local, APPDATA: roaming } }),
    join(roaming, 'Claude'),
  );
  // Windows 存在 Claude-3p 配置时优先命中它
  mkdirSync(join(local, 'Claude-3p'), { recursive: true });
  writeFileSync(join(local, 'Claude-3p', 'claude_desktop_config.json'), '{}');
  assert.equal(
    defaultClaudeConfigDir({ platform: 'win32', home: root, env: { LOCALAPPDATA: local, APPDATA: roaming } }),
    join(local, 'Claude-3p'),
  );
});

test('zcode cross-platform helpers cover isolatedHomeEnv, Windows desktop paths, and PATH lookup', t => {
  assert.deepEqual(isolatedHomeEnv({ A: '1' }, '/iso', 'darwin'), { A: '1', HOME: '/iso' });
  assert.deepEqual(isolatedHomeEnv({ A: '1' }, 'C:\\iso', 'win32'), { A: '1', HOME: 'C:\\iso', USERPROFILE: 'C:\\iso' });
  assert.equal(zcodeDesktopLaunchCommand('/Applications/ZCode.app', 'darwin'), join('/Applications/ZCode.app', 'Contents', 'MacOS', 'ZCode'));
  assert.equal(zcodeDesktopLaunchCommand('C:\\Program Files\\ZCode', 'win32'), join('C:\\Program Files\\ZCode', 'ZCode.exe'));

  const root = tempDir(t, 'zcode-win-');
  const app = join(root, 'ZCode');
  const paths = zcodeAppPaths(app, 'win32');
  mkdirSync(join(paths.entry, '..'), { recursive: true });
  mkdirSync(join(paths.modernProvider, '..'), { recursive: true });
  writeFileSync(paths.electron, '');
  writeFileSync(paths.entry, 'module.exports = {};');
  writeFileSync(paths.modernProvider, '{}');

  const compat = tempDir(t, 'zcode-win-compat-');
  process.env.AGENT_TEAM_ZCODE_COMPAT_DIR = compat;
  t.after(() => { delete process.env.AGENT_TEAM_ZCODE_COMPAT_DIR; });

  const winLaunch = resolveZcodeLaunch({
    command: 'zcode',
    platform: 'win32',
    home: root,
    env: { ProgramFiles: root, LOCALAPPDATA: join(root, 'none') },
    locate: () => null,
  });
  assert.equal(winLaunch.command, process.execPath);
  assert.ok(winLaunch.args[0].startsWith(compat));

  const pathFallback = resolveZcodeLaunch({
    command: 'zcode',
    platform: 'linux',
    home: root,
    env: {},
    locate: name => (name === 'zcode' ? '/usr/local/bin/zcode' : null),
  });
  assert.equal(pathFallback.command, '/usr/local/bin/zcode');
});

test('launchEnvironment adds platform-appropriate PATH directories and windowsPrivateAclArgs builds icacls args', () => {
  const winEnv = launchEnvironment({
    platform: 'win32',
    home: 'C:\\Users\\demo',
    env: { Path: 'C:\\Windows\\System32', APPDATA: 'C:\\Users\\demo\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\demo\\AppData\\Local' },
  });
  assert.ok(winEnv.Path.includes(join('C:\\Users\\demo\\AppData\\Roaming', 'npm')));
  assert.equal(winEnv.Path.includes('/opt/homebrew/bin'), false);

  const macEnv = launchEnvironment({ platform: 'darwin', home: '/Users/demo', env: { PATH: '/usr/bin' } });
  assert.ok(macEnv.PATH.includes('/opt/homebrew/bin'));

  const aclArgs = windowsPrivateAclArgs('C:\\data', { USERNAME: 'alice', USERDOMAIN: 'WORK' });
  assert.deepEqual(aclArgs, [
    'C:\\data',
    '/inheritance:r',
    '/grant:r', 'WORK\\alice:(OI)(CI)F',
    '/grant:r', '*S-1-5-18:(OI)(CI)F',
  ]);
  assert.equal(windowsPrivateAclArgs('C:\\data', {}), null);
});

test('spawnHost refuses shebang-less .cjs files on Windows instead of triggering Open With dialog', { skip: process.platform !== 'win32' }, t => {
  const dir = tempDir(t, 'no-openwith-');
  const script = join(dir, 'zcode.cjs');
  writeFileSync(script, '// plain module without shebang\nmodule.exports = {};\n');
  assert.throws(() => spawnHost(script, ['--version']), /不能直接执行无 shebang 的脚本文件/);
});
});

describe('desktop-helpers', () => {
function menuItem(template, label) {
  for (const menu of template) {
    const found = menu.submenu?.find(item => item.label === label);
    if (found) return found;
  }
  return undefined;
}

test('徽标 = 待办卡片 + 未读条数，等回复的消息不计入，字段缺失按 0', () => {
  assert.equal(badgeCount({ pending: [{}, {}], unreadTotal: 3, waiting: [{}] }), 5);
  assert.equal(badgeCount({ pending: [], unreadTotal: 0, waiting: [{}, {}, {}] }), 0);
  assert.equal(badgeCount({ pending: [{}, {}] }), 2);
  assert.equal(badgeCount({ unreadTotal: 4 }), 4);
  assert.equal(badgeCount({}), 0);
  assert.equal(badgeCount(null), 0);
});

test('目录对话框的选中、取消、空列表与异常', async () => {
  assert.deepEqual(await pickDirectory(async () => ({ canceled: false, filePaths: ['/tmp/picked'] }), {}), { path: '/tmp/picked' });
  assert.deepEqual(await pickDirectory(async () => ({ canceled: true, filePaths: [] }), {}), { path: null });
  assert.deepEqual(await pickDirectory(async () => ({ canceled: false, filePaths: [] }), {}), { path: null });
  await assert.rejects(pickDirectory(async () => { throw new Error('dialog failed'); }, {}), /dialog failed/);
});

test('应用菜单启用状态随服务地址与运行模式变化', () => {
  const offline = applicationMenuTemplate({ platform: 'darwin', panelUrl: null, dev: false });
  assert.equal(menuItem(offline, '在浏览器中打开').enabled, false);
  assert.equal(menuItem(offline, '停止本地服务').enabled, false);

  const online = applicationMenuTemplate({ platform: 'darwin', panelUrl: 'http://127.0.0.1:1234/', dev: false });
  assert.equal(menuItem(online, '在浏览器中打开').enabled, true);
  assert.equal(menuItem(online, '停止本地服务').enabled, true);

  const dev = applicationMenuTemplate({ platform: 'darwin', panelUrl: 'http://127.0.0.1:5173/', dev: true });
  assert.equal(menuItem(dev, '在浏览器中打开').enabled, true);
  assert.equal(menuItem(dev, '停止本地服务').enabled, false);

  assert.equal(applicationMenuTemplate({ platform: 'win32' })[0].label, '文件');

  const darwinLabels = applicationMenuTemplate({ platform: 'darwin' }).map(item => item.label).filter(Boolean);
  assert.deepEqual(darwinLabels, ['文件', '编辑', '窗口', '服务', '帮助']);
  assert.deepEqual(windowChromeOptions('darwin'), {
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 12 },
  });
  assert.deepEqual(windowChromeOptions('win32'), { frame: false });
  assert.deepEqual(windowChromeOptions('linux'), { frame: false });
  assert.deepEqual(
    desktopMenuState({ panelUrl: 'http://127.0.0.1:62048/', dev: false, showingError: false, version: '0.5.3' }),
    { hasService: true, dev: false, showingError: false, version: '0.5.3' },
  );
  assert.equal(desktopMenuState({ panelUrl: 'http://127.0.0.1:62048/', showingError: true }).hasService, false);
});

test('Windows 任务栏角标文字与 PNG 覆盖图标生成', () => {
  assert.equal(badgeLabel(0), '');
  assert.equal(badgeLabel(7), '7');
  assert.equal(badgeLabel(120), '99+');
  assert.equal(badgeOverlayPng(0), null);
  const png = badgeOverlayPng(12);
  assert.ok(Buffer.isBuffer(png));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], '应输出合法 PNG 文件头');
  assert.ok(Buffer.isBuffer(badgeOverlayPng(150)));
});
});
