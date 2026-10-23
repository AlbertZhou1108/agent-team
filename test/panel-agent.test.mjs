import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../src/bus.mjs';
import { panelToolsFor, validatePanelTool } from '../src/panel-tools.mjs';
import { confirmedGroup, testContract } from './helpers.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(fn) {
  for (let index = 0; index < 400; index++) {
    if (fn()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('timeout');
}

function hostFixture(calls = []) {
  return {
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
      calls.push({
        endpoint: context.endpoint.id,
        context: context.endpoint.context,
        groupId: context.endpoint.group_id,
        prompt: context.prompt,
      });
      context.onSession(context.endpoint.session ?? context.endpoint.id);
      if (context.endpoint.context === 'profile') {
        await context.onTool('profile_set', { text: 'test profile' });
      }
      context.onAccepted();
      return context.endpoint.context.startsWith('panel-') ? 'panel reply' : 'done';
    },
  };
}

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-panel-'));
  const calls = [];
  const host = hostFixture(calls);
  const bus = new Bus({ directory, hosts: new Map([['fake', host]]) });
  bus.start();
  t.after(async () => {
    await bus.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, calls, bus };
}

async function createAgent(bus) {
  return bus.createPanelAgent({
    name: 'Panel Agent',
    host: 'fake',
    model_provider: 'fake-provider',
    model: 'fake-model',
    reasoning_effort: 'low',
  });
}

test('Panel management tools expose structured commands and accept a nested cancellation', async t => {
  const tools = panelToolsFor('private');
  const workItemTool = tools.find(tool => tool.name === 'work_item_update');
  const finishTool = tools.find(tool => tool.name === 'team_finish');
  assert.equal(tools.some(tool => tool.name === 'panel_update_publish'), false);
  assert.equal(
    panelToolsFor('coordination').some(tool => tool.name === 'panel_update_publish'),
    true,
  );
  assert.equal(
    Object.hasOwn(
      panelToolsFor('coordination')
        .find(tool => tool.name === 'panel_update_publish')
        .inputSchema.properties,
      'immediate',
    ),
    false,
  );
  assert.equal(workItemTool.inputSchema.properties.command.type, 'object');
  assert.match(workItemTool.description, /cancellation\.kind/);
  assert.match(finishTool.description, /coverage/);
  assert.doesNotThrow(() => validatePanelTool('private', 'work_item_update', {
    groupId: 'group-1',
    command: {
      id: 'probe-1',
      itemRevision: 1,
      state: 'cancelled',
      cancellation: {
        kind: 'irrelevant',
        reason: '临时探针与团队目标无关',
      },
    },
    revision: 1,
    operationId: 'cancel-probe',
  }));
  assert.doesNotThrow(() => validatePanelTool('private', 'work_item_update', {
    groupId: 'group-1',
    command: JSON.stringify({
      id: 'probe-1',
      itemRevision: 1,
      state: 'cancelled',
      cancellation: { kind: 'irrelevant', reason: '临时探针与团队目标无关' },
    }),
    revision: 1,
    operationId: 'cancel-probe-json',
  }));
  assert.throws(() => validatePanelTool('private', 'work_item_update', {
    groupId: 'group-1',
    command: {
      id: 'probe-1',
      itemRevision: 1,
      reviews: ['not-a-review'],
    },
    revision: 1,
    operationId: 'invalid-review',
  }), /command\.reviews\[0\]类型无效/);

  const { bus, directory } = await fixture(t);
  const group = confirmedGroup(bus, {
    name: 'structured panel command',
    workspace: directory,
    lead: { name: 'lead', host: 'fake' },
    members: [{ name: 'worker', host: 'fake' }],
  });
  await until(() => !bus.running.size);
  const state = await createAgent(bus);
  bus.takeoverTeam(group.id, 0);
  const worker = bus.members(group.id).find(member => member.name === 'worker');
  const coordination = bus.store.panelSession(state.agent.id, 'coordination', group.id);
  const provenance = { activeTeamId: group.id };
  let result = await bus.panelTool(coordination.id, coordination.key, 'work_item_update', {
    groupId: group.id,
    command: {
      title: '状态机探针',
      purpose: '验证结构化命令',
      standard: '不派发、不交付',
      participants: [{ memberId: worker.id, role: 'collaborator' }],
      policy: 'communication',
      note: '创建结构化命令探针',
    },
    revision: bus.collaboration.state(group.id).revision,
    operationId: 'create-structured-probe',
  }, provenance);
  const probeId = result.item.id;
  result = await bus.panelTool(coordination.id, coordination.key, 'work_item_update', {
    groupId: group.id,
    command: {
      id: probeId,
      itemRevision: result.item.revision,
      state: 'in_progress',
      note: '开始探针',
    },
    revision: result.revision,
    operationId: 'start-structured-probe',
  }, provenance);
  result = await bus.panelTool(coordination.id, coordination.key, 'work_item_update', {
    groupId: group.id,
    command: {
      id: probeId,
      itemRevision: result.item.revision,
      state: 'cancelled',
      cancellation: {
        kind: 'irrelevant',
        reason: '临时探针与团队目标无关',
      },
      note: '取消探针',
    },
    revision: result.revision,
    operationId: 'cancel-structured-probe',
  }, provenance);
  assert.equal(result.item.state, 'cancelled');
  assert.equal(result.item.cancellation.kind, 'irrelevant');
});

