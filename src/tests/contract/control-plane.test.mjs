import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../../bus.mjs';
import { createExternalIdentity } from '../../control-plane.mjs';
import { CONTROL_CAPABILITIES, CONTROLLER_REQUIRED_CAPABILITIES } from '../../control-capabilities.mjs';
import { fakeHost } from '../support/fixture.mjs';
import { until } from '../support/wait.mjs';

async function untilAsync(fn, message = 'condition timed out', budgetMs = 5000) {
  const end = Date.now() + budgetMs;
  while (!await fn()) {
    if (Date.now() > end) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function setup(t, { externalWake, capabilities = Object.values(CONTROL_CAPABILITIES) } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-control-'));
  const wakeCalls = [];
  const host = fakeHost({
    run: async context => {
      context.onAccepted();
      if (context.endpoint.context !== 'profile') {
        if (context.prompt.includes('请发起决策')) {
          await context.onTool('ask', {
            kind: 'input',
            text: '需要用户补充发布说明。',
          });
          return '等待用户决定';
        }
        await context.onTool('send', {
          to: '主 Agent',
          text: '成员已经收到。',
        });
      }
      return 'host final';
    },
  });
  const bus = new Bus({
    directory,
    hosts: new Map([['fake', host]]),
    controlSocketPath: join(directory, 'bus.sock'),
    externalWake: externalWake ?? (async (binding, options) => {
      wakeCalls.push({ binding, options });
      return { supported: true, command: 'codex', args: [] };
    }),
  });
  t.after(async () => {
    if (!bus.closing) await bus.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const identity = createExternalIdentity(bus.store, {
    principalName: '测试用户',
    bindingName: '主控会话',
    host: 'codex',
    session: 'thread-test',
    declared: {
      capabilities,
      workspaceRoots: [directory],
      policies: ['communication', 'read-only', 'workspace-write'],
    },
    probed: {
      capabilities,
      workspaceRoots: [directory],
      policies: ['communication', 'read-only', 'workspace-write'],
    },
  });
  const call = async (name, args = {}) => bus.controlTool(identity.binding.id, identity.key, name, args);
  return { bus, directory, identity, call, wakeCalls, host };
}

test('external controller creates and reads a cross-host shaped team without a panel session', async t => {
  const { bus, directory, identity, call, wakeCalls } = setup(t);
  const tools = bus.controlTools(identity.binding.id, identity.key);
  assert.ok(tools.some(tool => tool.name === 'team_create'));
  assert.ok(tools.some(tool => tool.name === 'team_send'));

  const created = await call('team_create', {
    name: '无头团队',
    workspace: directory,
    members: '成员=fake',
    charter: '完成一次端到端协作。',
    policy: 'read-only',
    operationId: 'create-1',
  });
  assert.equal(created.controllerId, identity.principal.id);
  assert.equal(created.replayed, false);
  const replay = await call('team_create', {
    name: '无头团队',
    workspace: directory,
    members: '成员=fake',
    charter: '完成一次端到端协作。',
    policy: 'read-only',
    operationId: 'create-1',
  });
  assert.equal(replay.team.id, created.team.id);
  assert.equal(replay.replayed, true);
  await assert.rejects(
    () => call('team_create', {
      name: '无头团队',
      workspace: directory,
      members: '成员=fake',
      charter: '完成一次端到端协作。',
      policy: 'read-only',
      allowShell: true,
      operationId: 'create-1',
    }),
    /不同建群内容/,
  );

  await until(() => bus.running.size === 0, 'member profile turns did not settle');
  const snapshot = await call('team_snapshot', { teamId: created.team.id });
  assert.equal(snapshot.controller.kind, 'external_agent');
  assert.equal(snapshot.controller.id, identity.principal.id);
  assert.equal(snapshot.members.length, 1);
  const projected = bus.overview().panelTeams.find(team => team.id === created.team.id);
  assert.equal(projected.relation, null);
  assert.equal(projected.controller.kind, 'external_agent');
  assert.equal(projected.controller.name, identity.principal.name);

  await call('control_wake_test');
  const sent = await call('team_send', {
    teamId: created.team.id,
    to: '成员',
    text: '请确认收到。',
  });
  assert.ok(sent.messageId);
  await untilAsync(
    async () => (await call('control_status')).delivery.pending === 1,
    'member reply was not queued for the external controller',
  );
  await until(() => wakeCalls.length === 2, 'external wake was not attempted');
  assert.equal((await call('control_status')).delivery.wake.sent, 1);
  assert.equal((await call('control_status')).delivery.wake.started, 1);
  bus.pump();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(wakeCalls.length, 2, 'the same pending delivery must not wake twice');
  const inbox = await call('control_inbox', { limit: 20 });
  assert.equal(inbox.deliveries.length, 1);
  assert.equal(inbox.deliveries[0].payload.teamId, created.team.id);
  assert.equal(inbox.deliveries[0].payload.message.text, '成员已经收到。');
  assert.equal(inbox.deliveries[0].payload.message.awaiting, 0);
  assert.deepEqual(await call('control_inbox', { limit: 20 }).then(value => value.deliveries), []);
  assert.equal((await call('control_status')).delivery.pending, 0);
  assert.equal(wakeCalls.length, 2);
  assert.equal(wakeCalls[1].binding.host, 'codex');
  assert.equal(wakeCalls[1].options.count, 1);
  assert.deepEqual((await call('control_status')).wake, {
    state: 'ready',
    mode: 'codex',
    reason: null,
  });
  assert.equal((await call('team_archive', { teamId: created.team.id })).team.state, 'archived');
});

test('active wake is advertised but remains unverified before a real wake starts', async t => {
  const { identity, call } = setup(t);
  const protocol = await call('control_protocol');
  assert.ok(protocol.capabilities.capabilities.includes(CONTROL_CAPABILITIES.sessionWake));
  const status = await call('control_status');
  assert.deepEqual(status.wake, {
    state: 'unverified',
    mode: 'codex',
    reason: '尚未通过真实主动唤醒验证',
  });
  assert.equal(status.binding.host, 'codex');
  assert.equal(status.binding.id, identity.binding.id);
});

test('headless work is gated until wake verification or binding pull-only acceptance', async t => {
  const { bus, directory, call, identity } = setup(t, {
    externalWake: async () => ({ supported: true, state: 'started', mode: 'codex' }),
  });
  const created = await call('team_create', {
    name: '门禁团队',
    workspace: directory,
    members: '成员=fake',
    policy: 'read-only',
  });
  assert.equal(created.headless.state, 'provisioning');
  assert.equal((await call('team_snapshot', { teamId: created.team.id })).headless.state, 'provisioning');
  let blocked;
  await assert.rejects(
    async () => {
      try {
        await call('team_send', {
          teamId: created.team.id,
          to: '成员',
          text: '现在开始工作。',
        });
      } catch (error) {
        blocked = error;
        throw error;
      }
    },
    /headless_not_ready/,
  );
  assert.equal(blocked.code, 'headless_not_ready');
  assert.equal(blocked.details.wake.state, 'provisioning');
  const verified = await call('control_wake_test');
  assert.deepEqual(verified.wake, { state: 'ready', mode: 'codex', reason: null });
  const sent = await call('team_send', {
    teamId: created.team.id,
    to: '成员',
    text: '验证后开始工作。',
  });
  assert.ok(sent.messageId);

  const fallbackIdentity = createExternalIdentity(bus.store, {
    principalName: '仅拉取用户',
    bindingName: '仅拉取会话',
    host: 'codex',
    session: 'thread-fallback',
    declared: {
      capabilities: Object.values(CONTROL_CAPABILITIES),
      workspaceRoots: [directory],
      policies: ['read-only'],
    },
    probed: {
      capabilities: Object.values(CONTROL_CAPABILITIES),
      workspaceRoots: [directory],
      policies: ['read-only'],
    },
  });
  const fallbackCall = (name, args = {}) =>
    bus.controlTool(fallbackIdentity.binding.id, fallbackIdentity.key, name, args);
  const fallbackTeam = await fallbackCall('team_create', {
    name: '拉取团队',
    workspace: directory,
    members: '成员=fake',
    policy: 'read-only',
  });
  const accepted = await fallbackCall('control_accept_pull_only');
  assert.equal(accepted.wake.state, 'degraded');
  const fallbackSent = await fallbackCall('team_send', {
    teamId: fallbackTeam.team.id,
    to: '成员',
    text: '仅拉取路径。',
  });
  assert.ok(fallbackSent.messageId);
  assert.notEqual(identity.binding.id, fallbackIdentity.binding.id);
});

test('headless controller configures member models through the live catalog', async t => {
  const { host, call, directory } = setup(t, {
    externalWake: async () => ({ supported: true, state: 'started', mode: 'codex' }),
  });
  host.listModels = async () => ({
    version: 1,
    host: 'fake',
    source: 'test',
    defaultModel: 'fast',
    reasoningEfforts: [],
    models: [
      {
        key: 'fast',
        id: 'fast',
        label: 'Fast',
        reasoningEfforts: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }],
        defaultReasoningEffort: 'high',
        isDefault: true,
      },
      {
        key: 'deep',
        id: 'deep',
        label: 'Deep',
        reasoningEfforts: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }],
        defaultReasoningEffort: 'high',
        isDefault: false,
      },
    ],
  });
  const created = await call('team_create', {
    name: '模型配置团队',
    workspace: directory,
    members: [{
      name: '成员',
      host: 'fake',
      model: 'deep',
      reasoningEffort: 'low',
    }],
    policy: 'read-only',
  });
  let snapshot = await call('team_snapshot', { teamId: created.team.id });
  assert.equal(snapshot.members[0].model, 'deep');
  assert.equal(snapshot.members[0].reasoning_effort, 'low');
  await call('team_member_model', {
    teamId: created.team.id,
    member: '成员',
    model: 'fast',
    reasoningEffort: 'high',
  });
  snapshot = await call('team_snapshot', { teamId: created.team.id });
  assert.equal(snapshot.members[0].model, 'fast');
  assert.equal(snapshot.members[0].reasoning_effort, 'high');
  await assert.rejects(
    () => call('team_member_model', {
      teamId: created.team.id,
      member: '成员',
      model: 'missing',
      reasoningEffort: 'low',
    }),
    /不在该成员宿主目录/,
  );
});

