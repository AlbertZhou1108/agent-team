import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../../bus.mjs';
import { startServer } from '../../server.mjs';
import { until } from '../support/wait.mjs';
import { validateTool } from '../../tools/registry.mjs';

// 异构建群全入口契约：
// - bus.createGroup / HTTP / Panel team_create / 成员 group_add 卡都能按成员指定
//   selection、policyCeiling、allowShell、allowBrowser，且旧 {name,host} 入参行为不变；
// - 群策略是硬天花板：越级 policyCeiling 同步拒绝；显式模型按宿主已探测目录校验；
// - 展示投影成员行附带只读能力名片，不写库。

const CODER = {
  key: 'coder', id: 'coder', label: 'Coder', provider: 'prov-a',
  inputModalities: ['text'], contextWindow: 128000,
  reasoningEfforts: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }],
  defaultReasoningEffort: 'low', isDefault: true,
};
const REVIEWER = {
  key: 'reviewer', id: 'reviewer', label: 'Reviewer', provider: 'prov-b',
  inputModalities: ['text'], contextWindow: 64000,
  reasoningEfforts: [{ id: 'low', label: 'Low' }],
  defaultReasoningEffort: 'low',
};

function hostFor(hostName, models, executionCapabilities = null) {
  return {
    async listModels() {
      return { version: 1, host: hostName, source: 'test', defaultModel: models[0].key, reasoningEfforts: [], models };
    },
    ...(executionCapabilities ? { executionCapabilities } : {}),
    async run(context) {
      context.onSession(context.endpoint.session ?? context.endpoint.id);
      if (context.endpoint.context === 'profile') {
        await context.onTool('profile_set', { text: 'ready' });
        context.onAccepted();
        return '';
      }
      context.onAccepted();
      return '';
    },
  };
}

function heterogeneousFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'heterogeneous-'));
  const codexHost = hostFor('codex', [CODER], ({ mode, allowShell, allowBrowser }) => ({
    effectivePolicy: mode === 'communication' ? 'communication' : 'workspace-write',
    capabilities: mode === 'communication' ? [] : ['exec.read', 'exec.write', ...(allowShell ? ['exec.shell'] : [])],
    reason: null,
    toolBrowser: allowBrowser === true && mode !== 'communication',
    browserReason: allowBrowser === true ? null : '成员未获浏览器/Computer Use 授权（allowBrowser=false）',
  }));
  const dshHost = hostFor('dsh', [REVIEWER], ({ mode, allowShell, allowBrowser }) => ({
    effectivePolicy: mode === 'communication' ? 'communication' : (mode === 'read-only' ? 'read-only' : 'workspace-write'),
    capabilities: mode === 'communication' ? [] : ['exec.read', 'exec.write', ...(allowShell ? ['exec.shell'] : [])],
    reason: null,
    toolBrowser: false,
    browserReason: allowBrowser === true ? '当前受控启动配置仅挂载 agent_team MCP，未放行浏览器/Computer Use MCP' : undefined,
  }));
  const hosts = new Map([['codex', codexHost], ['dsh', dshHost]]);
  const bus = new Bus({ directory, hosts });
  t.after(async () => {
    if (!bus.closing) await bus.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论 */ }
  });
  return { bus, directory, hosts };
}

function memberNamed(bus, group, name) {
  return bus.members(group.id).find(member => member.name === name);
}

