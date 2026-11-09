import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../../bus.mjs';
import { createTestGroup } from '../support/fixture.mjs';
import { claudeExecutionConfig, codexSandboxConfig, executionPolicy, sandboxMode } from '../../hosts/policies.mjs';
import { writeMcpFiles } from '../../hosts/process.mjs';
import { apply as applyDshPolicy } from '../../hosts/dsh-policy.mjs';

async function until(fn) {
  for (let index = 0; index < 400; index++) {
    if (fn()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('timeout');
}

function catalog(hostName, model = 'fake-model', provider = 'fake-provider') {
  return {
    version: 1,
    host: hostName,
    source: 'test',
    defaultModel: model,
    reasoningEfforts: [{ id: 'low', label: 'low' }],
    models: [{
      id: model,
      key: model,
      label: model,
      ...(provider ? { provider } : {}),
      reasoningEfforts: [{ id: 'low', label: 'low' }],
      defaultReasoningEffort: 'low',
      isDefault: true,
    }],
  };
}

function hostFixture(calls = [], {
  panel = true,
  host = 'fake',
  model = 'fake-model',
  provider = 'fake-provider',
} = {}) {
  return {
    async listModels() { return catalog(host, model, provider); },
    supportsPanelAccess({ access }) {
      return panel ? { supported: true } : { supported: false, reason: `测试宿主不支持 ${access}` };
    },
    async run(context) {
      calls.push({
        endpoint: context.endpoint.id,
        context: context.endpoint.context,
        groupId: context.endpoint.group_id,
        workspace: context.workspace,
        policy: context.policy,
        prompt: context.prompt,
      });
      context.onSession(context.endpoint.session ?? `session-${context.endpoint.id}`);
      if (context.endpoint.context === 'profile') await context.onTool('profile_set', { text: 'test profile' });
      context.onAccepted();
      return context.endpoint.context.startsWith('panel-') ? 'panel reply' : 'done';
    },
  };
}

async function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-panel-access-'));
  const workspace = mkdtempSync(join(tmpdir(), 'agent-team-panel-workspace-'));
  const calls = [];
  const hosts = new Map([['fake', hostFixture(calls, options)]]);
  if (options.secondHost) hosts.set('fake-2', hostFixture(calls));
  const bus = new Bus({ directory, hosts });
  bus.start();
  t.after(async () => {
    await bus.close();
    rmSync(directory, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });
  return { bus, directory, workspace, calls };
}

const baseAgent = {
  name: 'Panel Agent',
  host: 'fake',
  model_provider: 'fake-provider',
  model: 'fake-model',
  reasoning_effort: 'low',
};

test('Panel access configuration is validated before persistence', async t => {
  // 默认工作区落在临时 HOME 下,不污染真实 Documents。
  // 同时补建 Documents:Linux CI 无桌面环境时缺少该目录会走 XDG 回退分支,
  // 与 macOS/Windows 的期望路径不同;回退分支由 default-workspace.test.mjs 单独覆盖。
  const fakeHome = mkdtempSync(join(tmpdir(), 'agent-home-'));
  mkdirSync(join(fakeHome, 'Documents'));
  // os.homedir() 在 Windows 读 USERPROFILE、其余平台读 HOME,两者都要替换。
  const previousHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  t.after(() => {
    process.env.HOME = previousHome.HOME;
    process.env.USERPROFILE = previousHome.USERPROFILE;
    rmSync(fakeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const { bus, workspace } = await fixture(t);
  await assert.rejects(bus.createPanelAgent({ ...baseAgent, access: 'invalid' }), /访问级别无效/);
  // 未提供工作区:按系统默认目录自动供给,创建成功(见 default-workspace 模块)。
  await assert.rejects(bus.createPanelAgent({ ...baseAgent, access: 'workspace-write', workspace: join(workspace, 'missing') }), /不存在/);
  await assert.rejects(bus.createPanelAgent({ ...baseAgent, access: 'read-only', workspace: bus.store.directory }), /数据目录/);

  const created = await bus.createPanelAgent({ ...baseAgent, access: 'read-only' });
  assert.equal(created.agent.access, 'read-only');
  assert.equal(created.agent.workspace, join(fakeHome, 'Documents', 'AgentTeam'), '默认工作区开箱即用');

  // 显式提供的工作区仍按原样校验。
  const updated = await bus.updatePanelAgent({ access: 'workspace-write', workspace });
  assert.equal(updated.agent.access, 'workspace-write');
  assert.equal(updated.agent.workspace, workspace);
  await assert.rejects(bus.updatePanelAgent({ access: 'full-access', workspace: join(workspace, 'missing') }), /不存在/);
  // 清空工作区 = 回落默认目录,而不是允许 null。
  const reset = await bus.updatePanelAgent({ workspace: '' });
  assert.equal(reset.agent.workspace, join(fakeHome, 'Documents', 'AgentTeam'));
});

test('Panel access rejects hosts without the required capability', async t => {
  const { bus, workspace } = await fixture(t, { panel: false });
  await assert.rejects(
    bus.createPanelAgent({ ...baseAgent, access: 'workspace-write', workspace }),
    /不支持私人访问级别 workspace-write/,
  );
});

test('Panel private turns use the user-level access and workspace while coordination stays communication', async t => {
  const { bus, directory, workspace, calls } = await fixture(t);
  const group = createTestGroup(bus, {
    name: 'panel access team',
    workspace: directory,
    lead: { name: 'lead', host: 'fake' },
    members: [{ name: 'worker', host: 'fake' }],
  });
  await until(() => !bus.running.size);
  const created = await bus.createPanelAgent({ ...baseAgent, access: 'workspace-write', workspace });
  const agent = created.agent;
  bus.takeoverTeam(group.id, 0);

  await bus.panelPrivateTurn({ text: 'private hello' });
  const privateCall = calls.find(call => call.context === 'private' && call.prompt === 'private hello');
  assert.ok(privateCall);
  assert.equal(privateCall.workspace, workspace);
  assert.equal(privateCall.policy.mode, 'workspace-write');
  assert.equal(privateCall.policy.access, 'workspace-write');
  assert.equal(privateCall.policy.allowShell, true);
  assert.equal(privateCall.policy.domain, 'project');

  const coordination = bus.store.panelSession(agent.id, 'coordination', group.id);
  await bus.runPanelTurn({
    session: { ...coordination, group_id: group.id },
    panelAgent: bus.panelAgent(),
    prompt: 'coordination hello',
    activeTeamId: group.id,
  });
  const coordinationCall = calls.find(call => call.context === 'coordination' && call.prompt === 'coordination hello');
  assert.ok(coordinationCall);
  assert.equal(coordinationCall.workspace, group.workspace);
  assert.equal(coordinationCall.policy.mode, 'communication');
  assert.equal(coordinationCall.policy.allowShell, false);
  assert.equal(coordinationCall.policy.access, undefined);
});

test('Panel configuration changes rebuild only the private host session', async t => {
  const { bus, workspace } = await fixture(t, { secondHost: true });
  const created = await bus.createPanelAgent({ ...baseAgent, access: 'read-only' });
  const agent = created.agent;
  const group = createTestGroup(bus, {
    name: 'session reset team',
    workspace: bus.store.directory,
    lead: { name: 'lead', host: 'fake' },
    members: [],
  });
  await until(() => !bus.running.size);
  bus.takeoverTeam(group.id, 0);
  bus.store.panelSession(agent.id, 'coordination', group.id);
  const setSessions = () => {
    bus.store.run("UPDATE conversations SET session='private-session',policy_signature='sig' WHERE panel_agent_id=? AND context='private'", agent.id);
    bus.store.run("UPDATE conversations SET session='coord-session',policy_signature='sig' WHERE panel_agent_id=? AND context='coordination'", agent.id);
  };
  const sessions = () => ({
    private: bus.store.get("SELECT session FROM conversations WHERE panel_agent_id=? AND context='private'", agent.id)?.session ?? null,
    coordination: bus.store.get("SELECT session FROM conversations WHERE panel_agent_id=? AND context='coordination'", agent.id)?.session ?? null,
  });

  setSessions();
  await bus.updatePanelAgent({ name: 'Renamed Panel Agent' });
  assert.deepEqual(sessions(), { private: 'private-session', coordination: 'coord-session' });

  setSessions();
  await bus.updatePanelAgent({ workspace });
  assert.deepEqual(sessions(), { private: null, coordination: 'coord-session' });

  setSessions();
  await bus.updatePanelAgent({ access: 'workspace-write' });
  assert.deepEqual(sessions(), { private: null, coordination: 'coord-session' });

  setSessions();
  await bus.updatePanelAgent({ host: 'fake-2' });
  assert.deepEqual(sessions(), { private: null, coordination: null });
});

test('Panel can switch from a provider-qualified host to a providerless model', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-panel-provider-switch-'));
  const first = hostFixture([], { host: 'first', model: 'first-model', provider: 'first-provider' });
  const second = hostFixture([], { host: 'second', model: 'second-model', provider: null });
  const bus = new Bus({
    directory,
    hosts: new Map([
      ['first', first],
      ['second', second],
    ]),
  });
  t.after(async () => {
    await bus.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await bus.createPanelAgent({
    name: 'Provider switch',
    host: 'first',
    model_provider: 'first-provider',
    model: 'first-model',
    reasoning_effort: 'low',
    access: 'read-only',
  });
  const switched = await bus.updatePanelAgent({
    host: 'second',
    model_provider: null,
    model: 'second-model',
    reasoning_effort: 'low',
  });
  assert.equal(switched.agent.host, 'second');
  assert.equal(switched.agent.model, 'second-model');
  assert.equal(switched.agent.model_provider, null);
});

test('Legacy Panel Agent rows migrate to read-only and reset the private host session only', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-panel-migration-'));
  const raw = new DatabaseSync(join(directory, 'groups.sqlite'));
  raw.exec(`
    CREATE TABLE panel_agents(id TEXT PRIMARY KEY,singleton INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK(singleton=1),name TEXT NOT NULL,host TEXT NOT NULL,model_provider TEXT,model TEXT,reasoning_effort TEXT,created TEXT NOT NULL,updated TEXT NOT NULL);
    CREATE TABLE panel_sessions(id TEXT PRIMARY KEY,panel_agent_id TEXT NOT NULL,context TEXT NOT NULL,group_id TEXT,session TEXT,key TEXT NOT NULL UNIQUE,created TEXT NOT NULL,updated TEXT NOT NULL);
    INSERT INTO panel_agents VALUES('legacy',1,'Legacy','fake',NULL,NULL,NULL,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
    INSERT INTO panel_sessions VALUES('private-row','legacy','private',NULL,'host-private','key-1','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
    INSERT INTO panel_sessions VALUES('coordination-row','legacy','coordination',NULL,'host-coordination','key-2','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
  `);
  raw.close();
  const calls = [];
  const bus = new Bus({ directory, hosts: new Map([['fake', hostFixture(calls)]]) });
  t.after(async () => {
    await bus.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const agent = bus.panelAgent();
  assert.equal(agent.access, 'read-only');
  assert.equal(agent.workspace, null);
  // 迁移结果走公共视图：私聊会话被重置，协作会话保留原 host session。
  const sessions = bus.panelAgentState().sessions;
  assert.equal(sessions.find(row => row.context === 'private')?.session ?? null, null);
  assert.equal(sessions.find(row => row.context === 'coordination')?.session, 'host-coordination');
});

test('Panel access maps to Codex sandbox and Claude tool configuration', () => {
  assert.equal(executionPolicy({ policy: { mode: 'workspace-write', allowShell: true, access: 'workspace-write' } }).access, 'workspace-write');
  assert.equal(executionPolicy({ policy: { mode: 'communication', allowShell: false } }).access, undefined);
  assert.equal(sandboxMode('read-only'), 'read-only');
  assert.equal(sandboxMode('workspace-write'), 'workspace-write');
  assert.equal(sandboxMode('full-access'), 'danger-full-access');

  const full = claudeExecutionConfig({ mode: 'full-access', allowShell: true, access: 'full-access' }, [], '/ws');
  assert.deepEqual(full.builtins, ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash']);
  assert.ok(full.allowed.includes('Edit'));
  assert.equal(full.sandbox, null);

  const workspaceWrite = claudeExecutionConfig({ mode: 'workspace-write', allowShell: true, access: 'workspace-write' }, [], '/ws');
  assert.ok(workspaceWrite.allowed.includes('Edit(**)'));
  assert.ok(workspaceWrite.allowed.includes('Write(**)'));
  assert.equal(workspaceWrite.sandbox.filesystem, undefined);

  const readOnly = claudeExecutionConfig({ mode: 'read-only', allowShell: true, access: 'read-only' }, [], '/ws');
  assert.ok(!readOnly.builtins.includes('Edit'));
  assert.ok(readOnly.builtins.includes('Bash'));
  assert.deepEqual(readOnly.sandbox.filesystem.denyWrite, ['/ws']);

  assert.deepEqual(codexSandboxConfig({ mode: 'full-access' }, '/ws'), {
    sandbox: 'danger-full-access',
    turnSandboxPolicy: { type: 'dangerFullAccess' },
  });
  assert.deepEqual(codexSandboxConfig({ mode: 'workspace-write' }, '/ws'), {
    sandbox: 'workspace-write',
    turnSandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/ws'], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
  });
});

test('DSH patch and policy plugin carry the full-access and read-only tiers', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-panel-dsh-'));
  const workspace = mkdtempSync(join(tmpdir(), 'agent-team-panel-dsh-workspace-'));
  mkdirSync(workspace, { recursive: true });
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  const files = writeMcpFiles(directory, join(directory, 'bus.sock'), { id: 'endpoint-1', key: 'key-1' }, 'turn-1', {
    mode: 'full-access', allowShell: true, access: 'full-access', workspace, tools: ['mcp__agent_team__team_read'],
  });
  const patch = JSON.parse(readFileSync(files.dsh, 'utf8'));
  assert.equal(patch.find(entry => entry.id === 'sandbox-policy').config.mode, 'danger-full-access');
  assert.equal(patch.find(entry => entry.id === 'permission').config.presets.team.sandbox, 'danger-full-access');
  const plugin = patch.flatMap(entry => entry.insert ?? []).find(entry => entry.id === 'agent-team-policy');
  assert.equal(plugin.config.mode, 'full-access');
  assert.equal(plugin.config.allowShell, true);

  const runPlugin = config => {
    let created;
    applyDshPolicy({ on(event, handler) { if (event === 'agent/created') created = handler; } }, config);
    const appends = [];
    const restrictions = [];
    created({
      agent: {
        session: { append: (key, value) => appends.push({ key, value }) },
        ctx: { tools: { get: name => ({ name }), restrict: options => restrictions.push(options) } },
      },
    });
    return { appends, restrictions };
  };
  const full = runPlugin({ mode: 'full-access', allowShell: true, tools: ['mcp__agent_team__team_read'] });
  assert.deepEqual(full.appends.find(item => item.key === 'sandbox/mode').value, { mode: 'danger-full-access' });
  assert.ok(full.restrictions[0].allow.includes('write'));
  assert.ok(full.restrictions[0].allow.includes('bash'));

  const readOnly = runPlugin({ mode: 'read-only', allowShell: true, tools: ['mcp__agent_team__team_read'] });
  assert.deepEqual(readOnly.appends.find(item => item.key === 'sandbox/mode').value, { mode: 'read-only' });
  assert.ok(!readOnly.restrictions[0].allow.includes('write'));
  assert.ok(readOnly.restrictions[0].allow.includes('bash'));
});

test('panel agent creation falls back to the per-OS default workspace', async t => {
  // 用临时 HOME 隔离:默认目录落在临时目录里,不污染用户真实 Documents。
  // 补建 Documents 以在三个平台走同一主分支;Linux 的 XDG 回退见 default-workspace.test.mjs。
  const fakeHome = mkdtempSync(join(tmpdir(), 'agent-home-'));
  mkdirSync(join(fakeHome, 'Documents'));
  // os.homedir() 在 Windows 读 USERPROFILE、其余平台读 HOME,两者都要替换。
  const previousHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  t.after(() => {
    process.env.HOME = previousHome.HOME;
    process.env.USERPROFILE = previousHome.USERPROFILE;
    rmSync(fakeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const { bus } = await fixture(t);
  // 未提供 workspace:创建时自动使用默认目录并确保存在。
  const state = await bus.createPanelAgent({ ...baseAgent });
  const workspace = state.agent.workspace;
  assert.equal(workspace, join(fakeHome, 'Documents', 'AgentTeam'), '默认工作区落在临时 HOME 下');
  assert.ok(await import('node:fs').then(fs => fs.existsSync(workspace)), '默认工作区已创建');
  // 显式提供的工作区仍然按原样校验使用。
  const explicit = mkdtempSync(join(tmpdir(), 'agent-explicit-ws-'));
  t.after(() => rmSync(explicit, { recursive: true, force: true }));
  const updated = await bus.updatePanelAgent({ workspace: explicit, access: 'workspace-write' });
  assert.equal(updated.agent.workspace, explicit);
});
