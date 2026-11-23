import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../server.mjs';
import { createTestGroup } from '../support/fixture.mjs';
import { until } from '../support/wait.mjs';
import { validatePanelTool } from '../../tools/panel.mjs';

// 运行期成员权限变更契约：
// - POST /api/teams/:groupId/members/:memberId/policy 走同一服务端写入入口，
//   越级/运行中/归档同步拒绝，成功后成员行、能力名片与旧宿主会话一起更新；
// - 成员工具 member_policy 与 Panel group_member_policy 只创建确认卡，用户同意后才生效；
// - 权限变化后派工门禁立即按新能力重算（exec.write / tool.browser），仅换模型不清会话。

const CODER = {
  key: 'coder', id: 'coder', label: 'Coder', provider: 'prov-a',
  inputModalities: ['text'], contextWindow: 128000,
  reasoningEfforts: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }],
  defaultReasoningEffort: 'low', isDefault: true,
};

function makeHost() {
  return {
    async listModels() {
      return { version: 1, host: 'codex', source: 'test', defaultModel: 'coder', reasoningEfforts: [], models: [CODER] };
    },
    // 真实 Codex 适配器为同步执行能力报告：授权且有原生浏览器工具时 toolBrowser 才为 true。
    executionCapabilities({ mode, allowShell, allowBrowser }) {
      if (mode === 'communication') return { effectivePolicy: 'communication', capabilities: [], reason: '仅允许团队通信', toolBrowser: false };
      if (mode === 'read-only') {
        return { effectivePolicy: 'read-only', capabilities: ['exec.read'], reason: '群策略只允许读取', toolBrowser: allowBrowser === true, browserReason: allowBrowser === true ? null : '成员未获浏览器/Computer Use 授权（allowBrowser=false）' };
      }
      return {
        effectivePolicy: 'workspace-write',
        capabilities: ['exec.read', 'exec.write', ...(allowShell ? ['exec.shell'] : [])],
        reason: null,
        toolBrowser: allowBrowser === true,
        browserReason: allowBrowser === true ? null : '成员未获浏览器/Computer Use 授权（allowBrowser=false）',
      };
    },
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

async function policyFixture(t, { policy = 'workspace-write', members = ['worker'] } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'member-policy-'));
  const server = await startServer({ directory, hosts: new Map([['codex', makeHost()]]) });
  t.after(async () => {
    await server.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论 */ }
  });
  const bus = server.bus;
  const group = createTestGroup(bus, {
    name: '策略团队',
    workspace: directory,
    policy,
    lead: { name: 'lead', host: 'codex' },
    members: members.map(name => ({ name, host: 'codex' })),
  });
  await until(() => bus.running.size === 0);
  const lead = bus.members(group.id).find(member => member.role === 'lead');
  const worker = bus.members(group.id).find(member => member.role === 'member');
  return { server, bus, url: server.url, directory, group, lead, worker };
}

function bindSession(bus, conversation, session) {
  bus.store.run('UPDATE conversations SET session=? WHERE id=?', session, conversation.id);
  bus.store.run(
    'INSERT INTO conversation_session_meta(conversation_id,session_key,session) VALUES(?,?,?)',
    conversation.id, 'manual-key', session,
  );
}

function postPolicy(url, groupId, memberId, body, init = {}) {
  return fetch(new URL(`/api/teams/${groupId}/members/${memberId}/policy`, url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...init,
  });
}