test('createGroup accepts a heterogeneous member matrix and projections carry capability cards', async t => {
  const { bus, directory } = heterogeneousFixture(t);
  await bus.modelCatalog();
  const group = bus.createGroup({
    name: '异构团队',
    workspace: directory,
    policy: 'workspace-write',
    allowShell: true,
    lead: {
      name: 'lead',
      host: 'codex',
      selection: { model_provider: 'prov-a', model: 'coder', reasoning_effort: 'high' },
    },
    members: [
      { name: '编码', host: 'dsh', selection: { model: 'reviewer', reasoning_effort: 'low' }, policyCeiling: 'workspace-write', allowShell: true, allowBrowser: true },
      { name: '审查', host: 'codex', policyCeiling: 'read-only', allowShell: false },
    ],
  });
  await until(() => bus.running.size === 0);
  assert.equal(group.policy, 'workspace-write');
  assert.equal(group.allow_shell, 1);

  const lead = memberNamed(bus, group, 'lead');
  assert.equal(lead.model, 'coder');
  assert.equal(lead.model_provider, 'prov-a');
  assert.equal(lead.reasoning_effort, 'high');

  const coder = memberNamed(bus, group, '编码');
  assert.equal(coder.host, 'dsh');
  assert.equal(coder.model, 'reviewer');
  assert.equal(coder.model_provider, 'prov-b');
  assert.equal(coder.policy_ceiling, 'workspace-write');
  assert.equal(coder.allow_shell, 1);
  assert.equal(coder.allow_browser, 1);

  const reviewer = memberNamed(bus, group, '审查');
  assert.equal(reviewer.policy_ceiling, 'read-only');
  assert.equal(reviewer.allow_shell, 0);
  assert.equal(reviewer.allow_browser, 0);

  // 目录投影：成员行保留既有字段，附带只读名片；dsh 未检测到浏览器工具时 tool.browser 保守 false。
  const projected = bus.queryDirectory().members.find(row => row.id === coder.id);
  assert.ok(projected);
  assert.equal(projected.name, '编码');
  assert.equal(projected.capabilityCard.effectivePolicy.ceiling, 'workspace-write');
  assert.equal(projected.capabilityCard.effectivePolicy.mode, 'workspace-write');
  assert.equal(projected.capabilityCard.effectiveCapabilities['exec.write'], true);
  assert.equal(projected.capabilityCard.effectiveCapabilities['tool.browser'], false);
  assert.equal(bus.overview().members.find(row => row.id === coder.id).capabilityCard.memberId, coder.id);
  assert.equal(bus.snapshot(group.id).members.find(row => row.id === reviewer.id).capabilityCard.effectivePolicy.ceiling, 'read-only');
});

test('createGroup keeps operationId replay semantics and old minimal input defaults', async t => {
  const { bus, directory } = heterogeneousFixture(t);
  await bus.modelCatalog();
  const spec = {
    name: '幂等团队',
    workspace: directory,
    lead: { name: 'lead', host: 'codex' },
    members: [{ name: '成员A', host: 'dsh' }],
    operationId: 'hetero-op-1',
  };
  const first = bus.createGroup(spec);
  const replay = bus.createGroup({ ...spec, lead: { ...spec.lead }, members: spec.members.map(member => ({ ...member })) });
  assert.equal(replay.id, first.id);
  assert.throws(
    () => bus.createGroup({ ...spec, members: [{ name: '成员A', host: 'dsh', allowBrowser: true }] }),
    /请求编号已用于不同建群内容/,
  );
  await until(() => bus.running.size === 0);

  // 旧极简入参：新字段全部取默认（继承群策略、命令继承、浏览器关闭）。
  const legacy = bus.createGroup({
    name: '旧入参',
    workspace: directory,
    lead: { name: 'old-lead', host: 'codex' },
    members: [{ name: 'old-member', host: 'dsh' }],
  });
  await until(() => bus.running.size === 0);
  const legacyMember = memberNamed(bus, legacy, 'old-member');
  assert.equal(legacyMember.policy_ceiling, null);
  assert.equal(legacyMember.allow_shell, null);
  assert.equal(legacyMember.allow_browser, 0);
  assert.equal(legacy.policy, 'workspace-write');
});