test('Panel instructions distinguish coordination and forbid schema-probing writes', async t => {
  const { bus } = await fixture(t);
  const state = await createAgent(bus);
  const privateInstructions = bus.panelInstructions({ context: 'private' }, state.agent, null);
  const coordinationInstructions = bus.panelInstructions(
    { context: 'coordination', group_id: 'group-1' },
    state.agent,
    null,
  );
  assert.match(privateInstructions, /coordination 上下文/);
  assert.match(privateInstructions, /不是外部进程或另一个 Panel Agent/);
  assert.match(privateInstructions, /不要为了探测工具 schema 创建临时工作项/);
  assert.match(coordinationInstructions, /不要创建与当前目标无关的临时探针/);
  assert.match(coordinationInstructions, /不要穷举猜测字段/);
});

test('Panel Agent is a global non-member identity and automatically observes existing teams', async t => {
  const { bus, directory } = await fixture(t);
  const group = confirmedGroup(bus, {
    name: 'legacy',
    workspace: directory,
    lead: { name: 'lead', host: 'fake' },
    members: [{ name: 'worker', host: 'fake' }],
  });
  await until(() => !bus.running.size);

  const state = await createAgent(bus);
  await assert.rejects(createAgent(bus), /已经存在 Panel Agent/);
  assert.equal(state.agent.name, 'Panel Agent');
  assert.equal(state.agent.model, 'fake-model');
  assert.equal(state.teams.find(team => team.id === group.id).relation, 'observer');
  assert.equal(bus.members(group.id).some(member => member.id === state.agent.id), false);
  assert.equal(bus.members(group.id).length, 2);
  const later = confirmedGroup(bus, {
    name: 'created later',
    workspace: directory,
    lead: { name: 'later-lead', host: 'fake' },
  });
  assert.equal(bus.panelTeamRelation(later.id), 'observer');

  const session = bus.store.panelSession(state.agent.id, 'private');
  await assert.rejects(
    bus.panelTool(session.id, session.key, 'team_send', {
      groupId: group.id,
      to: 'worker',
      text: 'observer must not write',
    }),
    /不是该团队的主 Agent/,
  );
});

test('Panel MCP tools recover the active team from the recorded turn', async t => {
  const { bus, directory } = await fixture(t);
  const group = confirmedGroup(bus, {
    name: 'recorded turn context',
    workspace: directory,
    lead: { name: 'lead', host: 'fake' },
    members: [{ name: 'worker', host: 'fake' }],
  });
  await until(() => !bus.running.size);
  const state = await createAgent(bus);
  bus.takeoverTeam(group.id, 0);
  const session = bus.store.panelSession(state.agent.id, 'private');
  const turnId = 'recorded-panel-turn';
  bus.store.run(
    'INSERT INTO panel_turns(id,session_id,panel_agent_id,context,group_id,active_team_id,state,created) VALUES(?,?,?,?,?,?,?,?)',
    turnId,
    session.id,
    state.agent.id,
    'private',
    null,
    group.id,
    'running',
    new Date().toISOString(),
  );
  bus.running.set(session.id, {
    endpoint: { group_id: null, context: 'panel-private' },
    activeTeamId: group.id,
    turnId,
    abort: new AbortController(),
    done: Promise.resolve(),
  });
  try {
    await bus.panelTool(session.id, session.key, 'team_send', {
      groupId: group.id,
      to: 'worker',
      text: 'MCP scoped write',
    }, { turnId });
  } finally {
    bus.running.delete(session.id);
  }
  assert.equal(
    bus.store.get('SELECT sender FROM messages WHERE text=?', 'MCP scoped write').sender,
    state.agent.id,
  );
  const toolCall = bus.store.all(
    "SELECT event FROM panel_history WHERE turn_id=? AND event LIKE '%framework.tool_call%'",
    turnId,
  ).map(row => JSON.parse(row.event)).find(event => event.name === 'team_send');
  assert.equal(toolCall.activeTeamId, group.id);
});

