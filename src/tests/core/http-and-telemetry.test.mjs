import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, chmodSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../server.mjs';
import { Bus } from '../../bus.mjs';
import { createCodexHost } from '../../member/codex/index.mjs';
import { toolsFor } from '../../tools/registry.mjs';
import { panelToolsFor } from '../../tools/panel.mjs';
import { byteSize, CONTEXT_SCHEMA_VERSION, projectTurnInput } from '../../information.mjs';
import { busScenario, createTestGroup, fakeHost, seedPanelAgent, serverScenario } from '../support/fixture.mjs';
import * as conversationsAgg from '../../aggregates/conversations.mjs';
import * as turnsAgg from '../../aggregates/turns.mjs';
import { telemetryCapabilitiesFor, telemetryObservation } from '../../telemetry.mjs';
import { createDshHost } from '../../hosts/cli-hosts.mjs';
import { dshSessionEventFrame, observeTextStream } from '../../member/dsh/telemetry-observer.mjs';
import { insertPrincipal } from '../../aggregates/external-control.mjs';
import { defaultPanelWorkspace, ensureDefaultPanelWorkspace } from '../../default-workspace.mjs';

describe('http-routes', () => {
test('HTTP routes enforce methods, preserve errors and keep SSE open', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-routes-'));
  let server;
  try {
    server = await startServer({ directory, hosts: new Map() });
    const request = (path, init) => fetch(new URL(path, server.url), init);
    for (const [path, method, status] of [
      ['/api/missing', 'GET', 404], ['/api/missing', 'POST', 403],
      ['/api/groups', 'POST', 415], ['/api/panel-agent', 'DELETE', 403],
      ['/api/panel-agent/update', 'GET', 404], ['/api/panel-agent/events', 'POST', 403],
    ]) {
      const response = await request(path, { method });
      assert.equal(response.status, status, `${method} ${path}`);
      await response.text();
    }
    const unsupportedBody = await request('/api/panel-agent', { method: 'POST', body: '{}' });
    assert.equal(unsupportedBody.status, 415);
    await unsupportedBody.text();
    const telemetry = await request('/api/telemetry/missing?group=missing');
    assert.equal(telemetry.status, 404);
    assert.deepEqual(await telemetry.json(), { error: 'Not found' });
    const controller = new AbortController();
    const stream = await request('/api/panel-agent/events', { signal: controller.signal });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get('content-type'), /text\/event-stream/);
    const reader = stream.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /: connected/);
    controller.abort();
    await reader.cancel().catch(() => {});
  } finally {
    await server?.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  }
});

test('POST /api/teams/:groupId/stop stops running turns by member or whole team and overview reports runningByGroup', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-stop-route-'));
  let server;
  const started = new Map();
  let releaseAll;
  const hold = new Promise(resolve => { releaseAll = resolve; });
  const fakeHost = () => ({
    async run(ctx) {
      started.set(ctx.endpoint.member_id, ctx.signal);
      ctx.onAccepted?.();
      await new Promise((resolve, reject) => {
        if (ctx.signal.aborted) { reject(new Error('aborted')); return; }
        ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        hold.then(resolve);
      });
      return { text: 'done' };
    },
  });
  try {
    server = await startServer({
      directory,
      hosts: new Map([['codex', fakeHost()]]),
    });
    const post = (path, body) => fetch(new URL(path, server.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const createdRes = await post('/api/groups', {
      operationId: 'op-stop-test',
      name: '停止测试团队',
      workspace: directory,
      lead: { name: '主控', host: 'codex' },
      members: [{ name: '成员A', host: 'codex' }],
    });
    assert.equal(createdRes.status, 200);
    const group = await createdRes.json();
    const overviewBefore = await (await fetch(new URL('/api/overview', server.url))).json();
    const teamMembers = overviewBefore.members.filter(item => item.group_id === group.id);
    const lead = teamMembers.find(item => item.role === 'lead');
    const worker = teamMembers.find(item => item.role !== 'lead');

    // 等待主控与成员双双进入运行态
    const deadline = Date.now() + 5000;
    while (started.size < 2 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(started.size, 2);

    // 非法参数与不存在成员校验
    const badKey = await post(`/api/teams/${encodeURIComponent(group.id)}/stop`, { extra: true });
    assert.equal(badKey.status, 400);
    const badMemberId = await post(`/api/teams/${encodeURIComponent(group.id)}/stop`, { memberId: '  ' });
    assert.equal(badMemberId.status, 400);
    const missingMember = await post(`/api/teams/${encodeURIComponent(group.id)}/stop`, { memberId: 'no-such-member' });
    assert.equal(missingMember.status, 404);

    // overview.runningByGroup 准确反映当前 2 路运行
    const overviewRunning = await (await fetch(new URL('/api/overview', server.url))).json();
    assert.equal(overviewRunning.runningByGroup[group.id], 2);

    // 先仅停止 worker
    const stopOne = await post(`/api/teams/${encodeURIComponent(group.id)}/stop`, { memberId: worker.id });
    assert.equal(stopOne.status, 200);
    assert.deepEqual(await stopOne.json(), { groupId: group.id, memberId: worker.id, stopped: 1 });
    assert.equal(started.get(worker.id).aborted, true);
    assert.equal(started.get(lead.id).aborted, false);

    // 再停止整队剩余运行回合
    const stopAll = await post(`/api/teams/${encodeURIComponent(group.id)}/stop`, {});
    assert.equal(stopAll.status, 200);
    assert.deepEqual(await stopAll.json(), { groupId: group.id, memberId: null, stopped: 1 });
    assert.equal(started.get(lead.id).aborted, true);

    // 空运行时幂等返回 stopped: 0
    const idleRes = await post(`/api/teams/${encodeURIComponent(group.id)}/stop`, {});
    assert.equal(idleRes.status, 200);
    assert.deepEqual(await idleRes.json(), { groupId: group.id, memberId: null, stopped: 0 });

    const overviewAfter = await (await fetch(new URL('/api/overview', server.url))).json();
    assert.equal(overviewAfter.runningByGroup[group.id] ?? 0, 0);

    // 归档后停止请求应被 410 拦截
    const archiveRes = await post(`/api/teams/${encodeURIComponent(group.id)}/archive`, {});
    assert.equal(archiveRes.status, 200);
    const archivedStop = await post(`/api/teams/${encodeURIComponent(group.id)}/stop`, {});
    assert.equal(archivedStop.status, 410);
  } finally {
    releaseAll?.();
    await server?.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论 */ }
  }
});
});