test('createGroup rejects above-ceiling policy and unresolvable explicit models', async t => {
  const { bus, directory } = heterogeneousFixture(t);
  assert.throws(
    () => bus.createGroup({
      name: '越级团队',
      workspace: directory,
      policy: 'read-only',
      lead: { name: 'lead', host: 'codex' },
      members: [{ name: '成员A', host: 'dsh', policyCeiling: 'workspace-write' }],
    }),
    /不能超过群策略/,
  );
  assert.throws(
    () => bus.createGroup({
      name: '越级主控',
      workspace: directory,
      policy: 'read-only',
      lead: { name: 'lead', host: 'codex', policyCeiling: 'workspace-write' },
    }),
    /不能超过群策略/,
  );
  // 目录未就绪时：未指定模型允许建群，显式模型严格拒绝。
  assert.throws(
    () => bus.createGroup({
      name: '无目录团队',
      workspace: directory,
      lead: { name: 'lead', host: 'codex' },
      members: [{ name: '成员A', host: 'dsh', selection: { model: 'reviewer' } }],
    }),
    /没有可用模型目录/,
  );
  const defaults = bus.createGroup({
    name: '默认模型团队',
    workspace: directory,
    lead: { name: 'lead', host: 'codex' },
    members: [{ name: '成员A', host: 'dsh' }],
  });
  await until(() => bus.running.size === 0);
  assert.equal(memberNamed(bus, defaults, '成员A').model, null);

  await bus.modelCatalog();
  assert.throws(
    () => bus.createGroup({
      name: '无效模型团队',
      workspace: directory,
      lead: { name: 'lead', host: 'codex' },
      members: [{ name: '成员A', host: 'dsh', selection: { model: 'nope' } }],
    }),
    /不在该成员宿主目录/,
  );
  assert.throws(
    () => bus.createGroup({
      name: '无效强度团队',
      workspace: directory,
      lead: { name: 'lead', host: 'codex' },
      members: [{ name: '成员A', host: 'dsh', selection: { model: 'reviewer', reasoning_effort: 'high' } }],
    }),
    /思考强度不受支持/,
  );
});

test('member group_add card carries member config and lands it after approval', async t => {
  const { bus, directory } = heterogeneousFixture(t);
  await bus.modelCatalog();
  const group = bus.createGroup({
    name: '加人团队',
    workspace: directory,
    policy: 'workspace-write',
    lead: { name: 'lead', host: 'codex' },
  });
  await until(() => bus.running.size === 0);
  const lead = memberNamed(bus, group, 'lead');
  const endpoint = bus.store.endpoint(lead.id, 'coordination');

  const card = await bus.tool(endpoint.id, endpoint.key, 'group_add', {
    name: '新人',
    host: 'dsh',
    selection: { model: 'reviewer', reasoning_effort: 'low' },
    policy_ceiling: 'read-only',
    allow_shell: false,
    allow_browser: true,
  });
  assert.equal(card.kind, 'group_add');
  assert.equal(card.state, 'pending');
  assert.equal(card.payload.args.member ?? card.payload.args.name, '新人');
  assert.equal(card.payload.args.selection.model, 'reviewer');
  assert.equal(card.payload.args.policyCeiling, 'read-only');
  assert.equal(card.payload.args.allowShell, false);
  assert.equal(card.payload.args.allowBrowser, true);
  assert.equal(bus.members(group.id).some(member => member.name === '新人'), false);

  await bus.decideInteraction(card.id, { approved: true });
  await until(() => bus.running.size === 0);
  const added = memberNamed(bus, group, '新人');
  assert.equal(added.model, 'reviewer');
  assert.equal(added.policy_ceiling, 'read-only');
  assert.equal(added.allow_shell, 0);
  assert.equal(added.allow_browser, 1);

  // 群策略天花板与显式模型同样在工具入口同步拒绝。
  const readOnlyGroup = bus.createGroup({
    name: '只读加人团队',
    workspace: directory,
    policy: 'read-only',
    lead: { name: '只读主控', host: 'codex' },
  });
  await until(() => bus.running.size === 0);
  const readOnlyLead = memberNamed(bus, readOnlyGroup, '只读主控');
  const readOnlyEndpoint = bus.store.endpoint(readOnlyLead.id, 'coordination');
  await assert.rejects(
    () => bus.tool(readOnlyEndpoint.id, readOnlyEndpoint.key, 'group_add', { name: '越级', host: 'dsh', policy_ceiling: 'workspace-write' }),
    /不能超过群策略/,
  );
  await assert.rejects(
    () => bus.tool(endpoint.id, endpoint.key, 'group_add', { name: '坏模型', host: 'dsh', selection: { model: 'nope' } }),
    /不在该成员宿主目录/,
  );
  assert.equal(bus.members(readOnlyGroup.id).some(member => member.name === '越级'), false);
  // 成员工具面不暴露 member_policy（无法自我提权），主 Agent 才可用。
  assert.throws(() => validateTool('member', 'member_policy', { member: '新人' }, 'coordination'), /不可使用/);
  assert.doesNotThrow(() => validateTool('lead', 'member_policy', { member: '新人' }, 'coordination'));
});

