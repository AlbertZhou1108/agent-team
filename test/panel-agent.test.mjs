import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../src/bus.mjs';
import { panelToolsFor, validatePanelTool } from '../src/panel-tools.mjs';
import { confirmedGroup } from './helpers.mjs';

const _tick = () => new Promise(resolve => setImmediate(resolve));
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

test('Panel coordination tools expose messaging and update publishing schemas', async t => {
  const tools = panelToolsFor('private');
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
  const sendTool = panelToolsFor('coordination').find(tool => tool.name === 'team_send');
  assert.deepEqual(sendTool.inputSchema.required, ['groupId', 'to', 'text']);
  assert.throws(() => validatePanelTool('coordination', 'team_send', {
    groupId: 'group-1',
    to: 'worker',
    text: 'hello',
    workItemId: 'legacy-field',
  }), /不允许的参数/);
  assert.doesNotThrow(() => validatePanelTool('coordination', 'team_send', {
    groupId: 'group-1',
    to: 'worker',
    text: 'hello',
  }));

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
  const coordination = bus.store.panelSession(state.agent.id, 'coordination', group.id);
  const provenance = { activeTeamId: group.id };
  const turnId = 'structured-panel-turn';
  bus.store.run(
    'INSERT INTO panel_turns(id,session_id,panel_agent_id,context,group_id,active_team_id,state,created) VALUES(?,?,?,?,?,?,?,?)',
    turnId,
    coordination.id,
    state.agent.id,
    'coordination',
    group.id,
    group.id,
    'running',
    new Date().toISOString(),
  );
  const live = {
    endpoint: { ...coordination, context: 'panel-coordination' },
    activeTeamId: group.id,
    turnId,
    abort: new AbortController(),
    done: Promise.resolve(),
  };
  bus.running.set(coordination.id, live);
  try {
    const result = await bus.panelTool(coordination.id, coordination.key, 'team_send', {
      groupId: group.id,
      to: 'worker',
      text: '直接向成员派发说明',
    }, { ...provenance, turnId });
    const message = bus.store.get('SELECT * FROM messages WHERE id=?', result.messageId);
    assert.equal(message.sender, state.agent.id);
    assert.equal(message.kind, 'send');
    await assert.rejects(bus.panelTool(coordination.id, coordination.key, 'work_item_update', {
      groupId: group.id,
      command: {},
      revision: 1,
      operationId: 'gone',
    }, { ...provenance, turnId }), /当前上下文不能使用此工具/);
  } finally {
    bus.running.delete(coordination.id);
  }
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
  assert.match(privateInstructions, /team_create/);
  assert.match(coordinationInstructions, /panel_update_publish/);
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
    /不是该团队的主 Agent|当前上下文不能使用此工具/,
  );
});

test('private tools reject direct coordination and unbound delegation', async t => {
 const { bus } = await fixture(t); const state = await createAgent(bus);
 const session = bus.store.panelSession(state.agent.id, 'private');
 await assert.rejects(bus.panelTool(session.id, session.key, 'team_send', {groupId:'any',to:'worker',text:'forbidden'}), /当前上下文不能使用此工具/);
 await assert.rejects(bus.panelTool(session.id, session.key, 'team_request_submit', {groupId:'any',text:'forged',operationId:'forged'}), /当前私人用户回合/);
});

test('coordination updates remain source notifications without waking the private host', async t => {
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
  bus.pump();
  await until(() => bus.store.get('SELECT id FROM panel_updates WHERE group_id=?', group.id));
  const update = bus.store.get('SELECT * FROM panel_updates WHERE group_id=?', group.id);
  assert.equal(update.text, '成员已完成本轮任务，当前等待主 Agent 验收。');
  assert.deepEqual(JSON.parse(update.source_message_ids), [message.id]);
  await until(() => !bus.running.size);
  await bus.pumpPanelUpdates();
  assert.equal(calls.filter(call => call.context === 'panel-private').length, 0);
  assert.equal(bus.store.get('SELECT delivered_turn_id FROM panel_updates WHERE id=?', update.id).delivered_turn_id, null);
  assert.ok(bus.panelAgentState().notifications.some(row => row.id === update.id));
});

test('legacy notifications do not wake an idle private host', async t => {
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

  const privateTurn = bus.panelPrivateTurn('BUSY', null);
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
  await bus.pumpPanelUpdates();
  assert.equal(calls.filter(call => call.context === 'panel-private').length, 1);
  assert.equal(bus.store.get('SELECT delivered_turn_id FROM panel_updates WHERE id=?', update.id).delivered_turn_id, null);
});