describe('information', () => {
const _tick = () => new Promise(resolve => setImmediate(resolve));
async function until(fn, message = 'condition timed out') {
  for (let index = 0; index < 600; index += 1) {
    if (fn()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

function fixture(t, run) {
  return busScenario(t, {
    run,
    name: 'information fixture',
    members: ['one'],
    charter: '测试团队说明：只做消息层面的协调。',
    profileText: null,
    profileOutput: 'profile',
    finalText: 'done',
    emitHostEvent: false,
  });
}

test('turn input projection carries the charter, full messages and reports budget exhaustion explicitly', () => {
  const long = '日志🧪\n'.repeat(80) + 'MIDDLE' + '尾部';
  const view = projectTurnInput({
    group: { id: 'group-1', name: 'group' },
    charter: '团队说明文本',
    policy: { mode: 'read-only', allowShell: false },
    schema: CONTEXT_SCHEMA_VERSION,
    input: {
      message: { id: 'm1', seq: 11, sender: 'a', recipient: 'b', kind: 'send', text: long, created: 'now' },
      additionalMessages: [],
      notes: [{ id: 'n1', seq: 12, sender: 'c', recipient: 'b', kind: 'note', text: 'note body', created: 'now' }],
    },
  });
  assert.equal(view.contextSchemaVersion, CONTEXT_SCHEMA_VERSION);
  assert.equal(view.group.id, 'group-1');
  assert.equal(view.charter, '团队说明文本');
  assert.equal(view.policy.mode, 'read-only');
  assert.equal(view.input.message.text, long);
  assert.equal(view.input.message.complete, true);
  assert.equal(view.input.notes[0].text, 'note body');
  assert.match(view.input.message.ref.hash, /^[0-9a-f]{64}$/);
  assert.equal(byteSize(view) > 0, true);

  assert.throws(() => projectTurnInput({
    group: { id: 'group-1', name: 'group' },
    policy: { mode: 'read-only' },
    input: { message: { id: 'm', seq: 1, sender: 'a', recipient: 'b', kind: 'send', text: 'x'.repeat(600000) } },
  }), /超过.*预算/);

  // 仅供主控协调回合的精简团队能力视图：按原样进入回合输入并计入同一预算。
  const plain = projectTurnInput({
    group: { id: 'group-1', name: 'group' },
    policy: { mode: 'workspace-write', allowShell: false },
    schema: CONTEXT_SCHEMA_VERSION,
    input: { message: { id: 'm1', seq: 1, sender: 'a', recipient: 'b', kind: 'send', text: '任务' } },
  });
  const teamCapabilities = {
    controller: {
      id: 'lead', name: 'lead', role: 'lead', kind: 'member', model: 'vision',
      modalImage: 'unknown', contextWindow: null,
      execRead: true, execWrite: false, execShell: false, toolBrowser: false,
    },
    members: [{
      id: 'worker', name: 'worker', role: 'member', model: 'vision',
      provider: 'fake-provider', knownInCatalog: true, modalImage: true, contextWindow: 64000,
      execRead: true, execWrite: false, execShell: false, toolBrowser: false,
    }],
  };
  const withTeam = projectTurnInput({
    group: { id: 'group-1', name: 'group' },
    policy: { mode: 'workspace-write', allowShell: false },
    schema: CONTEXT_SCHEMA_VERSION,
    input: { message: { id: 'm1', seq: 1, sender: 'a', recipient: 'b', kind: 'send', text: '任务' } },
    teamCapabilities,
  });
  assert.deepEqual(withTeam.teamCapabilities, teamCapabilities);
  assert.ok(byteSize(withTeam) > byteSize(plain));
  // 能力视图也受 turnInputBytes 约束,不能无限膨胀回合输入。
  assert.throws(() => projectTurnInput({
    group: { id: 'group-1', name: 'group' },
    policy: { mode: 'read-only' },
    schema: CONTEXT_SCHEMA_VERSION,
    input: { message: { id: 'm1', seq: 1, sender: 'a', recipient: 'b', kind: 'send', text: '任务' } },
    teamCapabilities: { payload: 'x'.repeat(600000) },
  }), /超过.*预算/);
});

test('new sessions use fixed rules with a compact dynamic view; legacy sessions keep their path and are never reset', async t => {
  const { bus, group, calls } = fixture(t);
  await until(() => bus.running.size === 0);
  const [lead, one] = bus.members(group.id);
  const leadEndpoint = bus.store.endpoint(lead.id, 'coordination');

  await bus.tool(leadEndpoint.id, leadEndpoint.key, 'send', { to: one.id, text: 'first projected task' });
  await until(() => calls.some(call => call.endpoint.context === 'pair:' + lead.id) && bus.running.size === 0);
  const first = calls.filter(call => call.endpoint.context === 'pair:' + lead.id).at(-1);
  const firstFacts = JSON.parse(first.prompt);
  assert.equal(firstFacts.contextSchemaVersion, CONTEXT_SCHEMA_VERSION);
  assert.equal(firstFacts.input.message.text, 'first projected task');
  assert.equal(firstFacts.charter, '测试团队说明：只做消息层面的协调。');
  assert.equal(firstFacts.policy.mode, 'workspace-write');
  assert.match(first.instructions, /固定规则与本轮动态事实分离/);
  assert.match(first.instructions, /send 只发给一个接收者/);
  assert.match(first.instructions, /框架只负责投递消息，不检查工作流程/);
  assert.doesNotMatch(first.instructions, /必须显式调用 send（to: 'user'）/);
  assert.doesNotMatch(first.instructions, /当前有效契约与执行状态：/);
  const memberEndpoint = bus.store.endpoint(one.id, 'coordination');
  await assert.rejects(
    bus.tool(memberEndpoint.id, memberEndpoint.key, 'send', { to: 'user', text: '非主 Agent 不得直发用户' }),
    /群内找不到成员: user/,
  );
  await bus.tool(memberEndpoint.id, memberEndpoint.key, 'send', { to: lead.id, text: 'member report wakes lead' });
  await until(() => calls.some(call => call.endpoint.member_id === lead.id && call.endpoint.context === 'coordination')
    && bus.running.size === 0);
  const leadCall = calls.filter(call => call.endpoint.member_id === lead.id
    && call.endpoint.context === 'coordination').at(-1);
  assert.match(leadCall.instructions, /必须显式调用 send（to: 'user'）/);
  // 新增的派工能力规则仍然受固定规则预算约束。
  assert.ok(byteSize(first.instructions) <= bus.information.budgets.rulesBytes);
  assert.ok(byteSize(leadCall.instructions) <= bus.information.budgets.rulesBytes);
  const format = bus.store.get(
    'SELECT * FROM conversation_session_meta WHERE conversation_id=?',
    first.endpoint.id,
  );
  assert.equal(format.schema_version, CONTEXT_SCHEMA_VERSION);
  assert.equal(format.format_source, 'new-session');

  // Another turn to the same session keeps identical fixed rules and only
  // changes the dynamic input.
  await bus.tool(leadEndpoint.id, leadEndpoint.key, 'send', { to: one.id, text: 'second projected task' });
  await until(() => calls.filter(call => call.endpoint.context === 'pair:' + lead.id).length >= 2 && bus.running.size === 0);
  const second = calls.filter(call => call.endpoint.context === 'pair:' + lead.id).at(-1);
  const secondFacts = JSON.parse(second.prompt);
  assert.equal(second.instructions, first.instructions, 'fixed rules must not change per turn');
  assert.equal(secondFacts.input.message.text, 'second projected task');

  // A pre-existing native session stays legacy, keeps its id, and sees the old raw shape.
  const legacyEndpoint = bus.store.endpoint(lead.id, 'private');
  bus.store.run('UPDATE conversations SET session=? WHERE id=?', 'legacy-native-session', legacyEndpoint.id);
  const legacy = bus.store.get('SELECT * FROM conversations WHERE id=?', legacyEndpoint.id);
  bus.store.append(group.id, lead.id, lead.id, 'note', 'legacy body');
  await bus.runEndpoint(legacy, 'legacy turn');
  const legacyFormat = bus.store.get(
    'SELECT * FROM conversation_session_meta WHERE conversation_id=?',
    legacy.id,
  );
  assert.equal(legacyFormat.schema_version, 0);
  assert.equal(legacyFormat.format_source, 'legacy-detected');
  const legacyCall = calls.filter(call => call.endpoint.id === legacy.id).at(-1);
  assert.match(legacyCall.prompt, /legacy turn/);
  assert.equal(conversationsAgg.byId(bus.store, legacy.id).session, 'legacy-native-session');
  const legacyRead = await bus.tool(legacy.id, legacy.key, 'read', {});
  assert.ok(legacyRead.messages.some(message => message.text === 'legacy body'));
  const newRead = await bus.tool(first.endpoint.id, first.endpoint.key, 'read', {});
  assert.equal(newRead.view, 'bounded');
  assert.ok(newRead.messages.every(message => !Object.hasOwn(message, 'text')));
});

test('message pagination reports the exact 200-row boundary with an explicit cursor', async t => {
  const { bus, group } = fixture(t);
  await until(() => bus.running.size === 0);
  const [lead] = bus.members(group.id);
  for (let index = 0; index < 201; index += 1) bus.store.append(group.id, 'system', lead.id, 'system', `notice-${index}`);
  const endpoint = bus.store.endpoint(lead.id, 'coordination');
  await bus.runEndpoint(endpoint, 'establish session');
  await until(() => bus.running.size === 0);
  const first = await bus.tool(endpoint.id, endpoint.key, 'read', { limit: 200 });
  assert.equal(first.messages.length, 200);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextAfter, first.messages.at(-1).seq);
  const second = await bus.tool(endpoint.id, endpoint.key, 'read', { after: first.nextAfter, limit: 200 });
  assert.equal(second.messages.length, 1);
  assert.equal(second.hasMore, false);
  // 追平后再读:空页、complete 为真、游标原样回显——这是"已读到最新"的判定依据
  const caughtUp = await bus.tool(endpoint.id, endpoint.key, 'read', { after: second.nextAfter, limit: 200 });
  assert.equal(caughtUp.messages.length, 0);
  assert.equal(caughtUp.complete, true);
  assert.equal(caughtUp.hasMore, false);
  assert.equal(caughtUp.nextAfter, second.nextAfter);
});

test('rules budget overrun fails explicitly before the host runs and is not silently clipped', async t => {
  const { bus, group, calls } = fixture(t);
  await until(() => bus.running.size === 0);
  const [lead, one] = bus.members(group.id);
  const endpoint = bus.store.endpoint(lead.id, 'coordination');
  const original = bus.information.budgets.rulesBytes;
  const before = calls.length;
  bus.information.budgets.rulesBytes = 100;
  try {
    await bus.tool(endpoint.id, endpoint.key, 'send', { to: one.id, text: 'rules budget trigger' });
    await until(() => bus.store.get('SELECT error FROM outbox WHERE error IS NOT NULL'), 'rules budget error missing');
    const failed = bus.store.get('SELECT error FROM outbox WHERE error IS NOT NULL');
    assert.match(failed.error, /固定规则超过 100 字节预算/);
    assert.match(failed.error, /不会被截断/);
    assert.equal(calls.length, before, 'host must not run with oversized rules');
    assert.equal(turnsAgg.list(bus.store, { conversationId: endpoint.id }).length, 0);
    bus.information.measureRules({
      groupId: group.id,
      endpointId: endpoint.id,
      turnId: 'rules-budget-diagnostic',
      schemaVersion: CONTEXT_SCHEMA_VERSION,
      instructions: 'x'.repeat(200),
      fixed: true,
    });
    const diagnostic = bus.store.get('SELECT bytes,detail FROM information_measurements WHERE turn_id=?', 'rules-budget-diagnostic');
    assert.equal(diagnostic.bytes, 200);
    assert.equal(JSON.parse(diagnostic.detail).overBudget, true);
    assert.equal(JSON.parse(diagnostic.detail).fixed, true);
  } finally {
    bus.information.budgets.rulesBytes = original;
  }
});

test('bounded message list, database body references and measurements work through the tool entry', async t => {
  let captured = null;
  const { bus, group, calls: _calls } = fixture(t, async context => {
    if (!context.endpoint.context.startsWith('pair:') || captured?.done) {
      context.onAccepted();
      return 'done';
    }
    const endpoint = context.endpoint;
    const first = await context.onTool('read', { limit: 2 });
    const second = await context.onTool('read', { after: first.nextAfter, limit: 2 });
    const trigger = second.messages.find(message => message.recipient === context.endpoint.member_id && message.sender !== context.endpoint.member_id);
    const restore = { text: '', pages: 0 };
    let offset = 0;
    for (;;) {
      const page = await context.onTool('read', {
        messageId: trigger.ref.id,
        hash: trigger.ref.hash,
        offset,
        bodyLimit: 7,
      });
      restore.text += page.text;
      restore.pages += 1;
      offset = page.next;
      if (!page.hasMore) break;
    }
    captured = {
      endpoint,
      turnId: context.turnId,
      prompt: JSON.parse(context.prompt),
      first,
      second,
      trigger,
      restore,
      done: true,
    };
    context.onAccepted();
    return 'done';
  });
  await until(() => bus.running.size === 0);
  const [lead, one] = bus.members(group.id);
  const leadEndpoint = bus.store.endpoint(lead.id, 'coordination');
  bus.store.append(group.id, lead.id, lead.id, 'note', 'first note');
  bus.store.append(group.id, lead.id, lead.id, 'note', 'second note');
  const secret = 'A🧪中\n'.repeat(300) + '尾部';
  await bus.tool(leadEndpoint.id, leadEndpoint.key, 'send', { to: one.id, text: secret });
  await until(() => captured?.restore, 'tool entry capture timed out');
  assert.equal(captured.prompt.contextSchemaVersion, CONTEXT_SCHEMA_VERSION);
  assert.equal(captured.first.view, 'bounded');
  assert.equal(captured.first.messages.length, 2);
  assert.equal(captured.first.hasMore, true);
  assert.ok(captured.first.messages.every(message => !Object.hasOwn(message, 'text')));
  assert.equal(captured.second.hasMore, false);
  assert.equal(captured.trigger.ref.length, Array.from(secret).length);
  assert.equal(captured.trigger.complete, false);
  assert.equal(captured.restore.text, secret);
  assert.equal(captured.restore.pages, Math.ceil(Array.from(secret).length / 7));
  assert.ok(captured.restore.text.includes('🧪'));

  const manifest = bus.informationManifest(captured.turnId);
  assert.ok(manifest.rulesBytes > 0);
  assert.ok(manifest.turnInputBytes > 0);
  assert.ok(manifest.toolResultBytes > 0);
  assert.ok(manifest.toolCalls >= 2);
  assert.equal(manifest.expandCount, captured.restore.pages);
  assert.deepEqual(manifest.schemaVersions, [CONTEXT_SCHEMA_VERSION]);
  assert.doesNotMatch(JSON.stringify(manifest.measurements), /A🧪中|尾部/);

  // Stale, deleted, cross-team, removed and invalid-range references are explicit errors.
  bus.store.run('UPDATE messages SET text=? WHERE id=?', 'changed evidence', captured.trigger.id);
  await assert.rejects(
    bus.tool(captured.endpoint.id, captured.endpoint.key, 'read', {
      messageId: captured.trigger.id,
      hash: captured.trigger.ref.hash,
    }),
    /stale/,
  );
  await assert.rejects(
    bus.tool(captured.endpoint.id, captured.endpoint.key, 'read', {
      messageId: captured.trigger.id,
      hash: captured.trigger.ref.hash,
      bodyLimit: 5000,
    }),
    /bodyLimit不能大于4096/,
  );
  const other = createTestGroup(bus, {
    name: 'other team',
    workspace: bus.store.directory,
    lead: { name: 'other lead', host: 'fake' },
  });
  await until(() => bus.running.size === 0);
  const foreign = bus.store.endpoint(other.lead, 'coordination');
  await assert.rejects(
    bus.tool(foreign.id, foreign.key, 'read', {
      messageId: captured.trigger.id,
      hash: captured.trigger.ref.hash,
    }),
    /不属于当前团队/,
  );
  bus.store.run('DELETE FROM messages WHERE id=?', captured.trigger.id);
  await assert.rejects(
    bus.tool(captured.endpoint.id, captured.endpoint.key, 'read', {
      messageId: captured.trigger.id,
      hash: captured.trigger.ref.hash,
    }),
    /不存在|删除/,
  );
  bus.store.run('UPDATE members SET removed=? WHERE id=?', 'now', one.id);
  await assert.rejects(
    bus.tool(captured.endpoint.id, captured.endpoint.key, 'read', {}),
    /成员不存在或已移除/,
  );
  await assert.rejects(
    bus.tool(captured.endpoint.id, 'wrong-key', 'read', {}),
    /来源无效/,
  );
});

test('Panel tool entry uses the same projection and keeps session credentials', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-info-panel-'));
  const calls = [];
  const captures = {};
  const host = {
    async listModels() {
      return {
        version: 1,
        host: 'fake',
        source: 'test',
        defaultModel: 'fake-model',
        reasoningEfforts: [{ id: 'low', label: 'low' }],
        models: [{
          id: 'fake-model',
          key: 'fake-model',
          label: 'Fake Model',
          provider: 'fake-provider',
          reasoningEfforts: [{ id: 'low', label: 'low' }],
          defaultReasoningEffort: 'low',
          isDefault: true,
        }],
      };
    },
    async run(context) {
      calls.push(context);
      context.onSession(context.endpoint.session ?? `native-${context.endpoint.id}`);
      if (context.endpoint.context === 'profile') {
        context.onAccepted();
        return 'profile';
      }
      if (context.endpoint.owner_kind === 'panel_agent' && context.endpoint.context === 'coordination' && !captures.done) {
        const read = await context.onTool('team_read', { groupId: captures.groupId, limit: 5 });
        const message = read.messages.find(row => row.id === captures.messageId);
        let restored = '';
        let offset = 0;
        for (;;) {
          const page = await context.onTool('team_read', {
            groupId: captures.groupId,
            messageId: message.ref.id,
            hash: message.ref.hash,
            offset,
            bodyLimit: 11,
          });
          restored += page.text;
          offset = page.next;
          if (!page.hasMore) break;
        }
        captures.read = read;
        captures.message = message;
        captures.restored = restored;
        captures.turnId = context.turnId;
        captures.done = true;
      }
      context.onAccepted();
      return 'panel reply';
    },
  };
  const bus = new Bus({ directory, hosts: new Map([['fake', host]]) });
  t.after(async () => {
    await bus.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  });
  const group = createTestGroup(bus, {
    name: 'panel projection',
    workspace: directory,
    lead: { name: 'lead', host: 'fake' },
    members: [{ name: 'one', host: 'fake' }],
  });
  await until(() => bus.running.size === 0);
  await bus.createPanelAgent({
    name: 'Panel Agent',
    host: 'fake',
    model_provider: 'fake-provider',
    model: 'fake-model',
    reasoning_effort: 'low',
  });
  const taken = bus.takeoverTeam(group.id, bus.controllerState(group.id).revision);
  assert.equal(taken.controller.kind, 'panel_agent');
  await until(() => bus.running.size === 0);
  const [lead, one] = bus.members(group.id);
  const oneEndpoint = bus.store.endpoint(one.id, `pair:${lead.id}`, lead.id);
  const secret = '面板🧪' + 'x'.repeat(600);
  captures.groupId = group.id;
  const sent = await bus.tool(oneEndpoint.id, oneEndpoint.key, 'send', {
    to: taken.controller.id,
    text: secret,
  });
  captures.messageId = sent.messageId;
  await until(() => captures.done, 'panel projection timed out');
  assert.equal(captures.read.schema, CONTEXT_SCHEMA_VERSION);
  assert.equal(captures.read.view, 'bounded');
  assert.equal(captures.message.complete, false);
  assert.equal(captures.restored, secret);
  const coordination = bus.store.panelSession(taken.controller.id, 'coordination', group.id);
  const panelTools = panelToolsFor('coordination');
  assert.ok(panelTools.find(tool => tool.name === 'team_read').inputSchema.properties.messageId);
  assert.equal(panelTools.some(tool => tool.name === 'team_collaboration_read'), false);
  await assert.rejects(
    bus.panelTool(coordination.id, 'wrong-key', 'team_read', { groupId: group.id }),
    /来源无效/,
  );
  const manifest = bus.informationManifest(captures.turnId);
  assert.ok(manifest.rulesBytes > 0);
  assert.ok(manifest.turnInputBytes > 0);
  assert.ok(manifest.measurements.some(row => row.kind === 'tool_result' && row.detail.expansion === true));
  assert.ok(manifest.expandCount >= 1);
  await bus.runEndpoint(oneEndpoint, 'establish member session for comparison');
  const memberRead = await bus.tool(oneEndpoint.id, oneEndpoint.key, 'read', {});
  assert.equal(memberRead.schema, CONTEXT_SCHEMA_VERSION);
  assert.equal(memberRead.view, 'bounded');
  const memberMessage = memberRead.messages.find(row => row.id === captures.message.id);
  assert.deepEqual(memberMessage, captures.message);
});

test('Codex dynamic-tool adapter receives the same bounded projection and schema', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-info-codex-'));
  const fake = join(directory, 'fake-codex.mjs');
  writeFileSync(fake, `#!/usr/bin/env node
import{createInterface}from'node:readline';const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);
if(r.id===900&&r.result){send({method:'item/completed',params:{threadId:'t',turnId:'u',item:{type:'agentMessage',text:r.result.contentItems[0].text}}});send({method:'turn/completed',params:{threadId:'t',turn:{id:'u',status:'completed'}}});return}
if(r.method==='initialize')send({id:r.id,result:{}});
if(r.method==='config/read')send({id:r.id,result:{config:{mcp_servers:{}}}});
if(r.method==='thread/start'||r.method==='thread/resume')send({id:r.id,result:{thread:{id:'t'},model:'fake',modelProvider:'fake'}});
if(r.method==='turn/start'){send({id:r.id,result:{turn:{id:'u'}}});setImmediate(()=>send({id:900,method:'item/tool/call',params:{threadId:'t',turnId:'u',tool:'agent_team_read',arguments:{limit:5},callId:'c'}}));}
});`);
  chmodSync(fake, 0o700);
  const codexHost = createCodexHost({ command: fake });
  const fakeHost = {
    async run(context) {
      context.onSession(context.endpoint.session ?? `native-${context.endpoint.id}`);
      context.onAccepted();
      return 'done';
    },
  };
  const bus = new Bus({
    directory,
    hosts: new Map([['fake', fakeHost], ['codex', codexHost]]),
  });
  t.after(async () => {
    if (!bus.closing) await bus.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  });
  const group = createTestGroup(bus, {
    name: 'codex projection',
    workspace: directory,
    lead: { name: 'lead', host: 'fake' },
    members: [{ name: 'worker', host: 'codex' }],
  });
  await until(() => bus.running.size === 0);
  const [lead, worker] = bus.members(group.id);
  const leadEndpoint = bus.store.endpoint(lead.id, 'coordination');
  await bus.tool(leadEndpoint.id, leadEndpoint.key, 'send', { to: worker.id, text: 'Codex dynamic tool 🧪' });
  const outputs = () => bus.store.all("SELECT event FROM history WHERE event LIKE '%framework.output%' ORDER BY seq")
    .map(row => JSON.parse(row.event).text)
    .flatMap(text => { try { return [JSON.parse(text)]; } catch { return []; } });
  await until(() => outputs().some(value => value?.view === 'bounded'), 'codex tool output missing');
  const projected = outputs().find(value => value?.view === 'bounded');
  assert.equal(projected.schema, CONTEXT_SCHEMA_VERSION);
  assert.equal(projected.view, 'bounded');
  assert.ok(projected.messages.some(message => message.preview.includes('Codex dynamic tool')));
  assert.ok(projected.messages.every(message => !Object.hasOwn(message, 'text')));
  assert.match(projected.messages.at(-1).ref.hash, /^[0-9a-f]{64}$/);
  const workerEndpoint = bus.store.get("SELECT * FROM conversations WHERE member_id=? AND context LIKE 'pair:%'", worker.id);
  const workerTools = bus.endpointTools(workerEndpoint.id, workerEndpoint.key);
  const readTool = workerTools.find(tool => tool.name === 'read');
  assert.ok(readTool.inputSchema.properties.messageId);
  assert.ok(readTool.inputSchema.properties.hash);
  assert.equal(readTool.inputSchema.properties.bodyLimit.maximum, 4096);
  assert.equal(toolsFor('member').some(tool => tool.name === 'collaboration_read'), false);
});
});