test('Panel team_create accepts memberConfigs and Panel group_add applies member config', async t => {
  const { bus, directory } = heterogeneousFixture(t);
  await bus.modelCatalog();
  await bus.createPanelAgent({ name: 'Panel', host: 'codex', model: 'coder', reasoning_effort: 'low' });
  const agent = bus.panelAgent();
  const privateSession = bus.store.panelSession(agent.id, 'private');
  const group = await bus.panelTool(privateSession.id, privateSession.key, 'team_create', {
    name: 'Panel 异构团队',
    workspace: directory,
    policy: 'workspace-write',
    allowShell: false,
    memberConfigs: [
      { name: '编码', host: 'dsh', model: 'reviewer', reasoningEffort: 'low', policyCeiling: 'workspace-write', allowShell: true, allowBrowser: true },
      { name: '审查', host: 'codex', policyCeiling: 'read-only' },
    ],
  });
  await until(() => bus.running.size === 0);
  assert.equal(group.policy, 'workspace-write');
  assert.equal(group.allow_shell, 0);
  const coder = memberNamed(bus, group, '编码');
  assert.equal(coder.model, 'reviewer');
  assert.equal(coder.policy_ceiling, 'workspace-write');
  assert.equal(coder.allow_browser, 1);
  assert.equal(memberNamed(bus, group, '审查').policy_ceiling, 'read-only');

  // members 与 memberConfigs 重名冲突按建群重名校验拒绝。
  await assert.rejects(
    () => bus.panelTool(privateSession.id, privateSession.key, 'team_create', {
      name: '重名团队',
      workspace: directory,
      members: '重复=codex',
      memberConfigs: [{ name: '重复', host: 'dsh' }],
    }),
    /重复/,
  );
  await assert.rejects(
    () => bus.panelTool(privateSession.id, privateSession.key, 'team_create', {
      name: '坏模型团队',
      workspace: directory,
      memberConfigs: [{ name: '坏模型', host: 'dsh', model: 'nope' }],
    }),
    /不在该成员宿主目录/,
  );

  // Panel group_add 直连添加，同样按成员字段落库。
  const coordination = bus.store.panelSession(agent.id, 'coordination', group.id);
  const added = await bus.panelTool(coordination.id, coordination.key, 'group_add', {
    groupId: group.id,
    name: '新人',
    host: 'dsh',
    model: 'reviewer',
    reasoning_effort: 'low',
    policyCeiling: 'read-only',
    allowShell: false,
    allowBrowser: true,
  }, { activeTeamId: group.id });
  await until(() => bus.running.size === 0);
  assert.equal(added.name, '新人');
  assert.equal(added.policy_ceiling, 'read-only');
  assert.equal(added.allow_shell, 0);
  assert.equal(added.allow_browser, 1);
});