test('policy HTTP route applies the policy, clears old sessions and rejects invalid changes', async t => {
  const f = await policyFixture(t);
  const conversation = f.bus.store.endpoint(f.worker.id, 'coordination');
  bindSession(f.bus, conversation, 'manual-session-1');

  const response = await postPolicy(f.url, f.group.id, f.worker.id, {
    policyCeiling: 'read-only',
    allowShell: false,
    allowBrowser: false,
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.member.policy_ceiling, 'read-only');
  assert.equal(body.member.allow_shell, 0);
  assert.equal(body.member.allow_browser, 0);
  assert.equal(body.member.capabilityCard.effectivePolicy.ceiling, 'read-only');
  assert.equal(body.member.capabilityCard.effectiveCapabilities['exec.write'], false);

  // 旧宿主会话绑定被清理；随后若被通知唤醒也会以新会话启动，不会沿用旧值。
  const cleared = f.bus.store.get('SELECT session FROM conversations WHERE id=?', conversation.id);
  assert.notEqual(cleared.session, 'manual-session-1');
  const metaRows = f.bus.store.all('SELECT * FROM conversation_session_meta WHERE conversation_id=? AND session=?', conversation.id, 'manual-session-1');
  assert.equal(metaRows.length, 0);
  const notices = f.bus.store.all("SELECT text FROM messages WHERE group_id=? AND recipient=? AND sender='system'", f.group.id, f.worker.id);
  assert.ok(notices.some(row => /执行能力已更新为 read-only/.test(row.text)));

  // 仅换模型不清会话（既有 member_model 差异保持）。
  const pairConversation = f.bus.store.endpoint(f.worker.id, `pair:${f.lead.id}`, f.lead.id);
  bindSession(f.bus, pairConversation, 'manual-session-keep');
  f.bus.applyMemberModel(f.group.id, f.worker.id, { model_provider: 'prov-a', model: 'coder', reasoning_effort: 'low' });
  const keptConversation = f.bus.store.get('SELECT session FROM conversations WHERE id=?', pairConversation.id);
  const keptMeta = f.bus.store.all('SELECT * FROM conversation_session_meta WHERE conversation_id=?', pairConversation.id);
  assert.equal(keptConversation.session, 'manual-session-keep');
  assert.equal(keptMeta.length, 1);

  // Content-Type 与未知字段校验。
  const noJson = await fetch(new URL(`/api/teams/${f.group.id}/members/${f.worker.id}/policy`, f.url), {
    method: 'POST', body: JSON.stringify({ allowBrowser: true }),
  });
  assert.equal(noJson.status, 415);
  const unknown = await postPolicy(f.url, f.group.id, f.worker.id, { foo: true });
  assert.equal(unknown.status, 400);

  // 越级：read-only 群不能用 workspace-write 上限。
  const readOnlyGroup = createTestGroup(f.bus, {
    name: '只读策略团队',
    workspace: f.directory,
    policy: 'read-only',
    lead: { name: 'read-only-lead', host: 'codex' },
    members: [{ name: '只读成员', host: 'codex' }],
  });
  await until(() => f.bus.running.size === 0);
  const readOnlyMember = f.bus.members(readOnlyGroup.id).find(member => member.role === 'member');
  const above = await postPolicy(f.url, readOnlyGroup.id, readOnlyMember.id, { policyCeiling: 'workspace-write' });
  assert.equal(above.status, 400);
  const aboveBody = await above.json();
  assert.match(aboveBody.error, /不能超过群策略/);

  // 运行中拒绝：不撕裂同一宿主会话。
  const runningEndpoint = f.bus.store.endpoint(f.worker.id, 'coordination');
  f.bus.running.set(runningEndpoint.id, { endpoint: runningEndpoint, abort: new AbortController(), done: Promise.resolve() });
  try {
    const busy = await postPolicy(f.url, f.group.id, f.worker.id, { allowBrowser: true });
    assert.equal(busy.status, 400);
    assert.match((await busy.json()).error, /运行中/);
  } finally {
    f.bus.running.delete(runningEndpoint.id);
  }

  // 归档团队禁止改写成员权限（server 统一 410）。
  const archived = createTestGroup(f.bus, {
    name: '归档策略团队',
    workspace: f.directory,
    lead: { name: 'archive-lead', host: 'codex' },
    members: [{ name: '归档成员', host: 'codex' }],
  });
  await until(() => f.bus.running.size === 0);
  const archivedMember = f.bus.members(archived.id).find(member => member.role === 'member');
  await f.bus.archiveGroup(archived.id);
  const archivedResponse = await postPolicy(f.url, archived.id, archivedMember.id, { allowBrowser: true });
  assert.equal(archivedResponse.status, 410);
});

test('member_policy cards approve asynchronously and fail safely after the team is archived', async t => {
  const f = await policyFixture(t);
  const leadEndpoint = f.bus.store.endpoint(f.lead.id, 'coordination');
  const conversation = f.bus.store.endpoint(f.worker.id, 'coordination');
  bindSession(f.bus, conversation, 'manual-session-card');

  const card = await f.bus.tool(leadEndpoint.id, leadEndpoint.key, 'member_policy', {
    member: f.worker.id,
    policy_ceiling: 'read-only',
    allow_browser: true,
  });
  assert.equal(card.kind, 'member_policy');
  assert.equal(card.state, 'pending');
  // 卡片 payload 使用前端依赖的 camelCase 形状；未指定字段不出现（保留现值）。
  assert.equal(card.payload.args.member, f.worker.id);
  assert.equal(card.payload.args.policyCeiling, 'read-only');
  assert.equal(card.payload.args.allowBrowser, true);
  assert.equal(Object.hasOwn(card.payload.args, 'allowShell'), false);

  const decided = f.bus.decideInteraction(card.id, { approved: true });
  assert.ok(decided instanceof Promise);
  const result = await decided;
  assert.equal(result.state, 'answered');
  const updated = f.bus.store.member(f.worker.id);
  assert.equal(updated.policy_ceiling, 'read-only');
  assert.equal(updated.allow_browser, 1);
  assert.equal(updated.allow_shell, null);
  const clearedConversation = f.bus.store.get('SELECT session FROM conversations WHERE id=?', conversation.id);
  assert.equal(clearedConversation.session, null);
  const notices = f.bus.store.all("SELECT text FROM messages WHERE group_id=? AND recipient=? AND sender='system'", f.group.id, f.worker.id);
  assert.ok(notices.some(row => /执行能力已更新为 read-only/.test(row.text)));

  // 同意后执行失败：卡片落 failed 且结果回到发起者，不能提前宣布已生效。
  const second = await f.bus.tool(leadEndpoint.id, leadEndpoint.key, 'member_policy', {
    member: f.worker.id,
    allow_shell: true,
  });
  assert.equal(second.state, 'pending');
  await f.bus.archiveGroup(f.group.id);
  await assert.rejects(() => f.bus.decideInteraction(second.id, { approved: true }), /已归档/);
  const failedRow = f.bus.store.interaction(second.id);
  assert.equal(failedRow.state, 'failed');
  assert.match(failedRow.detail, /已归档/);
  const failureMessages = f.bus.store.all("SELECT text FROM messages WHERE group_id=? AND text LIKE '%执行失败%'", f.group.id);
  assert.ok(failureMessages.length > 0);
  const successForFailedCard = f.bus.store.all("SELECT text FROM messages WHERE group_id=? AND text LIKE '%命令 允许:用户已同意,已生效%'", f.group.id);
  assert.equal(successForFailedCard.length, 0);
});

test('Panel group_member_policy creates a member_policy card and approval applies it', async t => {
  const f = await policyFixture(t);
  await f.bus.createPanelAgent({ name: 'Panel', host: 'codex', model: 'coder', reasoning_effort: 'low' });
  const agent = f.bus.panelAgent();
  const privateSession = f.bus.store.panelSession(agent.id, 'private');
  const takeover = await f.bus.panelTool(privateSession.id, privateSession.key, 'request_team_takeover', { groupId: f.group.id }, { activeTeamId: f.group.id });
  f.bus.decideInteraction(takeover.id, { approved: true });
  await until(() => f.bus.running.size === 0);

  // 工具只在协调上下文可用；私人上下文不能直接改团队权限。
  assert.throws(
    () => validatePanelTool('private', 'group_member_policy', { groupId: f.group.id, member: f.worker.id }),
    /不能使用/,
  );
  assert.doesNotThrow(
    () => validatePanelTool('coordination', 'group_member_policy', { groupId: f.group.id, member: f.worker.id }),
  );

  const coordination = f.bus.store.panelSession(agent.id, 'coordination', f.group.id);
  const card = await f.bus.panelTool(coordination.id, coordination.key, 'group_member_policy', {
    groupId: f.group.id,
    member: f.worker.id,
    policyCeiling: 'read-only',
    allowShell: false,
  }, { activeTeamId: f.group.id });
  assert.equal(card.kind, 'member_policy');
  assert.equal(card.state, 'pending');
  assert.equal(card.payload.args.member, f.worker.id);
  assert.equal(card.payload.args.policyCeiling, 'read-only');
  assert.equal(card.payload.args.allowShell, false);

  await f.bus.decideInteraction(card.id, { approved: true });
  const updated = f.bus.store.member(f.worker.id);
  assert.equal(updated.policy_ceiling, 'read-only');
  assert.equal(updated.allow_shell, 0);
});

test('runtime policy changes immediately regate dispatch (exec.write and tool.browser)', async t => {
  const f = await policyFixture(t);
  await f.bus.modelCatalog();
  const leadEndpoint = f.bus.store.endpoint(f.lead.id, 'coordination');

  let browserError;
  await assert.rejects(
    async () => {
      try {
        await f.bus.tool(leadEndpoint.id, leadEndpoint.key, 'send', {
          to: f.worker.id,
          text: '打开浏览器核对页面。',
          requiredCapabilities: ['tool.browser'],
        });
      } catch (error) {
        browserError = error;
        throw error;
      }
    },
    /capability_required/,
  );
  assert.equal(browserError.code, 'capability_required');
  assert.deepEqual(browserError.details.missingCapabilities, ['tool.browser']);

  // 授权浏览器放行后，能力名片与派工门禁同步点亮。
  await f.bus.applyMemberPolicy(f.group.id, f.worker.id, { allowBrowser: true });
  const directory = await (await fetch(new URL('/api/directory', f.url))).json();
  const projected = directory.members.find(row => row.id === f.worker.id);
  assert.equal(projected.capabilityCard.effectiveCapabilities['tool.browser'], true);
  const allowed = await f.bus.tool(leadEndpoint.id, leadEndpoint.key, 'send', {
    to: f.worker.id,
    text: '打开浏览器核对页面。',
    requiredCapabilities: ['tool.browser'],
  });
  assert.ok(allowed.messageId);
  await until(() => f.bus.running.size === 0);

  // 降为只读后，之前允许的 exec.write 派工立即被拦；快照名片同步收窄。
  await f.bus.applyMemberPolicy(f.group.id, f.worker.id, { policyCeiling: 'read-only' });
  let writeError;
  await assert.rejects(
    async () => {
      try {
        await f.bus.tool(leadEndpoint.id, leadEndpoint.key, 'send', {
          to: f.worker.id,
          text: '请修改项目文件。',
          requiredCapabilities: ['exec.write'],
        });
      } catch (error) {
        writeError = error;
        throw error;
      }
    },
    /capability_required/,
  );
  assert.deepEqual(writeError.details.missingCapabilities, ['exec.write']);
  const snapshot = await (await fetch(new URL(`/api/snapshot?scoped=1&group=${f.group.id}`, f.url))).json();
  const snapshotMember = snapshot.members.find(row => row.id === f.worker.id);
  assert.equal(snapshotMember.capabilityCard.effectivePolicy.ceiling, 'read-only');
  assert.equal(snapshotMember.capabilityCard.effectiveCapabilities['exec.write'], false);
});