test('Panel Agent creates a team directly without becoming a member', async t => {
  const { bus, directory } = await fixture(t);
  const state = await createAgent(bus);
  const session = bus.store.panelSession(state.agent.id, 'private');
  const group = await bus.panelTool(session.id, session.key, 'team_create', {
    name: 'panel team',
    workspace: directory,
    members: 'worker=fake',
  });
  await until(() => !bus.running.size);

  assert.equal(group.lead, null);
  assert.equal(bus.members(group.id).length, 1);
  assert.equal(bus.members(group.id)[0].name, 'worker');
  assert.equal(bus.panelTeamRelation(group.id), 'main');
  const controller = bus.teamController(group.id);
  assert.equal(controller.kind, 'panel_agent');
  assert.equal(controller.id, state.agent.id);
  const coordinationSession = bus.store.panelSession(state.agent.id, 'coordination', group.id);
  await assert.rejects(bus.panelTool(coordinationSession.id, coordinationSession.key, 'team_create', {
    name: 'coordination-only team',
    workspace: directory,
  }), /当前上下文不能使用此工具/);
});

test('Panel main receives member reports and can write only in the bound team context', async t => {
  const { bus, directory, calls } = await fixture(t);
  const state = await createAgent(bus);
  const session = bus.store.panelSession(state.agent.id, 'private');
  const group = await bus.panelTool(session.id, session.key, 'team_create', {
    name: 'panel coordination',
    workspace: directory,
    members: 'worker=fake',
  });
  await until(() => !bus.running.size);
  const worker = bus.members(group.id)[0];

  const report = bus.store.append(group.id, worker.id, state.agent.id, 'send', 'work report');
  bus.pump();
  await until(() => calls.some(call => call.context === 'panel-coordination'));
  await until(() => !bus.running.size);
  assert.equal(bus.store.get('SELECT accepted FROM panel_outbox WHERE id=(SELECT outbox_id FROM panel_attached WHERE message_id=?)', report.id).accepted != null, true);
  assert.ok(calls.some(call => call.context === 'panel-coordination' && call.groupId === group.id));
  assert.equal(bus.store.pending().filter(m => m.group_id === group.id).length, 0);
});