test('team creation retries a transient live model catalog failure', async t => {
  const { host, call, directory } = setup(t, {
    externalWake: async () => ({ supported: true, state: 'started', mode: 'codex' }),
  });
  const catalog = {
    version: 1,
    host: 'fake',
    source: 'test',
    defaultModel: 'fast',
    reasoningEfforts: [],
    models: [{
      key: 'fast',
      id: 'fast',
      label: 'Fast',
      reasoningEfforts: [{ id: 'low', label: 'Low' }],
      defaultReasoningEffort: 'low',
      isDefault: true,
    }],
  };
  let attempts = 0;
  host.listModels = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('无法确认检测进程已停止');
    return catalog;
  };
  const created = await call('team_create', {
    name: '目录重试团队',
    workspace: directory,
    members: [{ name: '成员', host: 'fake', model: 'fast', reasoningEffort: 'low' }],
    policy: 'read-only',
  });
  assert.equal(attempts, 2);
  const snapshot = await call('team_snapshot', { teamId: created.team.id });
  assert.equal(snapshot.members[0].model, 'fast');
});

test('workspace-write is a ceiling and dispatch rejects missing member capabilities', async t => {
  const { host, call, directory } = setup(t, {
    externalWake: async () => ({ supported: true, state: 'started', mode: 'codex' }),
  });
  host.executionCapabilities = async ({ mode }) => mode !== 'communication'
    ? {
        effectivePolicy: 'read-only',
        capabilities: ['file.read'],
        reason: '宿主无法保证工作区写边界',
      }
    : { effectivePolicy: 'communication', capabilities: [], reason: '仅通信' };
  const created = await call('team_create', {
    name: '有效策略团队',
    workspace: directory,
    members: [{ name: '成员', host: 'fake' }],
    policy: 'workspace-write',
  });
  await call('control_wake_test');
  const snapshot = await call('team_snapshot', { teamId: created.team.id });
  assert.deepEqual(snapshot.members[0].executionPolicy, {
    requested: 'workspace-write',
    effective: 'read-only',
    capabilities: ['file.read'],
    reason: '宿主无法保证工作区写边界',
  });
  let capabilityError;
  await assert.rejects(
    async () => {
      try {
        await call('team_send', {
          teamId: created.team.id,
          to: '成员',
          text: '请修改文件。',
          requiredCapabilities: ['file.write', 'filesystem.boundary'],
        });
      } catch (error) {
        capabilityError = error;
        throw error;
      }
    },
    /capability_required/,
  );
  assert.equal(capabilityError.code, 'capability_required');
  assert.deepEqual(capabilityError.details.missingCapabilities, ['file.write', 'filesystem.boundary']);
  const sent = await call('team_send', {
    teamId: created.team.id,
    to: '成员',
    text: '请阅读文件。',
    requiredCapabilities: ['file.read'],
  });
  assert.ok(sent.messageId);
});