test('read-only host with readOnlyKeepsShell retains exec.shell and receives allowShell=true at dispatch', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'readonly-shell-'));
  const seenPolicies = [];
  const codexLikeHost = {
    async listModels() {
      return { version: 1, host: 'codex', source: 'test', defaultModel: CODER.key, reasoningEfforts: [], models: [CODER] };
    },
    executionCapabilities({ mode, allowShell, allowBrowser }) {
      if (mode === 'communication') return { effectivePolicy: 'communication', capabilities: [], toolBrowser: false };
      if (!allowShell) return { effectivePolicy: 'communication', capabilities: [], reason: 'no shell', toolBrowser: false };
      return {
        effectivePolicy: mode === 'read-only' ? 'read-only' : 'workspace-write',
        capabilities: mode === 'read-only' ? ['exec.read', 'exec.shell'] : ['exec.read', 'exec.write', 'exec.shell'],
        reason: mode === 'read-only' ? '群策略只允许读取，shell 运行在只读沙箱' : null,
        toolBrowser: allowBrowser === true,
        browserReason: allowBrowser === true ? null : 'allowBrowser=false',
      };
    },
    supportsPolicy({ policy }) {
      return policy.mode === 'communication' || policy.allowShell
        ? { supported: true }
        : { supported: false, reason: '需要沙箱命令' };
    },
    async run(context) {
      context.onSession(context.endpoint.session ?? context.endpoint.id);
      if (context.endpoint.context === 'profile') {
        await context.onTool('profile_set', { text: 'ready' });
        context.onAccepted();
        return '';
      }
      seenPolicies.push(context.policy);
      context.onAccepted();
      return '';
    },
  };
  const bus = new Bus({ directory, hosts: new Map([['codex', codexLikeHost]]) });
  t.after(async () => {
    if (!bus.closing) await bus.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* ignore */ }
  });
  await bus.modelCatalog();
  const group = bus.createGroup({
    name: '只读沙箱命令团',
    workspace: directory,
    policy: 'workspace-write',
    allowShell: true,
    lead: { name: 'lead', host: 'codex' },
    members: [{ name: '视觉验收', host: 'codex', policyCeiling: 'read-only', allowBrowser: true }],
  });
  await until(() => bus.running.size === 0);

  const lead = memberNamed(bus, group, 'lead');
  const reviewer = memberNamed(bus, group, '视觉验收');
  const card = bus.snapshot(group.id).members.find(m => m.id === reviewer.id).capabilityCard;
  assert.equal(card.effectiveCapabilities['exec.shell'], true);
  assert.equal(card.effectiveCapabilities['tool.browser'], true);

  const leadEp = bus.store.endpoint(lead.id, 'coordination');
  await bus.tool(leadEp.id, leadEp.key, 'send', {
    to: reviewer.id,
    text: '只读并检查界面',
    requiredCapabilities: ['exec.read', 'tool.browser'],
  });
  await until(() => seenPolicies.length > 0 && bus.running.size === 0);
  assert.equal(seenPolicies[0].mode, 'read-only');
  assert.equal(seenPolicies[0].allowShell, true);
  assert.equal(seenPolicies[0].allowBrowser, true);
});