test('private creation forwards to its team coordination and receives an explicit receipt', async t => {
 const directory = mkdtempSync(join(tmpdir(), 'agent-team-request-')); const base = hostFixture([]);
 let bus; let created; let privateCalls=0;
 const host={...base, async run(context) {
   if(context.endpoint.context==='panel-private') {
     privateCalls++; context.onAccepted();
     created=await context.onTool('team_create',{name:'request team',workspace:directory,members:'worker=fake'});
     const args={groupId:created.id,text:'do team work',operationId:'one'};
     const before=bus.store.all("SELECT id FROM messages WHERE text='atomic rollback'").length;
     const originalRun=bus.store.run.bind(bus.store);
     bus.store.run=(sql,...values)=>{if(sql.startsWith('INSERT INTO team_requests')) throw new Error('injected link failure');return originalRun(sql,...values);};
     try { await assert.rejects(context.onTool('team_request_submit',{...args,text:'atomic rollback',operationId:'rollback'}),/injected link failure/); }
     finally { bus.store.run=originalRun; }
     assert.equal(bus.store.all("SELECT id FROM messages WHERE text='atomic rollback'").length,before);
     const first=await context.onTool('team_request_submit',args);
     const second=await context.onTool('team_request_submit',args); assert.equal(first.id,second.id);
     const observer=confirmedGroup(bus,{name:'observer team',workspace:directory,lead:{name:'other-lead',host:'fake'}});
     await assert.rejects(context.onTool('team_request_submit',{groupId:observer.id,text:'must reject',operationId:'observer'}),/不是该团队的主 Agent/);
     return 'transferred';
   }
   if(context.endpoint.context==='panel-coordination') {
     context.onAccepted(); const requests=await context.onTool('team_requests',{}); const request=requests[0];
     assert.ok(request);
     assert.equal('original_text' in request,false);
     await assert.rejects(context.onTool('team_receipt_publish',{requestId:'foreign-request',operationId:'bad',text:'forged',sourceMessageIds:[request.message_id]}),/请求不属于当前团队/);
     await assert.rejects(context.onTool('team_receipt_publish',{requestId:request.id,operationId:'bad-source',text:'forged',sourceMessageIds:['foreign-message']}),/来源消息不属于当前团队/);
     const args={requestId:request.id,operationId:'receipt',text:'received',sourceMessageIds:[request.message_id]};
     await context.onTool('team_receipt_publish',args); await context.onTool('team_receipt_publish',args);
     return 'team reply';
   }
   return base.run(context);
 }};
 bus=new Bus({directory,hosts:new Map([['fake',host]])}); bus.start();
 t.after(async()=>{await bus.close();rmSync(directory,{recursive:true,force:true});});
 const state=await createAgent(bus); const response=await bus.panelPrivateTurn('create and run',null);
 await until(()=>!bus.running.size);
 const requests=bus.panelAgentState().requests; assert.equal(requests.length,1);
 assert.equal(requests[0].source_user_message_id,response.message.id);
 assert.equal(requests[0].original_text,'create and run'); assert.equal(requests[0].receipts.length,1);
 assert.equal(requests[0].receipts[0].text,'received');
 assert.deepEqual(bus.queryUnread().receipts, requests.flatMap(request => request.receipts).map(({id,isSourceCopy,sourceMessageIds}) => ({id,isSourceCopy,sourceMessageIds})));  assert.equal(privateCalls,1);
 assert.equal(response.message.active_team_id,null);
 const message=bus.store.get('SELECT * FROM messages WHERE id=?',requests[0].message_id);
 assert.equal(message.sender,'user'); assert.equal(message.recipient,state.agent.id);
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

test('private team-context input is rejected rather than opening a second team conversation',async t=>{
 const {bus,directory}=await fixture(t); await createAgent(bus);
 const group=confirmedGroup(bus,{name:'legacy',workspace:directory,lead:{name:'lead',host:'fake'}});
 await until(()=>!bus.running.size);
 await assert.rejects(bus.panelPrivateTurn('legacy write',group.id),/团队对话已迁移/);
 assert.equal(bus.store.all("SELECT * FROM panel_messages WHERE active_team_id=?",group.id).length,0);
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

test('summary preserves conversation team attribution for unread counts', async t => {
  const { bus, directory } = await fixture(t);
  const group = confirmedGroup(bus, {
    name: 'unread attribution', workspace: directory,
    lead: { name: 'lead', host: 'fake' }, members: [],
  });
  await until(() => !bus.running.size);
  const state = await createAgent(bus);
  bus.store.panelAppend(state.agent.id, 'private', 'assistant', 'team reply', group.id);
  bus.store.panelAppend(state.agent.id, 'private', 'assistant', 'global reply', null);
  const summary = bus.panelAgentState(true).conversation;
  assert.equal(summary.at(-2).active_team_id, group.id);
  assert.equal(summary.at(-1).active_team_id, null);
  assert.equal('text' in summary.at(-2), false);
});


test('stopping the global assistant does not stop its team coordination', async t => {
  const { bus } = await fixture(t);
  await createAgent(bus);
  const privateAbort = new AbortController();
  const teamAbort = new AbortController();
  bus.running.set('test-private', { endpoint: { context: 'panel-private' }, turnId: 'private', abort: privateAbort, done: Promise.resolve() });
  bus.running.set('test-team', { endpoint: { context: 'panel-coordination' }, turnId: 'team', abort: teamAbort, done: Promise.resolve() });
  try {
    assert.deepEqual(await bus.stopPanel(), { stopped: ['private'] });
    assert.equal(privateAbort.signal.aborted, true);
    assert.equal(teamAbort.signal.aborted, false);
  } finally { bus.running.delete('test-private'); bus.running.delete('test-team'); }
});

test('unread projection preserves the private message window without text', async t => {
 const {bus}=await fixture(t); const state=await createAgent(bus);
 for(let i=0;i<205;i++) bus.store.panelAppend(state.agent.id,'private',i%2?'assistant':'user','private payload',null);
 const full=bus.panelAgentState(true); const projection=bus.queryUnread();
 assert.deepEqual(projection.messages.map(row => ({...row})), full.conversation.map(({seq,role,active_team_id})=>({seq,role,active_team_id})));
 assert.equal(projection.messages.length,200);
 assert.ok(!JSON.stringify(projection).includes('private payload'));
});

test('service restart separates all private history from current messages and pages without overlap', async t => {
 const directory=mkdtempSync(join(tmpdir(),'panel-boot-'));
 let bus=new Bus({directory,hosts:new Map([['fake',hostFixture()]])});
 t.after(async()=>{await bus.close();rmSync(directory,{recursive:true,force:true});});
 const state=await createAgent(bus);
 for(let i=0;i<205;i++) bus.store.panelAppend(state.agent.id,'private','assistant','old '+i,i%2?'legacy-team':null);
 const hosts=bus.hosts;await bus.close();bus=new Bus({directory,hosts});
 assert.equal(bus.panelBrowserState().conversation.length,0);
 assert.deepEqual(bus.queryUnread(true).messages,[]);
 const first=bus.panelMessagePage({history:true});const second=bus.panelMessagePage({history:true,before:first.nextBefore});
 assert.equal(first.messages.length,200);assert.equal(second.messages.length,5);assert.equal(second.nextBefore,null);
 assert.ok(second.messages.at(-1).seq<first.messages[0].seq);
 bus.store.panelAppend(state.agent.id,'private','assistant','new');
 assert.equal(bus.panelBrowserState().conversation[0].text,'new');
 assert.equal(bus.panelMessagePage().messages.length,1);
 assert.equal(bus.queryUnread(true).messages.length,1);
 assert.equal(bus.panelMessagePage({history:true}).messages.length,200);
});
