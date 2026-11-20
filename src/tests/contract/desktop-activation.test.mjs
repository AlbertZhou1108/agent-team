// 桌面激活连接的契约:一条全局凭据 + 宿主会话身份 → 每会话独立的主控连接。
// 这是交接文档列出的头号风险(共享 MCP 条目坍缩多会话)的对外行为验证。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../../bus.mjs';
import { createExternalIdentity } from '../../control-plane.mjs';
import { CONTROL_CAPABILITIES } from '../../control-capabilities.mjs';
import { fakeHost } from '../support/fixture.mjs';
import { until } from '../support/wait.mjs';

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