function runGit(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

test('workflowTemplate and member worktree isolation work end-to-end across HTTP and lifecycle', async t => {
  const root = mkdtempSync(join(tmpdir(), 'spec3-wt-e2e-'));
  const repo = join(root, 'repo');
  const nonGit = join(root, 'non-git');
  const dataDir = join(root, 'data');
  mkdirSync(repo, { recursive: true });
  mkdirSync(nonGit, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  runGit(repo, ['init']);
  runGit(repo, ['config', 'user.email', 'test@example.com']);
  runGit(repo, ['config', 'user.name', 'Test User']);
  writeFileSync(join(repo, 'README.md'), '# Repo Root\n');
  runGit(repo, ['add', 'README.md']);
  runGit(repo, ['commit', '-m', 'init']);

  const seenWorkspaces = new Map();
  const stubHost = {
    async listModels() {
      return { version: 1, host: 'codex', source: 'test', defaultModel: CODER.key, reasoningEfforts: [], models: [CODER] };
    },
    executionCapabilities({ mode, allowShell }) {
      if (mode === 'communication') return { effectivePolicy: 'communication', capabilities: [] };
      return {
        effectivePolicy: mode === 'read-only' ? 'read-only' : 'workspace-write',
        capabilities: mode === 'read-only' ? ['exec.read', 'exec.shell'] : ['exec.read', 'exec.write', ...(allowShell ? ['exec.shell'] : [])],
      };
    },
    async run(context) {
      context.onSession(context.endpoint.session ?? context.endpoint.id);
      if (context.endpoint.context === 'profile') {
        await context.onTool('profile_set', { text: 'ready' });
        context.onAccepted();
        return '';
      }
      const memberId = context.endpoint.member_id;
      seenWorkspaces.set(memberId, context.workspace);
      writeFileSync(join(context.workspace, `${memberId}.txt`), `written by ${memberId}\n`);
      context.onAccepted();
      return '';
    },
  };

  const server = await startServer({ directory: dataDir, hosts: new Map([['codex', stubHost]]) });
  const { bus, url: rawUrl } = server;
  const url = rawUrl.replace(/\/$/, '');
  t.after(async () => {
    await server.close();
    try { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* ignore */ }
  });

  // 强前置校验：非 Git、lead、仅沟通均同步拒绝，绝不静默回退共享主目录。
  assert.throws(() => bus.createGroup({
    name: '非仓库', workspace: nonGit, lead: { name: 'lead', host: 'codex' },
    members: [{ name: 'A', host: 'codex', workspaceMode: 'worktree' }],
  }), /Git 仓库根目录/);
  assert.throws(() => bus.createGroup({
    name: '主控禁wt', workspace: repo, lead: { name: 'lead', host: 'codex', workspaceMode: 'worktree' },
  }), /不支持 worktree 隔离/);
  assert.throws(() => bus.createGroup({
    name: '仅沟通禁wt', workspace: repo, policy: 'workspace-write', lead: { name: 'lead', host: 'codex' },
    members: [{ name: 'A', host: 'codex', policyCeiling: 'communication', workspaceMode: 'worktree' }],
  }), /不需要 worktree 隔离/);

  // 建群：standard-dev 模板 + 两个并发写作者各得独立 worktree。
  const templates = await fetch(`${url}/api/workflow-templates`).then(r => r.json());
  assert.equal(templates[0].id, 'standard-dev');

  const createRes = await fetch(`${url}/api/groups`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      operationId: 'spec3-create-1',
      name: '并行研发团',
      workspace: repo,
      workflowTemplate: 'standard-dev',
      policy: 'workspace-write',
      allowShell: true,
      lead: { name: 'lead', host: 'codex' },
      members: [
        { name: 'coderA', host: 'codex', workspaceMode: 'worktree' },
        { name: 'coderB', host: 'codex', workspaceMode: 'worktree' },
        { name: 'reviewer', host: 'codex', policyCeiling: 'read-only', workspaceMode: 'inherit' },
      ],
    }),
  });
  assert.equal(createRes.status, 200);
  const group = await createRes.json();
  assert.equal(group.workflow_template, 'standard-dev');
  await until(() => bus.running.size === 0);

  const lead = memberNamed(bus, group, 'lead');
  const coderA = memberNamed(bus, group, 'coderA');
  const coderB = memberNamed(bus, group, 'coderB');
  const reviewer = memberNamed(bus, group, 'reviewer');
  assert.equal(coderA.workspace_mode, 'worktree');
  assert.equal(coderB.workspace_mode, 'worktree');
  assert.equal(reviewer.workspace_mode, 'inherit');
  assert.notEqual(coderA.worktree_path, coderB.worktree_path);

  // 派工执行：两位并发写作者的 context.workspace 各自指向独立 worktree，主仓库无未跟踪污染。
  const leadEp = bus.store.endpoint(lead.id, 'coordination');
  await bus.tool(leadEp.id, leadEp.key, 'send', { to: coderA.id, text: '写文件 A' });
  await bus.tool(leadEp.id, leadEp.key, 'send', { to: coderB.id, text: '写文件 B' });
  await until(() => seenWorkspaces.size === 2 && bus.running.size === 0);
  assert.equal(seenWorkspaces.get(coderA.id), coderA.worktree_path);
  assert.equal(seenWorkspaces.get(coderB.id), coderB.worktree_path);
  assert.equal(existsSync(join(repo, `${coderA.id}.txt`)), false);
  assert.equal(existsSync(join(repo, `${coderB.id}.txt`)), false);

  // worktree 状态与受限文件预览路由。
  const wtStatuses = await fetch(`${url}/api/teams/${group.id}/worktrees`).then(r => r.json());
  assert.equal(wtStatuses.length, 2);
  assert.equal(wtStatuses.find(w => w.memberId === coderA.id).untrackedCount, 1);

  const previewOk = await fetch(`${url}/api/teams/${group.id}/file-preview?path=README.md`);
  assert.equal(previewOk.status, 200);
  assert.match((await previewOk.json()).content, /Repo Root/);
  const previewEscape = await fetch(`${url}/api/teams/${group.id}/file-preview?path=../non-git/no.md`);
  assert.equal(previewEscape.status, 403);

  // coderA 还有未提交改动时：普通清理返回 409 保守保留；提交后安全合入主工作区。
  const removeConflict = await fetch(`${url}/api/teams/${group.id}/members/${coderA.id}/worktree/remove`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(removeConflict.status, 409);

  runGit(coderA.worktree_path, ['add', `${coderA.id}.txt`]);
  runGit(coderA.worktree_path, ['commit', '-m', 'coderA work']);
  const mergeRes = await fetch(`${url}/api/teams/${group.id}/members/${coderA.id}/worktree/merge`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(mergeRes.status, 200);
  assert.equal((await mergeRes.json()).merged, true);
  assert.equal(readFileSync(join(repo, `${coderA.id}.txt`), 'utf8').replace(/\r\n/g, '\n'), `written by ${coderA.id}\n`);

  // coderA 已合入且干净：自动安全清理切回 inherit；coderB 含未提交文件：removeMember 保守保留目录。
  const removeClean = await fetch(`${url}/api/teams/${group.id}/members/${coderA.id}/worktree/remove`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(removeClean.status, 200);
  assert.equal(memberNamed(bus, group, 'coderA').workspace_mode, 'inherit');

  const removedB = await bus.removeMember(group.id, coderB.id);
  assert.ok(removedB.retainedWorktree?.retained);
  assert.equal(existsSync(coderB.worktree_path), true);

  // 通过 addMember 再加一名 worktree 成员：模拟磁盘 worktree 缺失时回合必须拦截且不回退主工作区；
  // 修复或重建另一名干净 worktree 后删群，干净成员自动清理，脏/未合入成员保守保留。
  const addedC = await bus.addMember(group.id, { name: 'coderC', host: 'codex', workspaceMode: 'worktree' });
  await until(() => bus.running.size === 0);
  const pathC = realpathSync(addedC.worktree_path);
  rmSync(pathC, { recursive: true, force: true });
  await bus.tool(leadEp.id, leadEp.key, 'send', { to: addedC.id, text: 'worktree 已删除应阻断执行' });
  await until(() => bus.running.size === 0);
  assert.equal(existsSync(join(repo, `${addedC.id}.txt`)), false, 'worktree 缺失时绝不得回退在主工作区写入');

  const addedD = await bus.addMember(group.id, { name: 'coderD', host: 'codex', workspaceMode: 'worktree' });
  await until(() => bus.running.size === 0);
  const pathD = realpathSync(addedD.worktree_path);

  const archived = await bus.archiveGroup(group.id);
  assert.equal(archived.state, 'archived');
  const deleted = await bus.deleteGroup(group.id, { archivedOnly: true });
  assert.equal(deleted.deleted, group.id);
  assert.equal(existsSync(pathD), false);
  assert.equal(existsSync(coderB.worktree_path), true);
  assert.equal(deleted.retainedWorktrees?.some(item => item.memberId === coderB.id), true);
});
