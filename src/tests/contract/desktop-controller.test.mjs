// 桌面主控会话的契约:独立可见性、同用户按 ID 接管、Controller workspace 跟随。
// 断言全部经公共入口(control 工具、Bus 方法);内部表示由 internal 用例钉住。
// 宿主一律 fake;唤醒经注入的 externalWake 记录,不消耗真实额度。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../../bus.mjs';
import { createExternalIdentity } from '../../control-plane.mjs';
import { CONTROL_CAPABILITIES } from '../../control-capabilities.mjs';
import { fakeHost } from '../support/fixture.mjs';
import { until } from '../support/wait.mjs';

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