test('external binding rejects bad keys, foreign teams and workspaces outside its roots', async t => {
  const { bus, directory, identity, call } = setup(t);
  assert.throws(
    () => bus.controlTools(identity.binding.id, 'wrong-key'),
    /连接凭据无效/,
  );

  const created = await call('team_create', {
    name: '受控团队',
    workspace: directory,
    members: '',
    policy: 'read-only',
  });
  const another = createExternalIdentity(bus.store, {
    principalName: '另一个用户',
    bindingName: '另一个会话',
    host: 'claude',
    declared: {
      capabilities: Object.values(CONTROL_CAPABILITIES),
      workspaceRoots: [directory],
      policies: ['read-only'],
    },
    probed: {
      capabilities: Object.values(CONTROL_CAPABILITIES),
      workspaceRoots: [directory],
      policies: ['read-only'],
    },
  });
  await assert.rejects(
    () => Promise.resolve(bus.controlTool(another.binding.id, another.key, 'team_snapshot', { teamId: created.team.id })),
    /无权访问/,
  );
  await assert.rejects(
    () => Promise.resolve(call('team_create', {
      name: '越界团队',
      workspace: join(directory, '..'),
      members: '',
    })),
    /workspace roots/,
  );
});

test('workspace roots reject symlinks that resolve outside the registered boundary', async t => {
  const { directory, call } = setup(t);
  const outside = mkdtempSync(join(tmpdir(), 'agent-team-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const link = join(directory, 'outside-link');
  try {
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
      t.skip(`当前平台不能创建目录链接: ${error.code}`);
      return;
    }
    throw error;
  }
  await assert.rejects(
    () => call('team_create', {
      name: '链接越界团队',
      workspace: link,
      members: '',
    }),
    /workspace roots/,
  );
  assert.deepEqual((await call('control_teams')).teams, []);
});

test('credential rotation clears the previous binding wake configuration', async t => {
  const { bus, identity } = setup(t);
  bus.controlTools(identity.binding.id, identity.key);
  const rotated = createExternalIdentity(bus.store, {
    principalName: identity.principal.name,
    bindingName: identity.binding.name,
    host: 'codex',
    session: 'rotated-thread',
    declared: identity.capabilities,
    probed: identity.capabilities,
  });
  assert.equal(rotated.binding.wake_config, null);
  assert.equal(rotated.binding.session, 'rotated-thread');
  assert.throws(() => bus.controlTools(identity.binding.id, identity.key), /连接凭据无效/);
});

test('one principal can connect twice but only the active binding can write a team', async t => {
  const { bus, directory, identity, call } = setup(t);
  const created = await call('team_create', {
    name: '绑定席位团队',
    workspace: directory,
    members: '',
    policy: 'read-only',
  });
  const second = createExternalIdentity(bus.store, {
    principalName: identity.principal.name,
    bindingName: '第二个会话',
    host: 'claude',
    declared: {
      capabilities: Object.values(CONTROL_CAPABILITIES),
      workspaceRoots: [directory],
      policies: ['read-only'],
    },
    probed: {
      capabilities: Object.values(CONTROL_CAPABILITIES),
      workspaceRoots: [directory],
      policies: ['read-only'],
    },
  });
  const secondCall = (name, args = {}) => bus.controlTool(second.binding.id, second.key, name, args);
  assert.equal((await secondCall('team_snapshot', { teamId: created.team.id })).team.id, created.team.id);
  const listed = await secondCall('control_teams');
  assert.equal(listed.teams[0].active, false);
  await assert.rejects(
    () => secondCall('team_tasks_set', { teamId: created.team.id, tasks: [] }),
    /team_activate/,
  );
  assert.equal((await secondCall('team_activate', { teamId: created.team.id })).activeBindingId, second.binding.id);
  assert.equal((await secondCall('control_teams')).teams[0].active, true);
  await assert.rejects(
    () => call('team_tasks_set', { teamId: created.team.id, tasks: [] }),
    /team_activate/,
  );
});

test('member decision requests reach the controller and structured answers wake the requester', async t => {
  const { bus, directory, call } = setup(t);
  const created = await call('team_create', {
    name: '决策团队',
    workspace: directory,
    members: '成员=fake',
    policy: 'read-only',
  });
  await until(() => bus.running.size === 0, 'member profile turns did not settle');
  const member = bus.members(created.team.id)[0];
  const decision = bus.controlPlane.requestDecision({
    groupId: created.team.id,
    memberId: member.id,
    payload: {
      kind: 'choice',
      text: '选择发布窗口',
      options: ['今天', '明天'],
      cardOnly: true,
    },
  });
  await untilAsync(
    async () => (await call('control_status')).delivery.pending === 1,
    'decision request was not queued',
  );
  const inbox = await call('control_inbox');
  assert.equal(inbox.deliveries[0].payload.message.text, '选择发布窗口');
  const pending = await call('control_decisions', { teamId: created.team.id });
  assert.equal(pending.decisions[0].id, decision.decisionId);
  assert.deepEqual(pending.decisions[0].payload.options, ['今天', '明天']);

  const answered = await call('team_decision_answer', {
    teamId: created.team.id,
    requestId: decision.decisionId,
    answer: '明天',
  });
  assert.equal(answered.state, 'answered');
  assert.equal(answered.requesterMemberId, member.id);
  assert.deepEqual((await call('control_decisions', { teamId: created.team.id })).decisions, []);
  const shared = await call('team_read', { teamId: created.team.id, limit: 50 });
  assert.ok(
    shared.messages.some(message => message.id === answered.messageId),
    JSON.stringify(shared),
  );
  const answer = shared.messages.find(message => message.id === answered.messageId);
  assert.equal(answer.replyTo, pending.decisions[0].request_message_id);
  const userMessages = await call('team_read', {
    teamId: created.team.id,
    sender: 'user',
    limit: 50,
  });
  assert.ok(userMessages.messages.some(message => message.id === answered.messageId));
});

test('member ask tool routes through the external controller without a panel card', async t => {
  const { bus, directory, call } = setup(t);
  const created = await call('team_create', {
    name: '无头提问团队',
    workspace: directory,
    members: '成员=fake',
    policy: 'read-only',
  });
  await until(() => bus.running.size === 0, 'member profile turns did not settle');
  await call('control_wake_test');
  await call('team_send', {
    teamId: created.team.id,
    to: '成员',
    text: '请发起决策并等待用户。',
  });
  await untilAsync(
    async () => (await call('control_status')).decisions === 1,
    'member ask did not create an external decision request',
  );
  const decisions = await call('control_decisions', { teamId: created.team.id });
  assert.equal(decisions.decisions.length, 1);
  assert.equal(decisions.decisions[0].payload.kind, 'input');
  assert.equal(decisions.decisions[0].payload.text, '需要用户补充发布说明。');
  assert.equal((await call('control_inbox')).deliveries[0].payload.kind, 'send');
});

test('pending external controller deliveries and bindings survive a service restart', async t => {
  const { bus, directory, identity, call } = setup(t);
  const created = await call('team_create', {
    name: '重启团队',
    workspace: directory,
    members: '成员=fake',
    policy: 'read-only',
  });
  await until(() => bus.running.size === 0, 'member profile turns did not settle');
  const member = bus.members(created.team.id)[0];
  bus.store.append(created.team.id, member.id, identity.principal.id, 'send', '服务重启前的回复', null, false);
  bus.pump();
  await untilAsync(
    async () => (await call('control_status')).delivery.pending === 1,
    'pending external delivery was not persisted',
  );
  await bus.close();

  const reopened = new Bus({ directory, hosts: new Map([['fake', fakeHost({ profileText: null })]]) });
  try {
    const inbox = await reopened.controlTool(identity.binding.id, identity.key, 'control_inbox', { limit: 10 });
    assert.equal(inbox.deliveries.length, 1);
    assert.equal(inbox.deliveries[0].payload.message.text, '服务重启前的回复');
    assert.equal(inbox.deliveries[0].state, 'delivered');
    assert.equal((await reopened.controlTool(identity.binding.id, identity.key, 'control_status', {})).delivery.pending, 0);
  } finally {
    await reopened.close();
  }
});

test('protocol mismatch degrades to read-only tools and blocks control writes', async t => {
  const { bus, directory, identity, call } = setup(t);
  const created = await call('team_create', {
    name: '版本团队',
    workspace: directory,
    members: '',
    policy: 'read-only',
  });
  const tools = bus.controlTools(identity.binding.id, identity.key, 999);
  assert.ok(tools.some(tool => tool.name === 'control_protocol'));
  assert.ok(tools.some(tool => tool.name === 'team_snapshot'));
  assert.ok(!tools.some(tool => tool.name === 'team_create'));
  assert.ok(!tools.some(tool => tool.name === 'team_send'));
  const protocol = await bus.controlTool(identity.binding.id, identity.key, 'control_protocol', {}, 999);
  assert.equal(protocol.protocol.compatible, false);
  assert.equal(protocol.protocol.readOnly, true);
  await assert.rejects(
    () => bus.controlTool(identity.binding.id, identity.key, 'team_archive', { teamId: created.team.id }, 999),
    /MCP 协议不兼容/,
  );
});

test('decision tools require an explicit user elicitation capability', async t => {
  const { bus, directory, identity, call } = setup(t, { capabilities: [...CONTROLLER_REQUIRED_CAPABILITIES] });
  const created = await call('team_create', {
    name: '无提问能力团队',
    workspace: directory,
    members: '成员=fake',
    policy: 'read-only',
  });
  await until(() => bus.running.size === 0, 'member profile turns did not settle');
  const tools = bus.controlTools(identity.binding.id, identity.key);
  assert.ok(!tools.some(tool => tool.name === 'control_decisions'));
  assert.ok(!tools.some(tool => tool.name === 'team_decision_answer'));
  await assert.rejects(
    () => call('control_decisions', { teamId: created.team.id }),
    /user\.elicit/,
  );
  const member = bus.members(created.team.id)[0];
  assert.throws(
    () => bus.controlPlane.requestDecision({
      groupId: created.team.id,
      memberId: member.id,
      payload: { kind: 'input', text: '需要用户输入' },
    }),
    /user\.elicit/,
  );
});

test('unsupported active wake stays pending and is visible in control status', async t => {
  let wakeAttempts = 0;
  const { bus, directory, identity, call } = setup(t, {
    externalWake: async (_binding, _options) => {
      wakeAttempts += 1;
      return wakeAttempts === 1
        ? { supported: false, reason: '宿主未提供会话注入 API' }
        : { supported: true };
    },
  });
  const created = await call('team_create', {
    name: '仅拉取团队',
    workspace: directory,
    members: '成员=fake',
    policy: 'read-only',
  });
  await until(() => bus.running.size === 0, 'member profile turns did not settle');
  const failed = await call('control_wake_test');
  assert.equal(failed.wake.state, 'unsupported');
  await call('control_accept_pull_only');
  await call('team_send', {
    teamId: created.team.id,
    to: '成员',
    text: '请回复。',
  });
  await untilAsync(
    async () => (await call('control_status')).delivery.pending === 1,
    'pull-only delivery was not retained',
  );
  const status = await call('control_status');
  assert.equal(status.delivery.pending, 1);
  assert.equal(status.wake.state, 'degraded');
  assert.equal(status.delivery.wake.pending, 1);
  await bus.controlTool(identity.binding.id, identity.key, 'control_protocol', {}, 1, 'new-thread');
  const recovered = await call('control_wake_test');
  assert.equal(recovered.wake.state, 'ready');
  await untilAsync(
    async () => (await call('control_status')).delivery.wake.sent === 1,
    'wake recovery did not retry the unsupported delivery',
  );
  assert.equal((await call('control_inbox')).deliveries.length, 1);
});

test('active wake is serialized for one controller session', async t => {
  let active = 0;
  let maximum = 0;
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const { call, directory } = setup(t, {
    externalWake: async (_binding, options) => {
      if (options.verification) return { supported: true, state: 'started' };
      active += 1;
      maximum = Math.max(maximum, active);
      await blocked;
      active -= 1;
      return { supported: true, state: 'started' };
    },
  });
  const created = await call('team_create', {
    name: '串行唤醒团队',
    workspace: directory,
    members: '成员=fake',
    policy: 'read-only',
  });
  await call('control_wake_test');
  maximum = 0;
  await call('team_send', { teamId: created.team.id, to: '成员', text: '第一项' });
  await untilAsync(() => active === 1, 'first wake did not start');
  await call('team_send', { teamId: created.team.id, to: '成员', text: '第二项' });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(maximum, 1);
  release();
  let claimed = 0;
  await untilAsync(async () => {
    claimed += (await call('control_inbox', { limit: 100 })).deliveries.length;
    return claimed === 2;
  }, 'serialized wakes did not settle');
});