describe('manager-conversation', () => {
const until = async fn => {
  for (let index = 0; index < 500; index += 1) {
    if (fn()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('condition timed out');
};

function seedComplete(usage, context, { source = 'fake.panel.usage', timing = { hostTurnWallMs: 40 }, incomplete = false } = {}) {
  return telemetryObservation({
    source,
    scope: 'turn',
    aggregation: 'delta',
    nativeTurnId: usage.nativeTurnId,
    usage: {
      inputTokensTotal: usage.inputTokensTotal,
      uncachedInputTokens: usage.inputTokensTotal - 10,
      cacheReadTokens: 10,
      cacheWriteTokens: 0,
      outputTokens: 5,
      totalTokens: usage.inputTokensTotal + 5,
    },
    context,
    timing,
    completeness: incomplete
      ? { inputTokensTotal: 'partial', cacheReadTokens: 'complete' }
      : {
          inputTokensTotal: 'complete', uncachedInputTokens: 'complete', cacheReadTokens: 'complete',
          cacheWriteTokens: 'complete', outputTokens: 'complete', totalTokens: 'complete', hostTurnWallMs: 'complete',
        },
    attempt: { id: `attempt-${usage.nativeTurnId}`, state: 'succeeded' },
  });
}

async function fixture(t) {
  const cleanup = [];
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-manager-conversation-'));
  const host = {
    telemetryCapabilities: telemetryCapabilitiesFor('codex'),
    async run(ctx) {
      ctx.onSession(ctx.endpoint.session ?? ctx.endpoint.id);
      ctx.onAccepted();
      return 'ok';
    },
  };
  const bus = new Bus({ directory, hosts: new Map([['fake', host]]) });
  const group = createTestGroup(bus, {
    name: 'manager-conversation-group',
    workspace: directory,
    lead: { name: 'lead', host: 'fake' },
    members: [{ name: 'one', host: 'fake' }, { name: 'two', host: 'fake' }],
  });
  await until(() => bus.running.size === 0);
  const [lead, one, two] = bus.members(group.id);
  const now = new Date().toISOString();
  const panelId = 'panel-agent-manager-test';
  bus.store.run(
    'INSERT INTO panel_agents(id,singleton,name,host,model_provider,model,reasoning_effort,created,updated) VALUES(?,1,?,?,?,?,?,?,?)',
    panelId, 'Panel Agent', 'fake', 'fake-provider', 'fake-model', 'low', now, now,
  );
  bus.store.run(
    `INSERT INTO team_lead_controllers(group_id,controller_kind,controller_id,state,original_lead_id,revision,updated)
     VALUES(?,'panel_agent',?,'active',?,1,?)
     ON CONFLICT(group_id) DO UPDATE SET controller_kind='panel_agent',controller_id=excluded.controller_id,
       state='active',original_lead_id=excluded.original_lead_id,revision=revision+1,updated=excluded.updated`,
    group.id, panelId, lead.id, now,
  );
  const session = bus.store.panelSession(panelId, 'coordination', group.id);
  let panelCounter = 0;
  let memberCounter = 0;

  const addPanelTurn = ({ startedAt, inputs = [], outputs = [], inputTokens = 100, model = 'fake-model', incomplete = false, partial = false }) => {
    panelCounter += 1;
    const turnId = `panel-conversation-turn-${panelCounter}`;
    bus.store.run(
      'INSERT INTO turns(id,conversation_id,executor_kind,executor_id,group_id,session,active_team_id,state,created) VALUES(?,?,?,?,?,?,?,?,?)',
      turnId, session.id, 'panel_agent', panelId, group.id, session.session ?? null, group.id, 'succeeded', startedAt,
    );
    inputs.forEach((input, index) => {
      const message = bus.store.append(group.id, input.sender, panelId, input.kind ?? 'send', input.text ?? `input ${index}`);
      bus.store.run('INSERT INTO turn_inputs VALUES(?,?,?)', turnId, message.id, index);
    });
    outputs.forEach((output, index) => {
      const message = bus.store.append(group.id, panelId, output.recipient, output.kind ?? 'send', output.text ?? `SECRET_BODY_${turnId}_${index}`);
      bus.store.run('INSERT INTO message_origins(message_id,turn_id,event_seq,call_id,native_call_id) VALUES(?,?,?,?,?)', message.id, turnId, null, `call-${turnId}-${index}`, null);
    });
    const context = model === null
      ? { lastRequestInputTokens: inputTokens, contextWindowTokens: 1000 }
      : { lastRequestInputTokens: inputTokens, contextWindowTokens: 1000, model: { provider: 'fake-provider', model, source: 'fake.model', observedAt: startedAt } };
    bus.telemetry.record({
      groupId: group.id,
      executorKind: 'panel_agent',
      executorId: panelId,
      endpointId: session.id,
      sessionKey: 'default',
      turnId,
      turnKind: 'panel',
      host: 'fake',
      hostSessionId: 'panel-thread',
      context: 'coordination',
      observation: partial
        ? telemetryObservation({
            source: 'fake.panel.usage',
            scope: 'turn',
            aggregation: 'delta',
            nativeTurnId: `native-${turnId}`,
            usage: { inputTokensTotal: inputTokens, cacheReadTokens: 10 },
            context,
            completeness: { inputTokensTotal: 'partial', cacheReadTokens: 'complete' },
            attempt: { id: `attempt-native-${turnId}`, state: 'failed' },
          })
        : seedComplete({ nativeTurnId: `native-${turnId}`, inputTokensTotal: inputTokens }, context, { incomplete }),
    });
    return turnId;
  };

  const addMemberPairTurn = ({ startedAt, inputTokens = 111, incomplete = false }) => {
    memberCounter += 1;
    const turnId = `member-pair-turn-${memberCounter}`;
    const endpoint = bus.store.endpoint(one.id, `pair:${panelId}`, panelId);
    bus.store.run('INSERT INTO turns(id,conversation_id,executor_kind,executor_id,group_id,session,state,created) VALUES(?,?,?,?,?,?,?,?)', turnId, endpoint.id, 'member', one.id, group.id, endpoint.session, 'completed', startedAt);
    const input = bus.store.append(group.id, panelId, one.id, 'send', 'pair input');
    bus.store.run('INSERT INTO turn_inputs VALUES(?,?,?)', turnId, input.id, 0);
    bus.telemetry.record({
      groupId: group.id,
      executorKind: 'member',
      executorId: one.id,
      endpointId: endpoint.id,
      sessionKey: 'default',
      turnId,
      turnKind: 'member',
      host: 'fake',
      hostSessionId: 'member-thread',
      context: endpoint.context,
      observation: seedComplete(
        { nativeTurnId: `native-${turnId}`, inputTokensTotal: inputTokens },
        {
          lastRequestInputTokens: inputTokens,
          contextWindowTokens: 1000,
          model: { provider: 'fake-provider', model: 'fake-model', source: 'fake.model', observedAt: startedAt },
        },
        { source: 'fake.member.usage', incomplete },
      ),
    });
    return { turnId, endpoint };
  };

  t.after(async () => {
    for (const close of cleanup) await close();
    if (!bus.closing) await bus.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  });
  return { bus, group, lead, one, two, panelId, session, addPanelTurn, addMemberPairTurn, directory, cleanup };
}

test('manager-conversation separates member and manager sides, covers input and output involvement, and keeps shared batches whole', async t => {
  const { bus, group, lead, one, two, addPanelTurn, addMemberPairTurn } = await fixture(t);
  const memberTurn = addMemberPairTurn({ startedAt: '2026-10-23T10:00:00.000Z', inputTokens: 111 });
  const inputTurn = addPanelTurn({ startedAt: '2026-10-23T10:00:10.000Z', inputs: [{ sender: one.id }], outputs: [], inputTokens: 200 });
  const outputOnlyTurn = addPanelTurn({ startedAt: '2026-10-23T10:00:20.000Z', inputs: [], outputs: [{ recipient: one.id, kind: 'note' }], inputTokens: 300 });
  const sharedTurn = addPanelTurn({
    startedAt: '2026-10-23T10:00:30.000Z',
    inputs: [{ sender: one.id }, { sender: two.id }],
    outputs: [{ recipient: one.id }, { recipient: two.id }],
    inputTokens: 400,
  });
  const otherTurn = addPanelTurn({ startedAt: '2026-10-23T10:00:40.000Z', inputs: [{ sender: two.id }], outputs: [{ recipient: two.id }], inputTokens: 500 });
  const modelNullTurn = addPanelTurn({ startedAt: '2026-10-23T10:00:50.000Z', inputs: [{ sender: one.id }], outputs: [], inputTokens: 600, model: null });

  const response = bus.telemetryManagerConversation(group.id, one.id);
  assert.equal(response.readOnly, true);
  assert.equal(response.member.memberId, one.id);
  assert.equal(response.manager.kind, 'panel_agent');
  assert.deepEqual(response.summary.memberBatchIds, [memberTurn.turnId].map(id => `batch:${id}`));
  assert.deepEqual(response.summary.managerBatchIds.sort(), [inputTurn, outputOnlyTurn, sharedTurn, modelNullTurn].map(id => `batch:${id}`).sort());
  assert.deepEqual(response.summary.exclusiveManagerBatchIds.sort(), [inputTurn, outputOnlyTurn, modelNullTurn].map(id => `batch:${id}`).sort());
  assert.deepEqual(response.summary.sharedManagerBatchIds, [`batch:${sharedTurn}`]);
  assert.deepEqual(response.managerSide.involvedMemberIds, [one.id, two.id].sort());
  assert.equal(response.managerSide.batchCount, 4);
  assert.equal(response.memberSide.batchCount, 1);
  assert.equal(response.memberSide.totals.inputTokensTotal.value, 111);
  assert.equal(response.managerSide.involvementTotals.inputTokensTotal.value, 200 + 300 + 400 + 600);

  const memberBatch = response.batches.find(batch => batch.batchId === `batch:${memberTurn.turnId}`);
  assert.equal(memberBatch.side, 'member');
  assert.equal(memberBatch.involvement, null);
  assert.deepEqual(memberBatch.outgoingMessages, []);
  assert.equal(memberBatch.physicalSession.context, 'pair');
  assert.equal(memberBatch.physicalSession.peer, response.manager.memberId);

  const outputOnlyBatch = response.batches.find(batch => batch.batchId === `batch:${outputOnlyTurn}`);
  assert.equal(outputOnlyBatch.side, 'manager');
  assert.equal(outputOnlyBatch.inputBatch.messages.length, 0);
  assert.equal(outputOnlyBatch.outgoingMessages.length, 1);
  assert.equal(outputOnlyBatch.outgoingMessages[0].recipientKind, 'member');
  assert.equal(outputOnlyBatch.outgoingMessages[0].kind, 'note');
  assert.equal(outputOnlyBatch.involvement.exclusiveToMember, true);
  assert.equal(outputOnlyBatch.involvement.sharedWithOtherMembers, false);

  const sharedBatch = response.batches.find(batch => batch.batchId === `batch:${sharedTurn}`);
  assert.deepEqual(sharedBatch.involvement, {
    involvedMemberIds: [one.id, two.id].sort(),
    exclusiveToMember: false,
    sharedWithOtherMembers: true,
  });
  assert.equal(sharedBatch.inputBatch.merge.merged, true);
  assert.equal(sharedBatch.inputBatch.merge.countedOnce, true);
  assert.equal(sharedBatch.outgoingMessages.length, 2);
  assert.ok(!JSON.stringify(response).includes('SECRET_BODY_'), 'outgoingMessages must not expose message text');

  assert.ok(response.managerSide.physicalSessions.length >= 1);
  assert.equal(response.managerSide.physicalSessions[0].consumption.inputTokensTotal.value, 200 + 300 + 400 + 500 + 600);
  // Session 累计包含与本成员无关的回合,involvementTotals 只累计相关回合。
  assert.ok(response.managerSide.physicalSessions[0].consumption.inputTokensTotal.value
    > response.managerSide.involvementTotals.inputTokensTotal.value);
  assert.equal(response.managerSide.contextReference.model, null);
  assert.equal(response.managerSide.contextReference.lastRequestInputRatio.value, null);
  assert.equal(response.managerSide.contextReference.lastRequestInputRatio.quality, 'unknown');
  assert.equal(response.managerSide.contextReference.lastRequestInputRatio.missingReason, 'scope_mismatch');
  assert.notEqual(otherTurn, undefined);

  const second = bus.telemetryManagerConversation(group.id, two.id);
  assert.equal(second.summary.memberBatchIds.length, 0);
  assert.deepEqual(second.summary.managerBatchIds.sort(), [sharedTurn, otherTurn].map(id => `batch:${id}`).sort());
  const secondShared = second.batches.find(batch => batch.batchId === `batch:${sharedTurn}`);
  assert.deepEqual(secondShared.involvement, sharedBatch.involvement);
  assert.equal(second.memberSide.batchCount, 0);
  assert.equal(second.memberSide.totals.inputTokensTotal.value, null);
  assert.equal(second.memberSide.totals.inputTokensTotal.missingReason, 'not_captured');
  assert.equal(second.memberSide.contextReference.lastRequestInputRatio.missingReason, 'dependency_missing');
  assert.deepEqual(second.memberSide.physicalSessions, []);
  assert.ok(second.memberSide.coverage.reasons.includes('no_observations'));

  const existing = bus.telemetryMembers(group.id);
  assert.equal(existing.readOnly, true);
  assert.ok(existing.members.every(member => !('outgoingMessages' in member) && !('involvement' in member)));

  // 完全没有观察值时,两侧 totals 仍是固定形状的空值(不缺字段、不补零)。
  const empty = bus.telemetryManagerConversation(group.id, lead.id);
  assert.equal(empty.memberSide.batchCount, 0);
  assert.equal(empty.managerSide.batchCount, 0);
  for (const totals of [empty.memberSide.totals, empty.managerSide.involvementTotals]) {
    assert.equal(Object.keys(totals).length, 9);
    for (const metricValue of Object.values(totals)) {
      assert.equal(metricValue.value, null);
      assert.equal(metricValue.quality, 'unknown');
      assert.ok(metricValue.missingReason);
    }
  }
  assert.deepEqual(empty.memberSide.physicalSessions, []);
  assert.deepEqual(empty.managerSide.physicalSessions, []);
  assert.ok(empty.memberSide.coverage.reasons.includes('no_observations'));
  assert.ok(empty.managerSide.coverage.reasons.includes('no_observations'));
  assert.equal(empty.memberSide.contextReference.model, null);
  assert.equal(empty.managerSide.contextReference.model, null);
  assert.deepEqual(empty.batches, []);
  assert.equal(empty.nextCursor, null);
  assert.throws(() => bus.telemetryManagerConversation(group.id, 'missing-member'), error => error.status === 404);
});

test('manager-conversation paginates with a stable key-set cursor and validates parameters', async t => {
  const { bus, group, one, addPanelTurn, addMemberPairTurn } = await fixture(t);
  addMemberPairTurn({ startedAt: '2026-10-23T11:00:00.000Z' });
  for (let index = 0; index < 5; index += 1) {
    addPanelTurn({
      startedAt: `2026-10-23T11:00:0${index + 1}.000Z`,
      inputs: [{ sender: one.id }],
      inputTokens: 100 + index * 10,
    });
  }
  addPanelTurn({ startedAt: '2026-10-23T11:00:02.500Z', inputs: [{ sender: one.id }], inputTokens: 999 });
  const full = bus.telemetryManagerConversation(group.id, one.id, { limit: 100 });
  const orderedTimes = full.batches.map(batch => batch.startedAt);
  assert.deepEqual(orderedTimes, [...orderedTimes].sort());
  const collected = [];
  let cursor;
  let pages = 0;
  do {
    const page = bus.telemetryManagerConversation(group.id, one.id, { limit: 2, cursor });
    assert.deepEqual(page.memberSide.totals, full.memberSide.totals);
    assert.deepEqual(page.managerSide.involvementTotals, full.managerSide.involvementTotals);
    assert.deepEqual(page.summary, full.summary);
    collected.push(...page.batches.map(batch => batch.batchId));
    cursor = page.nextCursor;
    pages += 1;
    assert.ok(pages < 10);
  } while (cursor);
  assert.equal(collected.length, full.batches.length);
  assert.equal(new Set(collected).size, collected.length);
  assert.deepEqual(collected, full.batches.map(batch => batch.batchId));

  assert.throws(() => bus.telemetryManagerConversation(group.id, one.id, { cursor: 'not-a-cursor' }), /cursor 无效/);
  assert.throws(() => bus.telemetryManagerConversation(group.id, one.id, { limit: '' }), /limit/);
  assert.throws(() => bus.telemetryManagerConversation(group.id, one.id, { limit: 0 }), /limit/);
  assert.throws(() => bus.telemetryManagerConversation(group.id, one.id, { limit: 101 }), /limit/);
  assert.throws(() => bus.telemetryManagerConversation(group.id, one.id, { from: '2026-10-23T12:00:00.000Z', to: '2026-10-23T11:00:00.000Z' }), /from/);

  const ranged = bus.telemetryManagerConversation(group.id, one.id, {
    from: '2026-10-23T11:00:03.000Z',
    to: '2026-10-23T11:00:05.000Z',
    limit: 100,
  });
  assert.ok(ranged.batches.length > 0);
  assert.ok(ranged.batches.every(batch => batch.startedAt >= '2026-10-23T11:00:03.000Z' && batch.startedAt < '2026-10-23T11:00:05.000Z'));

  // 窗口完全落在数据之后时,成员侧与管理侧都必须精确为空。
  const outside = bus.telemetryManagerConversation(group.id, one.id, {
    from: '2026-10-23T13:00:00.000Z',
    to: '2026-10-23T14:00:00.000Z',
    limit: 100,
  });
  assert.equal(outside.memberSide.batchCount, 0);
  assert.equal(outside.managerSide.batchCount, 0);
  assert.deepEqual(outside.summary.managerBatchIds, []);
  assert.deepEqual(outside.batches, []);
});

test('manager-conversation keeps partial usage non-zero-filled and duplicate observations update one batch', async t => {
  const { bus, group, panelId, session, one, addPanelTurn } = await fixture(t);
  const turnId = addPanelTurn({
    startedAt: '2026-10-23T12:00:00.000Z',
    inputs: [{ sender: one.id }],
    inputTokens: 400,
    partial: true,
  });
  const first = bus.telemetryManagerConversation(group.id, one.id);
  const batch = first.batches.find(item => item.batchId === `batch:${turnId}`);
  assert.equal(batch.completeness, 'partial');
  assert.equal(batch.metrics.inputTokensTotal.value, 400);
  assert.equal(batch.metrics.outputTokens.value, null);
  assert.ok(batch.metrics.outputTokens.missingReason);
  assert.equal(first.managerSide.coverage.partialBatchCount, 1);

  bus.telemetry.record({
    groupId: group.id,
    executorKind: 'panel_agent',
    executorId: panelId,
    endpointId: session.id,
    sessionKey: 'default',
    turnId,
    turnKind: 'panel',
    host: 'fake',
    hostSessionId: 'panel-thread',
    context: 'coordination',
    observation: telemetryObservation({
      source: 'fake.panel.usage',
      scope: 'turn',
      aggregation: 'delta',
      nativeTurnId: `native-${turnId}`,
      usage: { inputTokensTotal: 450, cacheReadTokens: 10 },
      context: { lastRequestInputTokens: 450, contextWindowTokens: 1000 },
      completeness: { inputTokensTotal: 'partial', cacheReadTokens: 'complete' },
      attempt: { id: `attempt-native-${turnId}`, state: 'failed' },
    }),
  });
  const second = bus.telemetryManagerConversation(group.id, one.id);
  assert.equal(second.managerSide.batchCount, 1);
  assert.equal(second.batches.find(item => item.batchId === `batch:${turnId}`).metrics.inputTokensTotal.value, 450);
  assert.equal(second.batches.find(item => item.batchId === `batch:${turnId}`).metrics.outputTokens.value, null);
});

test('manager-conversation HTTP route is read-only JSON and preserves existing endpoints', async t => {
  const { bus, group, one, directory, addPanelTurn, cleanup } = await fixture(t);
  const turnId = addPanelTurn({ startedAt: '2026-10-23T10:00:10.000Z', inputs: [{ sender: one.id }], outputs: [{ recipient: one.id }] });
  const server = await startServer({ directory, hosts: new Map([['fake', { async run() { return 'unused'; } }]]) });
  cleanup.push(() => server.close());
  await new Promise(resolve => setTimeout(resolve, 100));
  const before = bus.telemetryMembers(group.id);
  const response = await fetch(`${server.url}api/telemetry/manager-conversation?group=${group.id}&member=${one.id}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/json/);
  const body = await response.json();
  assert.equal(body.readOnly, true);
  assert.equal(body.manager.kind, 'panel_agent');
  assert.equal(body.managerSide.batchCount, 1);
  assert.equal(body.managerSide.involvementTotals.inputTokensTotal.value, 100);
  assert.equal(body.batches.some(batch => batch.batchId === `batch:${turnId}`), true);
  assert.ok(!JSON.stringify(body).includes('SECRET_BODY_'));

  const missingMember = await fetch(`${server.url}api/telemetry/manager-conversation?group=${group.id}`);
  assert.equal(missingMember.status, 400);
  assert.match(missingMember.headers.get('content-type'), /application\/json/);
  assert.equal(typeof (await missingMember.json()).error, 'string');
  const missingGroup = await fetch(`${server.url}api/telemetry/manager-conversation?member=${one.id}`);
  assert.equal(missingGroup.status, 400);
  const unknownMember = await fetch(`${server.url}api/telemetry/manager-conversation?group=${group.id}&member=missing-member`);
  assert.equal(unknownMember.status, 404);
  assert.match(unknownMember.headers.get('content-type'), /application\/json/);
  assert.equal(typeof (await unknownMember.json()).error, 'string');
  const badLimit = await fetch(`${server.url}api/telemetry/manager-conversation?group=${group.id}&member=${one.id}&limit=0`);
  assert.equal(badLimit.status, 400);
  assert.match(badLimit.headers.get('content-type'), /application\/json/);
  assert.equal(typeof (await badLimit.json()).error, 'string');

  const existing = bus.telemetryMembers(group.id);
  assert.equal(existing.readOnly, true);
  assert.ok(existing.members.every(member => !('outgoingMessages' in member) && !('involvement' in member)));
  assert.equal(before.readOnly, true);
});

test('manager-conversation rejects a member controller and keeps member-side shape empty when no pair exists', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-manager-empty-'));
  const host = { telemetryCapabilities: telemetryCapabilitiesFor('codex'), async run(ctx) { ctx.onAccepted(); return 'ok'; } };
  const bus = new Bus({ directory, hosts: new Map([['fake', host]]) });
  const group = createTestGroup(bus, {
    name: 'member-controller-group', workspace: directory, lead: { name: 'lead', host: 'fake' }, members: [{ name: 'worker', host: 'fake' }],
  });
  await until(() => bus.running.size === 0);
  const [lead, worker] = bus.members(group.id);
  assert.throws(() => bus.telemetryManagerConversation(group.id, worker.id), /不是 Panel Agent/);
  t.after(async () => { if (!bus.closing) await bus.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
  assert.ok(lead);
});
});

describe('telemetry', () => {
const _tick = () => new Promise(resolve => setImmediate(resolve));
async function until(fn) { const end = Date.now() + 3000; while (!fn()) { if (Date.now() > end) throw new Error('condition timed out'); await new Promise(resolve => setTimeout(resolve, 10)); } }

function fixture(t, run) {
  const cleanup = [];
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-telemetry-'));
  let counter = 0;
  const calls = [];
  const host = {
    telemetryCapabilities: telemetryCapabilitiesFor('codex'),
    async run(ctx) {
      calls.push(ctx);
      counter += 1;
      const nativeTurnId = `native-${counter}`;
      ctx.onSession(`session-${ctx.endpoint.id}`);
      ctx.onNativeTurn(nativeTurnId);
      if (run && ctx.endpoint.context !== 'profile') return run(ctx, { counter, nativeTurnId });
      emitDefault(ctx, counter, nativeTurnId);
      ctx.onAccepted();
      return 'ok';
    },
  };
  const bus = new Bus({ directory, hosts: new Map([['fake', host]]) });
  const group = createTestGroup(bus, {
    name: 'telemetry-group',
    workspace: directory,
    lead: { name: 'lead', host: 'fake' },
    members: [{ name: 'one', host: 'fake' }, { name: 'two', host: 'fake' }],
  });
  const members = bus.members(group.id);
  t.after(async () => { for (const close of cleanup) await close(); if (!bus.closing) await bus.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
  return { bus, group, members, directory, calls, host, cleanup };
}

function emitDefault(ctx, counter, nativeTurnId, overrides = {}) {
  const base = 100 + counter * 10;
  ctx.onTelemetry(telemetryObservation({
    source: 'fake.usage',
    scope: 'turn',
    aggregation: 'delta',
    nativeTurnId,
    usage: {
      inputTokensTotal: base,
      uncachedInputTokens: base - 20,
      cacheReadTokens: 10,
      cacheWriteTokens: 10,
      outputTokens: 5,
      totalTokens: base + 5,
    },
    context: { lastRequestInputTokens: base, contextWindowTokens: 1000, model: { provider: 'fake', model: 'fake-model', source: 'fake.model', observedAt: new Date().toISOString() } },
    timing: { hostTurnWallMs: 30 },
    completeness: Object.fromEntries(['inputTokensTotal', 'uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'totalTokens', 'hostTurnWallMs'].map(field => [field, 'complete'])),
    attempt: { id: `attempt-${counter}`, state: 'succeeded' },
    ...overrides,
  }));
}

async function sendFrom(bus, from, to, text) {
  const endpoint = bus.store.endpoint(from.id, `pair:${to.id}`);
  await bus.tool(endpoint.id, endpoint.key, 'send', { to: to.id, text });
  await until(() => bus.running.size === 0);
}

test('conversation exposes per-executor attribution, context reference, sessions, and no zero fill', async t => {
  const { bus, group, members } = fixture(t);
  const [, one, two] = members;
  await until(() => bus.running.size === 0);
  await sendFrom(bus, one, two, 'hello two');
  await sendFrom(bus, two, one, 'hello one');
  const conversation = bus.telemetryConversation(group.id, one.id, two.id);
  assert.equal(conversation.readOnly, true);
  assert.equal(conversation.schemaVersion, 1);
  assert.deepEqual(conversation.conversation.participantIds, [one.id, two.id]);
  assert.equal(conversation.executors.length, 2);
  const oneExecutor = conversation.executors.find(executor => executor.executor.memberId === one.id);
  const twoExecutor = conversation.executors.find(executor => executor.executor.memberId === two.id);
  assert.ok(oneExecutor.totals.inputTokensTotal.value > 0);
  assert.ok(twoExecutor.totals.inputTokensTotal.value > 0);
  for (const executor of conversation.executors) {
    for (const metricValue of [...Object.values(executor.totals), ...Object.values(executor.contextReference).filter(value => value && typeof value === 'object' && 'quality' in value)]) {
      if (metricValue.quality === 'derived') assert.ok(metricValue.formula, 'derived metrics must keep a formula');
    }
  }
  for (const batch of conversation.batches) {
    for (const metricValue of [...Object.values(batch.metrics), ...Object.values(batch.contextReference).filter(value => value && typeof value === 'object' && 'quality' in value)]) {
      if (metricValue.quality === 'derived') assert.ok(metricValue.formula, 'derived metrics must keep a formula');
    }
  }
  assert.equal(oneExecutor.contextReference.contextWindowTokens.value, 1000);
  assert.ok(oneExecutor.contextReference.lastRequestInputRatio.value > 0);
  assert.equal(oneExecutor.physicalSessions.length, 1);
  assert.equal(oneExecutor.physicalSessions[0].consumption.inputTokensTotal.value, oneExecutor.totals.inputTokensTotal.value);
  assert.ok(oneExecutor.physicalSessions[0].status === 'active');
  for (const batch of conversation.batches) {
    assert.ok(batch.inputBatch.messages.length >= 1);
    assert.equal(batch.inputBatch.allocation, 'whole_to_executor');
    assert.match(batch.batchId, /^batch:/);
    assert.equal(batch.physicalSession.context, 'pair');
    assert.ok(batch.physicalSession.peer);
  }
  const caps = bus.telemetryCapabilities(group.id);
  assert.equal(caps.readOnly, true);
  assert.equal(caps.hosts.length, 1);
  assert.equal(Object.keys(caps.hosts[0].metrics).length, 12);
  assert.equal(caps.hosts[0].metrics.inputTokensTotal.capability, 'direct');
});

test('telemetry members omits panel agents that neither worked nor control the team', async t => {
  const { bus, group } = fixture(t);
  const panelId = seedPanelAgent(bus, { name: 'Panel', host: 'fake' });
  const listed = () => bus.telemetryMembers(group.id).members.some(member => member.executor.kind === 'panel_agent' && member.executor.memberId === panelId);
  assert.equal(listed(), false, 'an unbound zero-turn panel agent must not appear');

  const now = new Date().toISOString();
  bus.store.run(
    "INSERT INTO panel_team_bindings(panel_agent_id,group_id,relation,created,updated) VALUES(?,?,'observer',?,?)",
    panelId, group.id, now, now,
  );
  assert.equal(listed(), false, 'observer binding alone must not add a team telemetry row');

  bus.store.run("UPDATE panel_team_bindings SET relation='main' WHERE panel_agent_id=? AND group_id=?", panelId, group.id);
  assert.equal(listed(), true, 'a main binding is an active controller');

  bus.store.run('DELETE FROM panel_team_bindings WHERE panel_agent_id=? AND group_id=?', panelId, group.id);
  bus.store.run(
    `INSERT INTO team_lead_controllers(group_id,controller_kind,controller_id,state,original_lead_id,revision,updated)
     VALUES(?,'panel_agent',?,'active',NULL,1,?)
     ON CONFLICT(group_id) DO UPDATE SET controller_kind='panel_agent',controller_id=excluded.controller_id,state='active',revision=revision+1,updated=excluded.updated`,
    group.id, panelId, now,
  );
  assert.equal(listed(), true, 'an active lead controller should appear');

  bus.store.run("UPDATE team_lead_controllers SET state='suspended' WHERE group_id=?", group.id);
  assert.equal(listed(), false, 'a suspended controller without batches must not appear');
});

test('context ratio requires the same model route', async t => {
  let runIndex = 0;
  const { bus, group, members } = fixture(t, (ctx, { nativeTurnId }) => {
    runIndex += 1;
    const current = runIndex;
    const model = { provider: 'fake', model: current === 1 ? 'model-a' : 'model-b', source: 'fake.model', observedAt: new Date().toISOString() };
    ctx.onTelemetry(telemetryObservation({
      source: 'fake.request',
      scope: 'request',
      aggregation: 'snapshot',
      nativeTurnId,
      context: { lastRequestInputTokens: 100, model },
      quality: { lastRequestInputTokens: 'host_reported' },
      completeness: { lastRequestInputTokens: 'complete' },
    }));
    ctx.onTelemetry(telemetryObservation({
      source: 'fake.window',
      scope: 'request',
      aggregation: 'snapshot',
      nativeTurnId,
      context: { contextWindowTokens: 1000, model: current === 1 ? { ...model, model: 'model-c' } : model },
      quality: { contextWindowTokens: 'host_reported' },
      completeness: { contextWindowTokens: 'complete' },
    }));
    ctx.onAccepted();
    return 'ok';
  });
  const [lead, one] = members;
  await until(() => bus.running.size === 0);
  await sendFrom(bus, lead, one, 'mismatch route');
  await sendFrom(bus, lead, one, 'matched route');
  const result = bus.telemetryConversation(group.id, lead.id, one.id);
  const [mismatch, matched] = result.batches;
  assert.equal(mismatch.contextReference.lastRequestInputRatio.value, null);
  assert.equal(mismatch.contextReference.lastRequestInputRatio.quality, 'unknown');
  assert.equal(mismatch.contextReference.lastRequestInputRatio.missingReason, 'scope_mismatch');
  assert.equal(mismatch.contextReference.model, null);
  assert.equal(matched.contextReference.lastRequestInputRatio.value, 0.1);
  assert.equal(matched.contextReference.lastRequestInputRatio.formula, 'lastRequestInputTokens / contextWindowTokens');
  assert.equal(matched.contextReference.model.model, 'model-b');
  for (const batch of result.batches) {
    for (const metricValue of Object.values(batch.metrics)) {
      if (metricValue.quality === 'derived') assert.ok(metricValue.formula, `${batch.batchId} derived metric requires formula`);
    }
  }
});

test('missing metrics stay null with a reason and explicit zero remains zero', async t => {
  const { bus, group, members } = fixture(t, (ctx, { counter, nativeTurnId }) => {
    ctx.onTelemetry(telemetryObservation({
      source: 'fake.partial',
      scope: 'turn',
      aggregation: 'delta',
      nativeTurnId,
      usage: { inputTokensTotal: 400, cacheReadTokens: 0 },
      context: { lastRequestInputTokens: 400 },
      completeness: { inputTokensTotal: 'partial', cacheReadTokens: 'complete' },
      attempt: { id: `attempt-${counter}`, state: 'failed' },
    }));
    ctx.onAccepted();
    return 'ok';
  });
  const [lead, one] = members;
  await until(() => bus.running.size === 0);
  await sendFrom(bus, lead, one, 'partial');
  const result = bus.telemetryConversation(group.id, lead.id, one.id);
  const batch = result.batches[0];
  assert.equal(batch.metrics.inputTokensTotal.value, 400);
  assert.equal(batch.metrics.cacheReadTokens.value, 0);
  assert.equal(batch.metrics.outputTokens.value, null);
  assert.notEqual(batch.metrics.outputTokens.value, 0);
  assert.ok(batch.metrics.outputTokens.missingReason);
  assert.equal(batch.metrics.totalTokens.value, null);
  assert.equal(batch.completeness, 'partial');
});

test('duplicate snapshots update one observation and restored old native turns route to their original turn', async t => {
  const { bus, group, members } = fixture(t);
  const [lead, one] = members;
  await until(() => bus.running.size === 0);
  await sendFrom(bus, lead, one, 'first');
  const firstResult = bus.telemetryConversation(group.id, lead.id, one.id);
  const firstBatch = firstResult.batches[0];
  const firstRef = bus.store.get('SELECT ref FROM native_turn_refs WHERE turn_id=? ORDER BY rowid LIMIT 1', firstBatch.frameworkTurnId)?.ref;
  assert.ok(firstRef);
  await sendFrom(bus, lead, one, 'second');
  const beforeDuplicate = bus.telemetryConversation(group.id, lead.id, one.id).batches.length;
  for (let i = 0; i < 2; i += 1) {
    bus.telemetry.record({
      groupId: group.id,
      executorKind: 'member',
      executorId: firstBatch.executor.memberId,
      endpointId: firstBatch.physicalSession.endpointId,
      sessionKey: firstBatch.physicalSession.sessionKey,
      turnId: firstBatch.frameworkTurnId,
      turnKind: 'member',
      host: 'fake',
      hostSessionId: firstBatch.physicalSession.hostSessionId,
      observation: telemetryObservation({
        source: 'fake.old',
        scope: 'turn',
        aggregation: 'delta',
        nativeTurnId: firstRef,
        usage: { inputTokensTotal: 777, outputTokens: 1, totalTokens: 778 },
        attempt: { id: 'old-attempt', state: 'succeeded' },
      }),
    });
  }
  const oldRows = bus.store.all("SELECT turn_id FROM telemetry_observations WHERE group_id=? AND source='fake.old'", group.id);
  assert.equal(oldRows.length, 1);
  assert.equal(oldRows[0].turn_id, firstBatch.frameworkTurnId);
  const result = bus.telemetryConversation(group.id, lead.id, one.id);
  assert.equal(result.batches.length, beforeDuplicate);
  assert.equal(result.batches.find(batch => batch.batchId === firstBatch.batchId).metrics.inputTokensTotal.value, 777);
});

test('context ratio is null when the model route is unknown', async t => {
  const { bus, group, members } = fixture(t, (ctx, { counter, nativeTurnId }) => {
    emitDefault(ctx, counter, nativeTurnId);
    ctx.onTelemetry(telemetryObservation({
      source: 'fake.context.no-model', scope: 'request', aggregation: 'snapshot', nativeTurnId,
      context: { lastRequestInputTokens: 100, contextWindowTokens: 1000 },
    }));
    ctx.onAccepted();
    return 'ok';
  });
  const [lead, one] = members;
  await until(() => bus.running.size === 0);
  await sendFrom(bus, lead, one, 'unknown route');
  const batch = bus.telemetryConversation(group.id, lead.id, one.id).batches[0];
  assert.equal(batch.contextReference.lastRequestInputRatio.value, null);
  assert.equal(batch.contextReference.lastRequestInputRatio.quality, 'unknown');
  assert.equal(batch.contextReference.lastRequestInputRatio.missingReason, 'scope_mismatch');
  assert.equal(batch.contextReference.model, null);
});

test('context ratio is withheld unless input and window samples share the same model route', async t => {
  const { bus, group, members } = fixture(t, (ctx, { counter, nativeTurnId }) => {
    emitDefault(ctx, counter, nativeTurnId);
    ctx.onTelemetry(telemetryObservation({
      source: 'fake.context.input', scope: 'request', aggregation: 'snapshot', nativeTurnId,
      context: { lastRequestInputTokens: 100, model: { provider: 'p', model: 'route-a', source: 'fake', observedAt: new Date().toISOString() } },
    }));
    ctx.onTelemetry(telemetryObservation({
      source: 'fake.context.window', scope: 'request', aggregation: 'snapshot', nativeTurnId,
      context: { contextWindowTokens: 1000, model: { provider: 'p', model: 'route-b', source: 'fake', observedAt: new Date().toISOString() } },
    }));
    ctx.onAccepted();
    return 'ok';
  });
  const [lead, one] = members;
  await until(() => bus.running.size === 0);
  await sendFrom(bus, lead, one, 'route mismatch');
  const batch = bus.telemetryConversation(group.id, lead.id, one.id).batches[0];
  assert.equal(batch.contextReference.lastRequestInputRatio.value, null);
  assert.equal(batch.contextReference.lastRequestInputRatio.quality, 'unknown');
  assert.equal(batch.contextReference.lastRequestInputRatio.missingReason, 'scope_mismatch');
  assert.equal(batch.contextReference.model, null);
});

test('session reset starts a new physical session and does not carry the old baseline', async t => {
  const { bus, group, members } = fixture(t);
  const [lead, one] = members;
  await until(() => bus.running.size === 0);
  const endpoint = bus.store.endpoint(one.id, `pair:${lead.id}`);
  await sendFrom(bus, lead, one, 'before reset');
  const before = bus.telemetryMembers(group.id).members.find(member => member.executor.memberId === one.id);
  assert.equal(before.physicalSessionCount, 1);
  bus.resetSession(endpoint.id, 'telemetry reset test');
  await sendFrom(bus, lead, one, 'after reset');
  const after = bus.telemetryMembers(group.id).members.find(member => member.executor.memberId === one.id);
  assert.equal(after.physicalSessionCount, 2);
  assert.equal(after.physicalSessions.filter(session => session.status === 'reset').length, 1);
  assert.ok(after.physicalSessions.some(session => session.status === 'active'));
  assert.deepEqual(new Set(after.physicalSessions.map(session => session.instanceId)).size, 2);
});

test('merged delivery is counted once and excluded from single-source subtotals', async t => {
  let release;
  let blocked = false;
  const { bus, group, members } = fixture(t, (ctx, { counter, nativeTurnId }) => {
    emitDefault(ctx, counter, nativeTurnId);
    ctx.onAccepted();
    if (!blocked) {
      blocked = true;
      return new Promise(resolve => { release = () => resolve('ok'); });
    }
    return 'ok';
  });
  const [lead, one, two] = members;
  await until(() => bus.running.size === 0);
  const leadEndpoint = bus.store.endpoint(lead.id, 'coordination');
  const oneEndpoint = bus.store.endpoint(one.id, `pair:${lead.id}`);
  const twoEndpoint = bus.store.endpoint(two.id, `pair:${lead.id}`);
  await bus.tool(oneEndpoint.id, oneEndpoint.key, 'send', { to: lead.id, text: 'running' });
  await until(() => bus.running.size >= 1);
  await bus.tool(oneEndpoint.id, oneEndpoint.key, 'send', { to: lead.id, text: 'queued one' });
  await bus.tool(twoEndpoint.id, twoEndpoint.key, 'send', { to: lead.id, text: 'queued two' });
  release();
  await until(() => bus.running.size === 0);
  const coordination = bus.telemetryCoordination(group.id);
  const shared = coordination.batches.find(batch => batch.inputBatch.merge.sharedSources);
  assert.ok(shared, 'expected a merged delivery batch');
  assert.equal(shared.inputBatch.merge.merged, true);
  assert.equal(shared.inputBatch.merge.countedOnce, true);
  assert.equal(shared.inputBatch.merge.splitBySource, false);
  assert.equal(shared.inputBatch.merge.exclusiveSubtotal, false);
  assert.equal(shared.inputBatch.sourceActors.length, 2);
  assert.ok(coordination.summary.sharedSourceBatchIds.includes(shared.batchId));
  assert.ok(coordination.summary.mergedBatchIds.includes(shared.batchId));
  assert.ok(!coordination.summary.singleSourceBatchIds.includes(shared.batchId));
  assert.equal(shared.physicalSession.context, 'coordination');
  assert.equal(shared.physicalSession.peer, null);
  for (const subtotal of coordination.summary.sourceSubtotals) {
    assert.ok(!subtotal.includedBatchIds.includes(shared.batchId));
    assert.ok(subtotal.excludedMergedBatchIds.includes(shared.batchId) || !subtotal.includedBatchIds.length);
  }
  const totalBatches = coordination.batches.length;
  assert.equal(coordination.summary.coverage.batchCount, totalBatches);
  assert.ok(leadEndpoint.id);
});

test('a merged batch from one source is still excluded from single-source subtotals', async t => {
  let release;
  let blocked = false;
  const { bus, group, members } = fixture(t, (ctx, { counter, nativeTurnId }) => {
    emitDefault(ctx, counter, nativeTurnId);
    ctx.onAccepted();
    if (!blocked) {
      blocked = true;
      return new Promise(resolve => { release = () => resolve('ok'); });
    }
    return 'ok';
  });
  const [lead, one] = members;
  await until(() => bus.running.size === 0);
  const oneEndpoint = bus.store.endpoint(one.id, `pair:${lead.id}`);
  await bus.tool(oneEndpoint.id, oneEndpoint.key, 'send', { to: lead.id, text: 'running' });
  await until(() => bus.running.size >= 1);
  await bus.tool(oneEndpoint.id, oneEndpoint.key, 'send', { to: lead.id, text: 'queued one' });
  await bus.tool(oneEndpoint.id, oneEndpoint.key, 'send', { to: lead.id, text: 'queued two' });
  release();
  await until(() => bus.running.size === 0);
  const coordination = bus.telemetryCoordination(group.id);
  const merged = coordination.batches.find(batch => batch.inputBatch.merge.merged && !batch.inputBatch.merge.sharedSources);
  assert.ok(merged, 'expected a same-source merged batch');
  assert.ok(coordination.summary.mergedBatchIds.includes(merged.batchId));
  assert.ok(!coordination.summary.singleSourceBatchIds.includes(merged.batchId));
  for (const subtotal of coordination.summary.sourceSubtotals) {
    assert.ok(!subtotal.includedBatchIds.includes(merged.batchId));
  }
});

test('pagination only pages batches while totals and summary cover the full range', async t => {
  const { bus, group, members } = fixture(t);
  const [lead, one] = members;
  await until(() => bus.running.size === 0);
  for (let i = 0; i < 4; i += 1) await sendFrom(bus, lead, one, `page ${i}`);
  const full = bus.telemetryConversation(group.id, lead.id, one.id);
  const page = bus.telemetryConversation(group.id, lead.id, one.id, { limit: 1 });
  assert.equal(page.batches.length, 1);
  assert.ok(page.nextCursor);
  assert.deepEqual(page.summary.executorTotals, full.summary.executorTotals);
  const second = bus.telemetryConversation(group.id, lead.id, one.id, { limit: 1, cursor: page.nextCursor });
  assert.equal(second.batches.length, 1);
  assert.notEqual(second.batches[0].batchId, page.batches[0].batchId);
});


test('multi-step deltas sum once and a failed attempt keeps its own partial metrics', async t => {
  const { bus, group, members } = fixture(t, (ctx, { nativeTurnId }) => {
    ctx.onTelemetry(telemetryObservation({
      source: 'fake.step', scope: 'step', aggregation: 'delta', nativeTurnId, stepId: '1',
      usage: { inputTokensTotal: 100, outputTokens: 2, totalTokens: 102 },
      completeness: { inputTokensTotal: 'complete', outputTokens: 'complete', totalTokens: 'complete' },
      attempt: { id: 'attempt-a', state: 'succeeded' },
    }));
    ctx.onTelemetry(telemetryObservation({
      source: 'fake.step', scope: 'step', aggregation: 'delta', nativeTurnId, stepId: '2',
      usage: { inputTokensTotal: 50, outputTokens: 1, totalTokens: 51 },
      completeness: { inputTokensTotal: 'complete', outputTokens: 'complete', totalTokens: 'complete' },
      attempt: { id: 'attempt-a', state: 'succeeded' },
    }));
    ctx.onTelemetry(telemetryObservation({
      source: 'fake.step', scope: 'step', aggregation: 'delta', nativeTurnId, stepId: '3',
      usage: { inputTokensTotal: 30, outputTokens: null },
      completeness: { inputTokensTotal: 'partial', outputTokens: 'unknown' },
      attempt: { id: 'attempt-b', state: 'failed' },
      anomalies: [{ code: 'anomaly', fields: ['outputTokens'], detail: '重试部分用量', observedAt: new Date().toISOString(), raw: { outputTokens: null } }],
    }));
    ctx.onAccepted();
    return 'ok';
  });
  const [lead, one] = members;
  await until(() => bus.running.size === 0);
  await sendFrom(bus, lead, one, 'steps');
  const batch = bus.telemetryConversation(group.id, lead.id, one.id).batches[0];
  assert.equal(batch.metrics.inputTokensTotal.value, 180);
  assert.equal(batch.metrics.outputTokens.value, 3);
  assert.equal(batch.metrics.totalTokens.value, 183);
  assert.equal(batch.metrics.outputTokens.completeness, 'partial');
  assert.equal(batch.completeness, 'partial');
  assert.equal(batch.attempts.length, 2);
  assert.equal(batch.attempts.find(attempt => attempt.attemptId === 'attempt-a').metrics.inputTokensTotal.value, 150);
  assert.equal(batch.attempts.find(attempt => attempt.attemptId === 'attempt-b').state, 'failed');
  assert.ok(batch.attempts.find(attempt => attempt.attemptId === 'attempt-b').metrics.inputTokensTotal.value === 30);
  assert.ok(batch.anomalies.length >= 1);
});

test('multi-bucket sums are declared derived and direct fields stay direct', () => {
  const claude = telemetryCapabilitiesFor('claude').metrics;
  assert.equal(claude.inputTokensTotal.capability, 'derived');
  assert.equal(claude.lastRequestInputTokens.capability, 'derived');
  assert.equal(claude.totalTokens.capability, 'derived');
  assert.equal(claude.cacheReadTokens.capability, 'direct');
  assert.equal(claude.outputTokens.capability, 'direct');
  const dsh = telemetryCapabilitiesFor('dsh').metrics;
  assert.equal(dsh.inputTokensTotal.capability, 'derived');
  assert.equal(dsh.totalTokens.capability, 'direct');
  assert.equal(dsh.lastRequestInputTokens.capability, 'direct');
  const codex = telemetryCapabilitiesFor('codex').metrics;
  assert.equal(codex.inputTokensTotal.capability, 'direct');
  assert.equal(codex.uncachedInputTokens.capability, 'derived');
  for (const host of [claude, dsh, codex]) {
    assert.equal(Object.keys(host).length, 12);
    for (const field of Object.values(host)) {
      assert.ok(['direct', 'derived', 'unsupported'].includes(field.capability));
      assert.ok(Array.isArray(field.requires));
    }
  }
});

test('telemetry HTTP routes are read-only JSON and errors use JSON {error}', async t => {
  const { bus, group, members, directory, cleanup } = fixture(t);
  const [, one, two] = members;
  await until(() => bus.running.size === 0);
  await sendFrom(bus, one, two, 'http');
  await bus.close();
  const server = await startServer({ directory, hosts: new Map([['fake', { async run() { return 'unused'; } }]]) });
  cleanup.push(() => server.close());
  const ok = await fetch(`${server.url}api/telemetry/conversation?group=${group.id}&member=${one.id}&peer=${two.id}`);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type'), /application\/json/);
  const body = await ok.json();
  assert.equal(body.readOnly, true);
  assert.equal(body.executors.length, 2);
  const missing = await fetch(`${server.url}api/telemetry/conversation?group=${group.id}&member=missing&peer=${one.id}`);
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get('content-type'), /application\/json/);
  const failure = await missing.json();
  assert.equal(typeof failure.error, 'string');
  const capabilities = await fetch(`${server.url}api/telemetry/capabilities?group=${group.id}`);
  assert.equal(capabilities.status, 200);
  assert.equal((await capabilities.json()).hosts[0].host, 'fake');
});

test('Codex adapter emits turn deltas and host timing through onTelemetry', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-codex-telemetry-'));
  const fake = join(directory, 'fake-codex.mjs');
  writeFileSync(fake, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
createInterface({ input: process.stdin }).on('line', line => {
  const row = JSON.parse(line);
  if (row.method === 'initialize') return send({ id: row.id, result: {} });
  if (row.method === 'config/read') return send({ id: row.id, result: { config: { mcp_servers: {} } } });
  if (row.method === 'thread/start') return send({ id: row.id, result: { thread: { id: 'thread-1' }, model: 'test', modelProvider: 'test', reasoningEffort: 'low' } });
  if (row.method === 'turn/start') {
    send({ id: row.id, result: { turn: { id: 'turn-1' } } });
    setImmediate(() => {
      const tokenUsage = { total: { totalTokens: 130, inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: 5, outputTokens: 5, reasoningOutputTokens: 0 }, last: { totalTokens: 130, inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: 5, outputTokens: 5, reasoningOutputTokens: 0 }, modelContextWindow: 1000 };
      send({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', turnId: 'turn-1', tokenUsage } });
      send({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', turnId: 'turn-1', tokenUsage } });
      send({ method: 'item/reasoning/textDelta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'reasoning-1', delta: '推' } });
      send({ method: 'item/reasoning/textDelta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'reasoning-1', delta: '理' } });
      send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: '已' } });
      send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: '完成' } });
      send({ method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'tool-1', type: 'dynamicToolCall', tool: 'agent_team_send', arguments: { to: 'peer', text: 'tool message' } } } });
      send({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'message-1', type: 'agentMessage', text: '已完成' } } });
      send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', durationMs: 700 } } });
    });
    return;
  }
});
`);
  chmodSync(fake, 0o700);
  const host = createCodexHost({ command: fake });
  t.after(async () => { await host.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
  const telemetry = [], deltas = [], toolDeltas = [], reasonings = [];
  const output = await host.run({
    endpoint: { id: 'endpoint', key: 'key', session: null },
    turnId: 'framework-turn', workspace: directory, prompt: 'metrics', instructions: 'follow',
    tools: [], policy: { mode: 'communication', allowShell: false }, previousPolicy: null,
    signal: new AbortController().signal,
    onSession() {}, onAccepted() {}, onNativeTurn() {}, onModel() {}, onPolicy() {}, onEvent() {},
    onTextDelta(text, metadata) { deltas.push({ text, metadata }); },
    onReasoningDelta(text, metadata) { reasonings.push({ text, metadata }); },
    onToolCallDelta(delta) { toolDeltas.push(delta); },
    onTelemetry(observation) { telemetry.push(observation); },
  });
  assert.equal(output, '已完成');
  assert.deepEqual(deltas.map(item => item.text), ['已', '完成']);
  assert.deepEqual(reasonings.map(item => item.text), ['推', '理']);
  assert.equal(reasonings[0].metadata.itemId, 'reasoning-1');
  assert.equal(deltas[0].metadata.itemId, 'message-1');
  assert.equal(toolDeltas[0].name, 'send');
  assert.deepEqual(JSON.parse(toolDeltas[0].argumentsDelta), {
    to: 'peer',
    text: 'tool message',
  });
  const usage = telemetry.find(observation => observation.source === 'codex.thread_token_usage');
  assert.equal(usage.usage.inputTokensTotal, 100);
  assert.equal(usage.usage.uncachedInputTokens, 75);
  assert.equal(usage.usage.cacheReadTokens, 20);
  assert.equal(usage.usage.cacheWriteTokens, 5);
  assert.equal(usage.usage.outputTokens, 5);
  assert.ok(telemetry.filter(observation => observation.source === 'codex.thread_token_usage').length >= 1);
  assert.equal(telemetry.find(observation => observation.source === 'codex.turn_completed').timing.hostTurnWallMs, 700);
  assert.equal(host.telemetryCapabilities.metrics.inputTokensTotal.capability, 'direct');
  assert.equal(host.telemetryCapabilities.metrics.uncachedInputTokens.capability, 'derived');
});

test('DSH adapter consumes telemetry events and projections from its observer plugin', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-dsh-telemetry-'));
  const fake = join(directory, 'fake-dsh.mjs');
  writeFileSync(fake, `#!/usr/bin/env node
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
send({ type: 'session', sessionId: 'dsh-session-1' });
send({ type: 'assistant_delta', text: 'o', turn: 1, step: 1 });
send({ type: 'framework.telemetry.event', event: 'turn/start', at: 1000, turn: 1 });
send({ type: 'framework.telemetry.projection', key: 'contextPressure', value: { pressureTokens: 700, contextWindow: 1000 } });
send({ type: 'framework.telemetry.event', event: 'assistant/message', at: 1100, turn: 1, step: 1, usage: { inputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 0, outputTokens: 5, totalTokens: 125 } });
send({ type: 'framework.telemetry.event', event: 'turn/end', at: 1300, turn: 1, reason: 'completed' });
send({ type: 'assistant_delta', text: 'k', turn: 1, step: 1 });
send({ type: 'final', text: 'ok' });
send({ type: 'status', phase: 'turn_end', reason: { kind: 'completed' } });
`);
  chmodSync(fake, 0o700);
  const host = createDshHost({ command: fake, directory, socketPath: join(directory, 'unused.sock') });
  t.after(async () => { await host.close?.(); rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
  const telemetry = [], deltas = [];
  const output = await host.run({
    endpoint: { id: 'endpoint', key: 'key', session: null },
    turnId: 'framework-turn', workspace: directory, prompt: 'metrics', instructions: 'follow',
    tools: [], policy: { mode: 'communication', allowShell: false }, previousPolicy: null,
    signal: new AbortController().signal,
    onSession() {}, onAccepted() {}, onNativeTurn() {}, onModel() {}, onPolicy() {}, onEvent() {},
    onTextDelta(text, metadata) { deltas.push({ text, metadata }); },
    onTelemetry(observation) { telemetry.push(observation); },
  });
  assert.equal(output, 'ok');
  assert.deepEqual(deltas.map(item => item.text), ['o', 'k']);
  assert.equal(deltas[0].metadata.nativeTurnId, '1');
  const usage = telemetry.find(observation => observation.source === 'dsh.assistant_message_usage');
  assert.equal(usage.usage.inputTokensTotal, 120);
  assert.equal(usage.usage.uncachedInputTokens, 100);
  assert.equal(usage.usage.cacheReadTokens, 20);
  assert.equal(usage.usage.outputTokens, 5);
  assert.equal(usage.quality.inputTokensTotal, 'derived');
  assert.equal(usage.quality.totalTokens, 'host_reported');
  const context = telemetry.find(observation => observation.source === 'dsh.context_pressure');
  assert.equal(context.context.lastRequestInputTokens, 700);
  assert.equal(context.context.contextWindowTokens, 1000);
  assert.equal(telemetry.find(observation => observation.source === 'dsh.turn_time').timing.hostTurnWallMs, 300);
  assert.equal(host.telemetryCapabilities.metrics.hostTurnWallMs.capability, 'direct');
  assert.equal(host.telemetryCapabilities.metrics.inputTokensTotal.capability, 'derived');
});

test('DSH context pressure waits for model selection in either event order', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-dsh-model-route-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const run = async (rows, name) => {
    const fake = join(directory, `${name}.mjs`);
    writeFileSync(fake, `#!/usr/bin/env node
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
send({ type: 'session', sessionId: '${name}-session' });
${rows}
send({ type: 'final', text: 'ok' });
send({ type: 'status', phase: 'turn_end', reason: { kind: 'completed' } });
`);
    chmodSync(fake, 0o700);
    const host = createDshHost({ command: fake, directory, socketPath: join(directory, 'unused.sock') });
    const telemetry = [];
    await host.run({
      endpoint: { id: 'endpoint', key: 'key', session: null },
      turnId: 'framework-turn', workspace: directory, prompt: 'metrics', instructions: 'follow',
      tools: [], policy: { mode: 'communication', allowShell: false }, previousPolicy: null,
      signal: new AbortController().signal,
      onSession() {}, onAccepted() {}, onEvent() {}, onTextDelta() {},
      onTelemetry(observation) { telemetry.push(observation); },
    });
    return telemetry.filter(observation => observation.source === 'dsh.context_pressure');
  };
  const pressure = `send({ type: 'framework.telemetry.projection', key: 'contextPressure', value: { pressureTokens: 700, contextWindow: 1000 } });`;
  const selection = `send({ type: 'framework.model.selection', provider: 'deepseek-official', model: 'deepseek-flash' });`;

  const lateModel = await run(`${pressure}\n${selection}`, 'pressure-first');
  assert.equal(lateModel.length, 1);
  assert.equal(lateModel[0].context.model.provider, 'deepseek-official');
  assert.equal(lateModel[0].context.model.model, 'deepseek-flash');
  assert.equal(lateModel[0].context.model.source, 'dsh.context_pressure');

  const knownModel = await run(`${selection}\n${pressure}`, 'selection-first');
  assert.equal(knownModel.length, 1);
  assert.equal(knownModel[0].context.model.model, 'deepseek-flash');

  const noModel = await run(pressure, 'no-selection');
  assert.equal(noModel.length, 1);
  assert.equal(noModel[0].context.lastRequestInputTokens, 700);
  assert.equal(noModel[0].context.model, undefined);
});

test('DSH context pressure feeds a non-null context ratio into the batch reference', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-dsh-batch-'));
  const fake = join(directory, 'fake-dsh.mjs');
  writeFileSync(fake, `#!/usr/bin/env node
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
send({ type: 'session', sessionId: 'dsh-batch-session' });
send({ type: 'framework.telemetry.projection', key: 'contextPressure', value: { pressureTokens: 700, contextWindow: 1000 } });
send({ type: 'framework.model.selection', provider: 'deepseek-official', model: 'deepseek-flash' });
send({ type: 'framework.telemetry.event', event: 'assistant/message', at: 1100, turn: 1, step: 1, usage: { inputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 0, outputTokens: 5, totalTokens: 125 } });
send({ type: 'final', text: 'ok' });
send({ type: 'status', phase: 'turn_end', reason: { kind: 'completed' } });
`);
  chmodSync(fake, 0o700);
  const dsh = createDshHost({ command: fake, directory, socketPath: join(directory, 'unused.sock') });
  const bus = new Bus({ directory, hosts: new Map([['fake', fakeHost()], ['dsh', dsh]]) });
  const group = createTestGroup(bus, {
    name: 'dsh-batch-group',
    workspace: directory,
    lead: { name: 'lead', host: 'fake' },
    members: [{ name: 'one', host: 'dsh' }],
  });
  t.after(async () => {
    if (!bus.closing) await bus.close();
    await dsh.close?.();
    rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  await until(() => bus.running.size === 0);
  const [lead, one] = bus.members(group.id);
  await sendFrom(bus, lead, one, 'metrics');
  const conversation = bus.telemetryConversation(group.id, one.id, lead.id);
  const executor = conversation.executors.find(item => item.executor.memberId === one.id);
  assert.equal(executor.contextReference.model.model, 'deepseek-flash');
  assert.equal(executor.contextReference.model.provider, 'deepseek-official');
  assert.equal(executor.contextReference.lastRequestInputRatio.value, 0.7);
  assert.notEqual(executor.contextReference.sampleTurnId, null);
});

test('DSH observer forwards text and reasoning chunks and deduplicates committed text in the adapter', async t => {
  assert.equal(dshSessionEventFrame({
    type: 'assistant/live-chunk',
    time: 100,
    data: { turn: 1, step: 2, chunk: { type: 'text-delta', index: 3, text: 'stream' } },
  }), null);
  async function* chunks() {
    yield { type: 'text-delta', index: 3, text: 'stream' };
    yield { type: 'reasoning-delta', index: 4, text: 'thinking out' };
    yield {
      type: 'tool-call-delta',
      index: 5,
      id: 'tool-1',
      name: 'send',
      argumentsDelta: '{"to":"peer","text":"hello"}',
    };
  }
  const frames = [];
  for await (const _chunk of observeTextStream(chunks(), frame => frames.push(frame), {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
  })) {
    // Consume the wrapped iterator as the DSH loop would.
  }
  assert.deepEqual(frames, [
    {
      type: 'framework.text.delta',
      index: 3,
      text: 'stream',
      provider: 'deepseek-official',
      model: 'deepseek-flash',
    },
    {
      type: 'framework.reasoning.delta',
      index: 4,
      text: 'thinking out',
      provider: 'deepseek-official',
      model: 'deepseek-flash',
    },
    {
      type: 'framework.tool.delta',
      callId: 'tool-1',
      name: 'send',
      index: 5,
      argumentsDelta: '{"to":"peer","text":"hello"}',
      provider: 'deepseek-official',
      model: 'deepseek-flash',
    },
  ]);

  const directory = mkdtempSync(join(tmpdir(), 'agent-dsh-live-stream-'));
  const fake = join(directory, 'fake-dsh.mjs');
  writeFileSync(fake, `#!/usr/bin/env node
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
send({ type: 'session', sessionId: 'dsh-session-live' });
send({ type: 'framework.reasoning.delta', turn: 1, step: 1, text: 'th' });
send({ type: 'framework.reasoning.delta', turn: 1, step: 1, text: 'ink' });
send({ type: 'framework.text.delta', turn: 1, step: 1, text: 'live ' });
send({ type: 'framework.text.delta', turn: 1, step: 1, text: 'text' });
send({ type: 'framework.tool.delta', callId: 'tool-live', name: 'send', index: 1, argumentsDelta: '{"to":"peer","text":"he' });
send({ type: 'tool_call', callId: 'tool-live', tool: 'send', input: { to: 'peer', text: 'hello' } });
send({ type: 'text', text: 'live text' });
send({ type: 'final', text: 'live text' });
send({ type: 'status', phase: 'turn_end', reason: { kind: 'completed' } });
`);
  chmodSync(fake, 0o700);
  const host = createDshHost({ command: fake, directory, socketPath: join(directory, 'unused.sock') });
  t.after(() => { try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ } });
  const deltas = [], toolDeltas = [], reasonings = [];
  const output = await host.run({
    endpoint: { id: 'endpoint', key: 'key', session: null },
    turnId: 'framework-turn', workspace: directory, prompt: 'stream', instructions: 'follow',
    tools: [], policy: { mode: 'communication', allowShell: false }, previousPolicy: null,
    signal: new AbortController().signal,
    onSession() {}, onAccepted() {}, onNativeTurn() {}, onModel() {}, onPolicy() {}, onEvent() {},
    onTextDelta(text, metadata) { deltas.push({ text, metadata }); },
    onReasoningDelta(text, metadata) { reasonings.push({ text, metadata }); },
    onToolCallDelta(delta) { toolDeltas.push(delta); },
  });
  assert.equal(output, 'live text');
  assert.deepEqual(deltas.map(item => item.text), ['live ', 'text']);
  assert.deepEqual(reasonings.map(item => item.text), ['th', 'ink']);
  assert.equal(reasonings[0].metadata.nativeTurnId, '1');
  assert.equal(reasonings[0].metadata.step, '1');
  assert.deepEqual(toolDeltas.map(item => item.argumentsDelta), [
    '{"to":"peer","text":"he',
    '{"to":"peer","text":"hello"}',
  ]);
  assert.equal(toolDeltas[1].complete, true);
});

test('telemetry actor projections resolve external principals as external_agent', async t => {
  const { bus, group, members } = fixture(t);
  const created = new Date().toISOString();
  insertPrincipal(bus.store, { id: 'external-actor', name: '外部主控乙', created });
  assert.deepEqual(bus.telemetry._actor('external-actor'), {
    actorId: 'external-actor',
    actorName: '外部主控乙',
    kind: 'external_agent',
  });
  assert.deepEqual(bus.telemetry._recipientActor(group.id, 'external-actor'), {
    recipientId: 'external-actor',
    recipientName: '外部主控乙',
    recipientKind: 'external_agent',
  });
  // 既有身份解析顺序保持不变:成员优先于外部 principal。
  assert.deepEqual(bus.telemetry._actor(members[0].id), {
    actorId: members[0].id,
    actorName: members[0].name,
    kind: 'member',
  });
});
});

describe('theme-packs', () => {
async function setup(t) {
  return serverScenario(t);
}

// 服务端只做结构校验(可解析、键数、值类型/长度),不检查颜色语义。
function tokenMap() {
  const tokens = {};
  for (let index = 0; index < 29; index += 1) tokens[`token-${index}`] = `oklch(0.5 0 ${index})`;
  return JSON.stringify(tokens);
}

test('theme packs CRUD via bus', async t => {
  const { server } = await setup(t);
  const bus = server.bus;

  const created = bus.createThemePack({ name: '我的主题', light: tokenMap(), dark: tokenMap() });
  assert.equal(created.name, '我的主题');
  assert.ok(created.id, '服务端生成 id');
  assert.equal(typeof created.light, 'string');
  assert.equal(bus.themePacks().length, 1);

  // 重名拒绝 + 名称校验
  assert.throws(() => bus.createThemePack({ name: '我的主题', light: tokenMap(), dark: tokenMap() }), /已存在/);
  assert.throws(() => bus.createThemePack({ name: '  ', light: tokenMap(), dark: tokenMap() }), /名称/);
  assert.throws(() => bus.createThemePack({ name: 'x'.repeat(61), light: tokenMap(), dark: tokenMap() }), /名称/);

  // 结构校验:light/dark 必须是可解析 JSON、值必须是字符串
  assert.throws(() => bus.createThemePack({ name: '坏包', light: '不是json', dark: tokenMap() }), /有效 JSON/);
  assert.throws(() => bus.createThemePack({ name: '坏包', light: tokenMap(), dark: '{"a":1}' }), /非法变量值/);

  // 删除 + 不存在防护;内置主题不是库行,天然删不到
  assert.deepEqual(bus.deleteThemePack(created.id), { deleted: created.id });
  assert.throws(() => bus.deleteThemePack(created.id), /不存在/);
  assert.throws(() => bus.deleteThemePack('classic'), /不存在/);
});

test('theme packs HTTP routes', async t => {
  const { url } = await setup(t);

  const create = await fetch(new URL('/api/theme-packs', url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'HTTP主题', light: tokenMap(), dark: tokenMap() }),
  });
  assert.equal(create.status, 200);
  const pack = await create.json();
  assert.equal(pack.name, 'HTTP主题');

  const list = await (await fetch(new URL('/api/theme-packs', url))).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'HTTP主题');

  const bad = await fetch(new URL('/api/theme-packs', url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'HTTP主题', light: tokenMap(), dark: tokenMap() }),
  });
  assert.equal(bad.status, 400);

  const removed = await fetch(new URL(`/api/theme-packs/${encodeURIComponent(pack.id)}/delete`, url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(removed.status, 200);

  const missing = await fetch(new URL(`/api/theme-packs/${encodeURIComponent(pack.id)}/delete`, url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(missing.status, 400);
});
});

describe('default-workspace', () => {
test('default panel workspace adapts to the platform and documents presence', () => {
  // 路径拼接跟随运行平台的分隔符:断言用 join 构造,不写死分隔符。
  // macOS/Windows:Documents 下的用户可见目录。
  assert.equal(
    defaultPanelWorkspace({ home: '/Users/demo', platform: 'darwin' }),
    join('/Users/demo', 'Documents', 'AgentTeam'),
  );
  assert.equal(
    defaultPanelWorkspace({ home: 'C:\\Users\\demo', platform: 'win32' }),
    join('C:\\Users\\demo', 'Documents', 'AgentTeam'),
  );

  // Linux:Documents 缺席(无桌面环境)时回退 XDG 数据目录。
  assert.equal(
    defaultPanelWorkspace({ home: '/home/demo', platform: 'linux' }),
    join('/home/demo', '.local', 'share', 'agent-team', 'workspace'),
  );

  // Linux 桌面环境存在 Documents:同样使用用户可见目录。
  const desktopHome = mkdtempSync(join(tmpdir(), 'agent-home-'));
  try {
    mkdirSync(join(desktopHome, 'Documents'));
    assert.equal(
      defaultPanelWorkspace({ home: desktopHome, platform: 'linux' }),
      join(desktopHome, 'Documents', 'AgentTeam'),
    );
  } finally {
    try { rmSync(desktopHome, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  }
});

test('ensureDefaultPanelWorkspace creates the directory idempotently', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-home-'));
  try {
    const first = ensureDefaultPanelWorkspace({ home, platform: 'darwin' });
    assert.equal(first, join(home, 'Documents', 'AgentTeam'));
    assert.ok(existsSync(first));
    // 再次调用不抛错(幂等)。
    assert.equal(ensureDefaultPanelWorkspace({ home, platform: 'darwin' }), first);
  } finally {
    try { rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  }
});
});