test('coordination publishes natural-language updates that are automatically delivered', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-panel-update-'));
  const calls = [];
  const base = hostFixture(calls);
  const host = {
    ...base,
    async run(context) {
      if (context.endpoint.context === 'panel-coordination') {
        calls.push({
          endpoint: context.endpoint.id,
          context: context.endpoint.context,
          groupId: context.endpoint.group_id,
          prompt: context.prompt,
        });
        context.onSession(context.endpoint.session ?? context.endpoint.id);
        await context.onTool('panel_update_publish', {
          text: '成员已完成本轮任务，当前等待主 Agent 验收。',
        });
        context.onAccepted();
        return '团队更新已处理';
      }
      return base.run(context);
    },
  };
  const bus = new Bus({ directory, hosts: new Map([['fake', host]]) });
  bus.start();
  t.after(async () => {
    await bus.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const group = confirmedGroup(bus, {
    name: 'team update channel',
    workspace: directory,
    lead: { name: 'lead', host: 'fake' },
    members: [{ name: 'worker', host: 'fake' }],
  });
  await until(() => !bus.running.size);
  const state = await createAgent(bus);
  bus.takeoverTeam(group.id, 0);
  const worker = bus.members(group.id).find(member => member.name === 'worker');
  const message = bus.store.append(group.id, worker.id, state.agent.id, 'send', 'worker completed the assigned task');
  bus.store.run(
    'INSERT INTO message_context(message_id,work_item_id,contract_version) VALUES(?,?,?)',
    message.id,
    null,
    1,
  );
  bus.pump();
  await until(() => bus.store.get('SELECT id FROM panel_updates WHERE group_id=?', group.id));
  const update = bus.store.get('SELECT * FROM panel_updates WHERE group_id=?', group.id);
  assert.equal(update.text, '成员已完成本轮任务，当前等待主 Agent 验收。');
  assert.deepEqual(JSON.parse(update.source_message_ids), [message.id]);
  await until(() => calls.some(call => (
    call.context === 'panel-private'
    && call.prompt.includes('成员已完成本轮任务')
  )));
  const privateCall = calls.find(call => (
    call.context === 'panel-private'
    && call.prompt.includes('成员已完成本轮任务')
  ));
  assert.ok(privateCall);
  assert.match(privateCall.prompt, /team update channel/);
  assert.match(privateCall.prompt, new RegExp(message.id));
  assert.ok(
    bus.store.get('SELECT delivered_turn_id FROM panel_updates WHERE id=?', update.id).delivered_turn_id,
  );
  assert.equal(
    bus.store.all(
      "SELECT id FROM panel_messages WHERE context='private' AND role='system'",
    ).length,
    0,
  );
});

test('published updates wait while the private session is busy', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-panel-update-queue-'));
  const calls = [];
  let releasePrivate;
  const base = hostFixture(calls);
  const host = {
    ...base,
    async run(context) {
      calls.push({
        endpoint: context.endpoint.id,
        context: context.endpoint.context,
        groupId: context.endpoint.group_id,
        prompt: context.prompt,
      });
      if (context.endpoint.context === 'panel-private' && context.prompt === 'BUSY') {
        context.onSession(context.endpoint.session ?? context.endpoint.id);
        context.onAccepted();
        await new Promise(resolve => { releasePrivate = resolve; });
        return 'user turn complete';
      }
      return base.run(context);
    },
  };
  const bus = new Bus({ directory, hosts: new Map([['fake', host]]) });
  bus.start();
  t.after(async () => {
    await bus.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const group = confirmedGroup(bus, {
    name: 'update queueing',
    workspace: directory,
    lead: { name: 'lead', host: 'fake' },
  });
  await until(() => !bus.running.size);
  await createAgent(bus);
  bus.takeoverTeam(group.id, 0);

  const privateTurn = bus.panelPrivateTurn('BUSY', group.id);
  await until(() => typeof releasePrivate === 'function');
  const update = bus.publishPanelUpdate({
    panelAgentId: bus.panelAgent().id,
    groupId: group.id,
    sourceTurnId: null,
    text: '需要用户立即确认下一步。',
    sourceMessageIds: [],
  });
  await bus.pumpPanelUpdates();
  assert.equal(calls.filter(call => call.context === 'panel-private').length, 1);

  releasePrivate();
  await privateTurn;
  await until(() => calls.filter(call => call.context === 'panel-private').length >= 2);
  const progressCall = calls.filter(call => call.context === 'panel-private')[1];
  assert.match(progressCall.prompt, /需要用户立即确认下一步/);
  await until(() => bus.store.get(
    'SELECT delivered_turn_id FROM panel_updates WHERE id=?',
    update.id,
  ).delivered_turn_id);
  assert.ok(
    bus.store.get('SELECT delivered_turn_id FROM panel_updates WHERE id=?', update.id).delivered_turn_id,
  );
});

test('Panel Agent creates a team through existing revisioned preparation without becoming a member', async t => {
  const { bus, directory } = await fixture(t);
  const state = await createAgent(bus);
  const session = bus.store.panelSession(state.agent.id, 'private');
  let preparation = await bus.panelTool(session.id, session.key, 'team_preparation_create', {
    name: 'panel team',
    workspace: directory,
    members: 'worker=fake',
  });
  preparation = await bus.panelTool(session.id, session.key, 'contract_propose', {
    preparationId: preparation.id,
    contract: JSON.stringify(testContract),
    revision: preparation.revision,
  });
  preparation = await bus.panelTool(session.id, session.key, 'team_plan_update', {
    preparationId: preparation.id,
    roles: JSON.stringify([{
      name: 'worker',
      model_provider: 'fake-provider',
      model: 'fake-model',
      reasoning_effort: 'low',
    }]),
    revision: preparation.revision,
  });
  assert.equal(preparation.groupId, null);
  const group = bus.confirmPreparation(preparation.id, preparation.revision, preparation.hash);
  await until(() => !bus.running.size);

  assert.equal(group.lead, null);
  assert.equal(bus.members(group.id).length, 1);
  assert.equal(bus.members(group.id)[0].name, 'worker');
  assert.equal(bus.panelTeamRelation(group.id), 'main');
  const controller = bus.teamController(group.id);
  assert.equal(controller.kind, 'panel_agent');
  assert.equal(controller.id, state.agent.id);
});

test('approved Panel preparation resumes the private Agent exactly once', async t => {
  const { bus, directory, calls } = await fixture(t);
  const state = await createAgent(bus);
  const session = bus.store.panelSession(state.agent.id, 'private');
  let preparation = await bus.panelTool(session.id, session.key, 'team_preparation_create', {
    name: 'continuation team',
    workspace: directory,
    members: 'worker=fake',
  });
  preparation = await bus.panelTool(session.id, session.key, 'contract_propose', {
    preparationId: preparation.id,
    contract: JSON.stringify(testContract),
    revision: preparation.revision,
  });
  preparation = await bus.panelTool(session.id, session.key, 'team_plan_update', {
    preparationId: preparation.id,
    roles: JSON.stringify([{
      name: 'worker',
      model_provider: 'fake-provider',
      model: 'fake-model',
      reasoning_effort: 'low',
    }]),
    revision: preparation.revision,
  });

  const group = bus.confirmPreparation(preparation.id, preparation.revision, preparation.hash);
  const continuationId = `continuation:${preparation.id}:${preparation.revision}:${preparation.hash}`;
  await until(() => calls.some(call => (
    call.context === 'panel-private'
    && call.prompt.includes('用户已经通过面板批准')
  )));
  await until(() => bus.store.get(
    'SELECT delivered_turn_id FROM panel_updates WHERE id=?',
    continuationId,
  )?.delivered_turn_id);

  const continuation = bus.store.get('SELECT * FROM panel_updates WHERE id=?', continuationId);
  assert.equal(continuation.kind, 'continuation');
  assert.equal(continuation.group_id, group.id);
  assert.match(continuation.text, new RegExp(group.id));
  assert.match(continuation.text, new RegExp(preparation.hash));
  const continuationCalls = calls.filter(call => (
    call.context === 'panel-private'
    && call.prompt.includes('用户已经通过面板批准')
  ));
  assert.equal(continuationCalls.length, 1);
  assert.match(continuationCalls[0].prompt, new RegExp(`activeTeamId=${group.id}`));
  assert.ok(bus.store.get(
    `SELECT id FROM panel_turns
     WHERE context='private' AND active_team_id=? AND state='completed'`,
    group.id,
  ));

  assert.equal(
    bus.confirmPreparation(preparation.id, preparation.revision, preparation.hash).id,
    group.id,
  );
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(
    calls.filter(call => (
      call.context === 'panel-private'
      && call.prompt.includes('用户已经通过面板批准')
    )).length,
    1,
  );
  assert.equal(
    bus.store.all('SELECT id FROM panel_updates WHERE kind=?', 'continuation').length,
    1,
  );
});

test('pending preparation continuation survives a service restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-panel-continuation-restart-'));
  const calls = [];
  const hosts = new Map([['fake', hostFixture(calls)]]);
  let bus = new Bus({ directory, hosts });
  bus.start();
  t.after(async () => {
    await bus.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const state = await createAgent(bus);
  const session = bus.store.panelSession(state.agent.id, 'private');
  let preparation = await bus.panelTool(session.id, session.key, 'team_preparation_create', {
    name: 'restart continuation',
    workspace: directory,
    members: 'worker=fake',
  });
  preparation = await bus.panelTool(session.id, session.key, 'contract_propose', {
    preparationId: preparation.id,
    contract: JSON.stringify(testContract),
    revision: preparation.revision,
  });
  preparation = await bus.panelTool(session.id, session.key, 'team_plan_update', {
    preparationId: preparation.id,
    roles: JSON.stringify([{
      name: 'worker',
      model_provider: 'fake-provider',
      model: 'fake-model',
      reasoning_effort: 'low',
    }]),
    revision: preparation.revision,
  });

  bus.running.set(session.id, {
    endpoint: { id: session.id, context: 'panel-private', group_id: null },
    activeTeamId: null,
    turnId: 'synthetic-private-busy',
    abort: new AbortController(),
    done: Promise.resolve(),
  });
  const group = bus.confirmPreparation(preparation.id, preparation.revision, preparation.hash);
  const continuationId = `continuation:${preparation.id}:${preparation.revision}:${preparation.hash}`;
  assert.ok(bus.store.get(
    'SELECT id FROM panel_updates WHERE id=? AND delivered_turn_id IS NULL',
    continuationId,
  ));
  await bus.close();

  bus = new Bus({ directory, hosts });
  bus.start();
  await until(() => calls.some(call => (
    call.context === 'panel-private'
    && call.prompt.includes('用户已经通过面板批准')
  )));
  await until(() => bus.store.get(
    'SELECT delivered_turn_id FROM panel_updates WHERE id=?',
    continuationId,
  )?.delivered_turn_id);
  assert.equal(bus.store.get(
    'SELECT group_id,kind FROM panel_updates WHERE id=?',
    continuationId,
  ).group_id, group.id);
  assert.ok(bus.store.get(
    'SELECT id FROM panel_turns WHERE context=? AND active_team_id=? AND state=?',
    'private',
    group.id,
    'completed',
  ));
});

test('Panel main receives member reports and can write only in the bound team context', async t => {
  const { bus, directory, calls } = await fixture(t);
  const state = await createAgent(bus);
  const session = bus.store.panelSession(state.agent.id, 'private');
  let preparation = await bus.panelTool(session.id, session.key, 'team_preparation_create', {
    name: 'panel coordination',
    workspace: directory,
    members: 'worker=fake',
  });
  preparation = await bus.panelTool(session.id, session.key, 'contract_propose', {
    preparationId: preparation.id,
    contract: JSON.stringify(testContract),
    revision: preparation.revision,
  });
  preparation = await bus.panelTool(session.id, session.key, 'team_plan_update', {
    preparationId: preparation.id,
    roles: JSON.stringify([{
      name: 'worker',
      model_provider: 'fake-provider',
      model: 'fake-model',
      reasoning_effort: 'low',
    }]),
    revision: preparation.revision,
  });
  const group = bus.confirmPreparation(preparation.id, preparation.revision, preparation.hash);
  await until(() => !bus.running.size);
  const worker = bus.members(group.id)[0];

  const report = bus.store.append(group.id, worker.id, state.agent.id, 'send', 'work report');
  bus.store.run(
    'INSERT INTO message_context(message_id,work_item_id,contract_version) VALUES(?,?,?)',
    report.id,
    null,
    bus.collaboration.state(group.id).contract_version,
  );
  bus.pump();
  await until(() => calls.some(call => call.context === 'panel-coordination'));
  await until(() => !bus.running.size);
  assert.equal(bus.store.get('SELECT accepted FROM panel_outbox WHERE id=(SELECT outbox_id FROM panel_attached WHERE message_id=?)', report.id).accepted != null, true);
  assert.ok(calls.some(call => call.context === 'panel-coordination' && call.groupId === group.id));
  assert.equal(bus.collaboration.pending(group.id).length, 0);
});

test('a Panel coordination turn that finishes the Goal triggers final reconciliation', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-panel-finish-'));
  const calls = [];
  let bus;
  let reportId;
  const host = hostFixture(calls);
  const baseRun = host.run.bind(host);
  host.run = async context => {
    if (context.endpoint.context !== 'panel-coordination' || !context.prompt.includes('FINISH_PANEL_GOAL')) {
      return baseRun(context);
    }
    calls.push({
      endpoint: context.endpoint.id,
      context: context.endpoint.context,
      groupId: context.endpoint.group_id,
      prompt: context.prompt,
    });
    context.onSession(context.endpoint.session ?? context.endpoint.id);
    context.onAccepted();
    const groupId = context.endpoint.group_id;
    const item = bus.store.get(
      'SELECT id FROM work_items WHERE group_id=? AND state=?',
      groupId,
      'accepted',
    );
    await context.onTool('team_finish', {
      groupId,
      command: {
        outcome: 'completed',
        final: 'Panel coordination completed',
        note: 'accepted work covers the contract',
        coverage: { c1: [item.id] },
        dispositions: [{ messageId: reportId, reason: 'used as accepted evidence' }],
      },
      revision: bus.collaboration.state(groupId).revision,
      operationId: 'panel-finish-goal',
    });
    return 'finished';
  };
  bus = new Bus({ directory, hosts: new Map([['fake', host]]) });
  bus.start();
  t.after(async () => {
    await bus.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const group = confirmedGroup(bus, {
    name: 'panel finish',
    workspace: directory,
    lead: { name: 'lead', host: 'fake' },
    members: [{ name: 'worker', host: 'fake' }],
  });
  await until(() => !bus.running.size);
  const agent = await createAgent(bus);
  bus.takeoverTeam(group.id, 0);
  const worker = bus.members(group.id).find(member => member.name === 'worker');
  const coordination = bus.store.panelSession(agent.agent.id, 'coordination', group.id);
  const provenance = { activeTeamId: group.id };
  const goalId = bus.lifecycle.read(group.id).current.id;
  let item = await bus.panelTool(coordination.id, coordination.key, 'work_item_update', {
    groupId: group.id,
    command: {
      title: 'panel finish work',
      purpose: 'complete the approved contract',
      standard: 'accepted evidence',
      participants: [{ memberId: worker.id, role: 'executor' }],
      policy: 'communication',
      note: 'create work',
    },
    revision: bus.collaboration.state(group.id).revision,
    operationId: 'panel-finish-create',
  }, provenance);
  item = await bus.panelTool(coordination.id, coordination.key, 'work_item_update', {
    groupId: group.id,
    command: {
      id: item.item.id,
      itemRevision: item.item.revision,
      state: 'in_progress',
      note: 'start work',
    },
    revision: item.revision,
    operationId: 'panel-finish-start',
  }, provenance);
  const report = bus.store.append(group.id, worker.id, agent.agent.id, 'send', 'accepted result');
  reportId = report.id;
  bus.store.run(
    'INSERT INTO message_context(message_id,work_item_id,contract_version,goal_id) VALUES(?,?,?,?)',
    report.id,
    item.item.id,
    bus.collaboration.state(group.id).contract_version,
    goalId,
  );
  item = await bus.panelTool(coordination.id, coordination.key, 'work_item_update', {
    groupId: group.id,
    command: {
      id: item.item.id,
      itemRevision: item.item.revision,
      state: 'pending_decision',
      artifact: 'accepted-v1',
      evidence: [report.id],
      note: 'accepted evidence attached',
    },
    revision: item.revision,
    operationId: 'panel-finish-decision',
  }, provenance);
  await bus.panelTool(coordination.id, coordination.key, 'work_item_update', {
    groupId: group.id,
    command: {
      id: item.item.id,
      itemRevision: item.item.revision,
      state: 'accepted',
      note: 'accept result',
    },
    revision: item.revision,
    operationId: 'panel-finish-accept',
  }, provenance);

  await bus.runPanelTurn({
    session: { ...coordination, group_id: group.id },
    panelAgent: bus.panelAgent(),
    prompt: 'FINISH_PANEL_GOAL',
    activeTeamId: group.id,
    inputs: [report],
  });
  assert.equal(bus.collaboration.state(group.id).phase, 'closed');
  assert.equal(bus.lifecycle.read(group.id).current, null);
  assert.equal(bus.lifecycle.read(group.id).history[0].state, 'completed');
  assert.equal(bus.store.all('SELECT * FROM user_outputs WHERE group_id=?', group.id).length, 1);
});

test('a Panel finish waits for Goal Inbox messages that arrive during the finishing turn', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-panel-race-'));
  const calls = [];
  let bus;
  let reportId;
  let lateId;
  let finishError;
  const host = hostFixture(calls);
  const baseRun = host.run.bind(host);
  const finishCommand = itemId => ({
    outcome: 'completed',
    final: 'finish after consuming all Goal Inbox messages',
    note: 'all Goal Inbox messages are consumed or part of the finishing turn',
    coverage: { c1: [itemId] },
    dispositions: [
      { messageId: reportId, reason: 'accepted evidence' },
      ...(lateId ? [{ messageId: lateId, reason: 'late report handled' }] : []),
    ],
  });
  host.run = async context => {
    const groupId = context.endpoint.group_id;
    if (context.endpoint.context === 'panel-coordination' && context.prompt.includes('RACE_LATE')) {
      context.onSession(context.endpoint.session ?? context.endpoint.id);
      context.onAccepted();
      const item = bus.store.get('SELECT id FROM work_items WHERE group_id=? AND state=?', groupId, 'accepted');
      await context.onTool('team_finish', {
        groupId,
        command: finishCommand(item.id),
        revision: bus.collaboration.state(groupId).revision,
        operationId: 'panel-race-finish-2',
      });
      return 'finished';
    }
    if (context.endpoint.context === 'panel-coordination' && context.prompt.includes('RACE_TRIGGER')) {
      context.onSession(context.endpoint.session ?? context.endpoint.id);
      context.onAccepted();
      const goalId = bus.lifecycle.read(groupId).current.id;
      const worker = bus.members(groupId).find(member => member.name === 'worker');
      const late = bus.store.append(groupId, worker.id, bus.panelAgent().id, 'send', 'RACE_LATE late report');
      lateId = late.id;
      bus.store.run(
        'INSERT INTO message_context(message_id,work_item_id,contract_version,goal_id) VALUES(?,?,?,?)',
        late.id,
        null,
        bus.collaboration.state(groupId).contract_version,
        goalId,
      );
      const item = bus.store.get('SELECT id FROM work_items WHERE group_id=? AND state=?', groupId, 'accepted');
      try {
        await context.onTool('team_finish', {
          groupId,
          command: finishCommand(item.id),
          revision: bus.collaboration.state(groupId).revision,
          operationId: 'panel-race-finish-1',
        });
      } catch (error) {
        finishError = error;
      }
      return 'rejected';
    }
    return baseRun(context);
  };
  bus = new Bus({ directory, hosts: new Map([['fake', host]]) });
  bus.start();
  t.after(async () => {
    await bus.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const group = confirmedGroup(bus, {
    name: 'panel race',
    workspace: directory,
    lead: { name: 'lead', host: 'fake' },
    members: [{ name: 'worker', host: 'fake' }],
  });
  await until(() => !bus.running.size);
  const agent = await createAgent(bus);
  bus.takeoverTeam(group.id, 0);
  const worker = bus.members(group.id).find(member => member.name === 'worker');
  const coordination = bus.store.panelSession(agent.agent.id, 'coordination', group.id);
  const provenance = { activeTeamId: group.id };
  const goalId = bus.lifecycle.read(group.id).current.id;
  let item = await bus.panelTool(coordination.id, coordination.key, 'work_item_update', {
    groupId: group.id,
    command: {
      title: 'panel race work',
      purpose: 'verify Goal Inbox consumption before finish',
      standard: 'accepted evidence',
      participants: [{ memberId: worker.id, role: 'executor' }],
      policy: 'communication',
      note: 'create work',
    },
    revision: bus.collaboration.state(group.id).revision,
    operationId: 'panel-race-create',
  }, provenance);
  item = await bus.panelTool(coordination.id, coordination.key, 'work_item_update', {
    groupId: group.id,
    command: {
      id: item.item.id,
      itemRevision: item.item.revision,
      state: 'in_progress',
      note: 'start work',
    },
    revision: item.revision,
    operationId: 'panel-race-start',
  }, provenance);
  const report = bus.store.append(group.id, worker.id, agent.agent.id, 'send', 'RACE_TRIGGER accepted result');
  reportId = report.id;
  bus.store.run(
    'INSERT INTO message_context(message_id,work_item_id,contract_version,goal_id) VALUES(?,?,?,?)',
    report.id,
    item.item.id,
    bus.collaboration.state(group.id).contract_version,
    goalId,
  );
  item = await bus.panelTool(coordination.id, coordination.key, 'work_item_update', {
    groupId: group.id,
    command: {
      id: item.item.id,
      itemRevision: item.item.revision,
      state: 'pending_decision',
      artifact: 'accepted-v1',
      evidence: [report.id],
      note: 'accepted evidence attached',
    },
    revision: item.revision,
    operationId: 'panel-race-decision',
  }, provenance);
  await bus.panelTool(coordination.id, coordination.key, 'work_item_update', {
    groupId: group.id,
    command: {
      id: item.item.id,
      itemRevision: item.item.revision,
      state: 'accepted',
      note: 'accept result',
    },
    revision: item.revision,
    operationId: 'panel-race-accept',
  }, provenance);

  await bus.runPanelTurn({
    session: { ...coordination, group_id: group.id },
    panelAgent: bus.panelAgent(),
    prompt: 'RACE_TRIGGER',
    activeTeamId: group.id,
    inputs: [report],
  });

  assert.ok(finishError, 'finish should be rejected while an unconsumed Goal Inbox message exists');
  assert.match(finishError.message, /未消费的Goal Inbox消息/);
  assert.ok(finishError.message.includes(lateId));
  assert.notEqual(bus.collaboration.state(group.id).phase, 'closing');

  await until(() => bus.collaboration.state(group.id).phase === 'closed');
  assert.equal(bus.lifecycle.read(group.id).current, null);
  assert.equal(bus.lifecycle.read(group.id).history[0].state, 'completed');
  assert.equal(bus.store.all('SELECT * FROM user_outputs WHERE group_id=?', group.id).length, 1);
});

test('lead takeover and handback are revisioned and require an idle team', async t => {
  const { bus, directory } = await fixture(t);
  const group = confirmedGroup(bus, {
    name: 'takeover target',
    workspace: directory,
    lead: { name: 'lead', host: 'fake' },
    members: [{ name: 'worker', host: 'fake' }],
  });
  await until(() => !bus.running.size);
  await createAgent(bus);

  const original = bus.teamController(group.id);
  assert.equal(original.kind, 'member');
  bus.running.set('synthetic-active', {
    endpoint: { group_id: group.id, context: 'coordination' },
    turnId: 'synthetic-turn',
    abort: new AbortController(),
    done: Promise.resolve(),
  });
  assert.throws(() => bus.takeoverTeam(group.id, 0), /仍有运行中回合/);
  bus.running.delete('synthetic-active');
  const taken = bus.takeoverTeam(group.id, 0);
  assert.equal(taken.controller.kind, 'panel_agent');
  assert.equal(taken.panelRelation, 'main');
  const coordinationSession = bus.store.panelSession(taken.controller.id, 'coordination', group.id);
  assert.equal(
    bus.snapshot().endpoints.some(endpoint => endpoint.id === coordinationSession.id && endpoint.context === 'panel-coordination'),
    true,
  );
  assert.throws(() => bus.handbackTeam(group.id, 0), /版本已变化/);
  const returned = bus.handbackTeam(group.id, taken.revision);
  assert.equal(returned.controller.kind, 'member');
  assert.equal(returned.controller.id, original.id);
  assert.equal(returned.panelRelation, 'observer');
});

test('one Panel Agent can hold main control for multiple teams independently', async t => {
  const { bus, directory } = await fixture(t);
  const first = confirmedGroup(bus, {
    name: 'first',
    workspace: directory,
    lead: { name: 'lead-a', host: 'fake' },
  });
  const second = confirmedGroup(bus, {
    name: 'second',
    workspace: directory,
    lead: { name: 'lead-b', host: 'fake' },
  });
  await until(() => !bus.running.size);
  await createAgent(bus);
  const firstTaken = bus.takeoverTeam(first.id, 0);
  const secondTaken = bus.takeoverTeam(second.id, 0);
  assert.equal(firstTaken.panelRelation, 'main');
  assert.equal(secondTaken.panelRelation, 'main');
  assert.notEqual(
    bus.store.panelSession(firstTaken.controller.id, 'coordination', first.id).id,
    bus.store.panelSession(secondTaken.controller.id, 'coordination', second.id).id,
  );
});

test('private Panel context writes only to the selected team with main relation', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-panel-scope-'));
  const host = hostFixture([]);
  const plainRun = host.run.bind(host);
  host.run = async context => {
    if (context.endpoint.context === 'panel-private' && context.prompt.startsWith('WRITE:')) {
      const groupId = /^WRITE:([^ ]+)/.exec(context.prompt)?.[1];
      const worker = context.prompt.includes('second-worker') ? 'second-worker' : 'first-worker';
      await context.onTool('team_send', { groupId, to: worker, text: 'scoped write' });
    }
    return plainRun(context);
  };
  const bus = new Bus({ directory, hosts: new Map([['fake', host]]) });
  bus.start();
  t.after(async () => {
    await bus.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const first = confirmedGroup(bus, {
    name: 'first scope',
    workspace: directory,
    lead: { name: 'first-lead', host: 'fake' },
    members: [{ name: 'first-worker', host: 'fake' }],
  });
  const second = confirmedGroup(bus, {
    name: 'second scope',
    workspace: directory,
    lead: { name: 'second-lead', host: 'fake' },
    members: [{ name: 'second-worker', host: 'fake' }],
  });
  await until(() => !bus.running.size);
  await createAgent(bus);
  bus.takeoverTeam(first.id, 0);

  await bus.panelPrivateTurn(`WRITE:${first.id}`, first.id);
  assert.equal(
    bus.store.get('SELECT sender FROM messages WHERE text=?', 'scoped write').sender,
    bus.panelAgent().id,
  );

  await assert.rejects(
    bus.panelPrivateTurn(`WRITE:${second.id} second-worker`, second.id),
    /不是该团队的主 Agent/,
  );
  assert.equal(bus.store.all('SELECT id FROM messages WHERE group_id=? AND text=?', second.id, 'scoped write').length, 0);
});

test('unknown Panel Agent runtime blocks the session until the user verifies it stopped', async t => {
  const { bus } = await fixture(t);
  const state = await createAgent(bus);
  const session = bus.store.panelSession(state.agent.id, 'private');
  bus.store.run(
    'INSERT INTO panel_turns(id,session_id,panel_agent_id,context,group_id,active_team_id,state,created) VALUES(?,?,?,?,?,?,?,?)',
    'unknown-panel-turn',
    session.id,
    state.agent.id,
    'private',
    null,
    null,
    'unknown',
    new Date().toISOString(),
  );
  await assert.rejects(bus.panelPrivateTurn('must wait', null), /待核实运行/);
  bus.resolvePanelRuntime('unknown-panel-turn', '用户确认宿主进程已停止');
  const result = await bus.panelPrivateTurn('resume', null);
  assert.equal(result.result, 'panel reply');
});

test('Panel Agent identity, private conversation and session survive restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-panel-restart-'));
  const hosts = new Map([['fake', hostFixture([])]]);
  let bus = new Bus({ directory, hosts });
  bus.start();
  await createAgent(bus);
  await bus.panelPrivateTurn('persist me', null);
  const before = bus.panelAgentState();
  const sessionBefore = bus.store.panelSession(before.agent.id, 'private').session;
  await bus.close();

  bus = new Bus({ directory, hosts });
  bus.start();
  t.after(async () => {
    await bus.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const after = bus.panelAgentState();
  assert.equal(after.agent.id, before.agent.id);
  assert.deepEqual(after.conversation.map(message => message.role), ['user', 'assistant']);
  assert.equal(bus.store.panelSession(after.agent.id, 'private').session, sessionBefore);
});
