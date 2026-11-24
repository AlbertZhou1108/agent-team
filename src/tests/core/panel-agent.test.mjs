import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../../bus.mjs';
import { panelToolsFor, validatePanelTool } from '../../tools/panel.mjs';
import { createTestGroup } from '../support/fixture.mjs';
import * as panelAgg from '../../aggregates/panel.mjs';
import * as messagesAgg from '../../aggregates/messages.mjs';
import * as turnsAgg from '../../aggregates/turns.mjs';
import { DatabaseSync } from 'node:sqlite';
import { claudeExecutionConfig, codexSandboxConfig, executionPolicy, sandboxMode } from '../../hosts/policies.mjs';
import { writeMcpFiles } from '../../host-runtime/process.mjs';
import { apply as applyDshPolicy } from '../../member/dsh/policy.mjs';
import { startServer } from '../../server.mjs';
import { rpc } from '../../rpc.mjs';

describe('panel-agent', () => {
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
        attachments: (context.attachments ?? []).map(item => ({ id: item.id, name: item.name, mediaType: item.mediaType, hasPath: typeof item.path === 'string' && item.path.length > 0 })),
      });
      context.onSession(context.endpoint.session ?? context.endpoint.id);
      if (context.endpoint.context === 'profile') {
        await context.onTool('profile_set', { text: 'test profile' });
      }
      context.onAccepted();
      return context.endpoint.owner_kind === 'panel_agent' ? 'panel reply' : 'done';
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
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  });
  return { directory, calls, bus };
}

async function createAgent(bus, workspace = null) {
  return bus.createPanelAgent({
    name: 'Panel Agent',
    host: 'fake',
    model_provider: 'fake-provider',
    model: 'fake-model',
    reasoning_effort: 'low',
    ...(workspace ? { workspace, access: 'workspace-write' } : {}),
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
  const group = createTestGroup(bus, {
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
    'INSERT INTO turns(id,conversation_id,executor_kind,executor_id,group_id,session,active_team_id,source_user_message_id,state,detail,created,ended) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    turnId,
    coordination.id,
    'panel_agent',
    state.agent.id,
    group.id,
    coordination.session ?? null,
    group.id,
    null,
    'running',
    null,
    new Date().toISOString(),
    null,
  );
  const live = {
    endpoint: { ...coordination },
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
    // 能力不满足时写库前拒绝：不落下消息。
    const baseline = bus.store.get('SELECT COUNT(*) AS count FROM messages').count;
    await assert.rejects(bus.panelTool(coordination.id, coordination.key, 'team_send', {
      groupId: group.id,
      to: 'worker',
      text: '请描述这张图。',
      requiredCapabilities: ['modal.image'],
    }, { ...provenance, turnId }), /capability_required/);
    const afterReject = bus.store.get('SELECT COUNT(*) AS count FROM messages').count;
    assert.equal(afterReject, baseline);
    const delivered = await bus.panelTool(coordination.id, coordination.key, 'team_send', {
      groupId: group.id,
      to: 'user',
      text: '成员汇报后的阶段交付',
    }, { ...provenance, turnId });
    const userMessage = bus.store.get('SELECT * FROM messages WHERE id=?', delivered.messageId);
    assert.equal(userMessage.sender, state.agent.id);
    assert.equal(userMessage.recipient, 'user');
    assert.equal(userMessage.awaiting, 0);
    await assert.rejects(bus.panelTool(coordination.id, coordination.key, 'team_send', {
      groupId: group.id,
      to: 'user',
      text: '需要用户额外答复时改用 ask',
      expects_reply: true,
    }, { ...provenance, turnId }), /只支持正文/);
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

test('Panel views expose capability cards and coordination prompts carry the compact team view', async t => {
  const { bus, directory, calls } = await fixture(t);
  const group = createTestGroup(bus, {
    name: 'panel capability team',
    workspace: directory,
    lead: { name: 'lead', host: 'fake' },
    members: [{ name: 'worker', host: 'fake' }],
    policy: 'read-only',
  });
  await until(() => !bus.running.size);
  const state = await createAgent(bus);
  bus.takeoverTeam(group.id, 0);
  const privateSession = bus.store.panelSession(state.agent.id, 'private');
  const snapshot = await bus.panelTool(privateSession.id, privateSession.key, 'team_snapshot', {
    groupId: group.id,
  });
  const worker = snapshot.members.find(member => member.name === 'worker');
  // 目录只上报了基础字段：模态未知要如实标 'unknown'，不能假称支持。
  assert.equal(worker.capabilityCard.model.knownInCatalog, true);
  assert.equal(worker.capabilityCard.model.id, 'fake-model');
  assert.equal(worker.capabilityCard.model.contextWindow, null);
  assert.equal(worker.capabilityCard.effectiveCapabilities['modal.image'], 'unknown');
  assert.equal(worker.capabilityCard.effectiveCapabilities['exec.read'], true);
  assert.equal(worker.capabilityCard.effectiveCapabilities['exec.write'], false);
  assert.equal(worker.capabilityCard.effectiveCapabilities['tool.browser'], false);
  assert.equal(worker.capabilityCard.effectivePolicy.ceiling, 'read-only');
  assert.equal(snapshot.controller.kind, 'panel_agent');
  assert.equal(snapshot.controller.capabilityCard.model.knownInCatalog, true);
  assert.equal(snapshot.controller.capabilityCard.effectiveCapabilities['exec.read'], false);
  assert.equal(snapshot.controller.capabilityCard.effectiveCapabilities['modal.image'], 'unknown');
  assert.equal(snapshot.controller.capabilityCard.effectivePolicy.mode, 'communication');
  const members = await bus.panelTool(privateSession.id, privateSession.key, 'team_members', {
    groupId: group.id,
  });
  assert.deepEqual(members.find(member => member.name === 'worker').capabilityCard, worker.capabilityCard);

  // 真实派工回合：成员汇报触发 Panel 协调回合，回合输入带精简团队能力视图。
  const workerMember = bus.members(group.id).find(member => member.name === 'worker');
  const panelPrompt = call => {
    if (call.context !== 'coordination') return null;
    try {
      const parsed = JSON.parse(call.prompt);
      return parsed?.teamCapabilities?.controller?.kind === 'panel_agent' ? parsed : null;
    } catch { return null; }
  };
  bus.store.append(group.id, workerMember.id, state.agent.id, 'send', 'worker report');
  bus.pump();
  await until(() => calls.some(call => panelPrompt(call)));
  const panelInput = panelPrompt(calls.find(call => panelPrompt(call)));
  assert.equal(panelInput.teamCapabilities.members.length, 2);
  const workerLine = panelInput.teamCapabilities.members.find(row => row.name === 'worker');
  assert.equal(workerLine.modalImage, 'unknown');
  assert.equal(workerLine.execRead, true);
  assert.equal(workerLine.execWrite, false);
  await until(() => !bus.running.size);
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
  assert.match(privateInstructions, /不要在正文中暴露内部工具函数名/);
  assert.match(coordinationInstructions, /panel_update_publish/);
  assert.match(coordinationInstructions, /不要穷举猜测字段/);
  assert.match(coordinationInstructions, /必须显式调用 team_send（to: 'user'）/);
  // 派工能力规则加入后仍在固定规则预算内（16,384 字节）。
  assert.ok(Buffer.byteLength(privateInstructions, 'utf8') <= bus.information.budgets.rulesBytes);
  assert.ok(Buffer.byteLength(coordinationInstructions, 'utf8') <= bus.information.budgets.rulesBytes);
});

test('Panel Agent is a global non-member identity and automatically observes existing teams', async t => {
  const { bus, directory } = await fixture(t);
  const group = createTestGroup(bus, {
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
  const later = createTestGroup(bus, {
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
      if (context.endpoint.owner_kind === 'panel_agent' && context.endpoint.context === 'coordination') {
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
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  });
  const group = createTestGroup(bus, {
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
  await bus.pump();
  assert.equal(calls.filter(call => call.context === 'private').length, 0);
  assert.equal(panelAgg.updateById(bus.store, update.id).delivered_turn_id, null);
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
        attachments: (context.attachments ?? []).map(item => ({ id: item.id, name: item.name, mediaType: item.mediaType, hasPath: typeof item.path === 'string' && item.path.length > 0 })),
      });
      if (context.endpoint.owner_kind === 'panel_agent' && context.endpoint.context === 'private' && context.prompt === 'BUSY') {
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
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  });
  const group = createTestGroup(bus, {
    name: 'update queueing',
    workspace: directory,
    lead: { name: 'lead', host: 'fake' },
  });
  await until(() => !bus.running.size);
  await createAgent(bus);
  bus.takeoverTeam(group.id, 0);

  const privateTurn = bus.panelPrivateTurn({ text: 'BUSY' });
  await until(() => typeof releasePrivate === 'function');
  const update = bus.publishPanelUpdate({
    panelAgentId: bus.panelAgent().id,
    groupId: group.id,
    sourceTurnId: null,
    text: '需要用户立即确认下一步。',
    sourceMessageIds: [],
  });
  await bus.pump();
  assert.equal(calls.filter(call => call.context === 'private').length, 1);

  releasePrivate();
  await privateTurn;
  await bus.pump();
  assert.equal(calls.filter(call => call.context === 'private').length, 1);
  assert.equal(panelAgg.updateById(bus.store, update.id).delivered_turn_id, null);
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
  await until(() => calls.some(call => call.context === 'coordination'));
  await until(() => !bus.running.size);
  assert.equal(messagesAgg.deliveryStateForMessage(bus.store, report.id).accepted != null, true);
  assert.ok(calls.some(call => call.context === 'coordination' && call.groupId === group.id));
  assert.equal(bus.store.pending().filter(m => m.group_id === group.id).length, 0);
});

test('private creation forwards to its team coordination and receives an explicit receipt', async t => {
 const directory = mkdtempSync(join(tmpdir(), 'agent-team-request-')); const base = hostFixture([]);
 let bus; let created; let privateCalls=0; const coordinationPrompts=[];
 const host={...base, async run(context) {
   if(context.endpoint.owner_kind==='panel_agent' && context.endpoint.context==='private') {
     privateCalls++; context.onAccepted();
     created=await context.onTool('team_create',{name:'request team',workspace:directory,members:'worker=fake'});
     const args={groupId:created.id,text:'do team work',operationId:'one'};
     const before=messagesAgg.byGroup(bus.store,created.id).filter(message=>message.text==='atomic rollback').length;
     const originalRun=bus.store.run.bind(bus.store);
     bus.store.run=(sql,...values)=>{if(sql.startsWith('INSERT INTO team_requests')) throw new Error('injected link failure');return originalRun(sql,...values);};
     try { await assert.rejects(context.onTool('team_request_submit',{...args,text:'atomic rollback',operationId:'rollback'}),/injected link failure/); }
     finally { bus.store.run=originalRun; }
     assert.equal(messagesAgg.byGroup(bus.store,created.id).filter(message=>message.text==='atomic rollback').length,before);
     const first=await context.onTool('team_request_submit',args);
     const second=await context.onTool('team_request_submit',args); assert.equal(first.id,second.id);
     const observer=createTestGroup(bus,{name:'observer team',workspace:directory,lead:{name:'other-lead',host:'fake'}});
     await assert.rejects(context.onTool('team_request_submit',{groupId:observer.id,text:'must reject',operationId:'observer'}),/不是该团队的主 Agent/);
     return 'transferred';
   }
   if(context.endpoint.owner_kind==='panel_agent' && context.endpoint.context==='coordination') {
     coordinationPrompts.push(context.prompt);
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
 t.after(async()=>{await bus.close();rmSync(directory,{recursive:true,force:true,maxRetries:20,retryDelay:100});});
 const state=await createAgent(bus); const response=await bus.panelPrivateTurn({ text: 'create and run' });
 await until(()=>!bus.running.size);
 const requests=bus.panelAgentState().requests; assert.equal(requests.length,1);
 assert.equal(requests[0].source_user_message_id,response.message.id);
 assert.equal(requests[0].original_text,'create and run'); assert.equal(requests[0].receipts.length,1);
 assert.equal(requests[0].receipts[0].text,'received');
 const privateReport = bus.store.get(
   "SELECT * FROM panel_messages WHERE panel_agent_id=? AND context='private' AND role='assistant' AND text LIKE '%received%'",
   state.agent.id,
 );
 assert.ok(privateReport, '回执应同步为私聊汇报消息(assistant)');
 assert.deepEqual(bus.queryUnread().receipts, requests.flatMap(request => request.receipts).map(({id,isSourceCopy,sourceMessageIds}) => ({id,isSourceCopy,sourceMessageIds})));  assert.equal(privateCalls,1);
 assert.equal(response.message.active_team_id,null);
 const message=bus.store.get('SELECT * FROM messages WHERE id=?',requests[0].message_id);
 assert.equal(message.sender,'user'); assert.equal(message.recipient,state.agent.id);

 // 未回执的请求随回合输入注入:第一回合可见(requestId/operationId 齐备);
 // 回执发布后,后续协调回合的输入不再携带,注入自动消失。
 assert.match(coordinationPrompts[0], /"awaitingReceipt"/);
 assert.match(coordinationPrompts[0], /"operationId":"one"/);
 bus.directive(created.id, '请确认回执状态');
 await until(()=>coordinationPrompts.length>=2 && !bus.running.size);
 assert.ok(!coordinationPrompts.at(-1).includes('awaitingReceipt'), '回执发布后注入应消失');
});

test('lead takeover and handback are revisioned and require an idle team', async t => {
  const { bus, directory } = await fixture(t);
  const group = createTestGroup(bus, {
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
  const first = createTestGroup(bus, {
    name: 'first',
    workspace: directory,
    lead: { name: 'lead-a', host: 'fake' },
  });
  const second = createTestGroup(bus, {
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
 const group=createTestGroup(bus,{name:'legacy',workspace:directory,lead:{name:'lead',host:'fake'}});
 await until(()=>!bus.running.size);
 await assert.rejects(bus.panelPrivateTurn({ text: 'legacy write', activeTeamId: group.id }),/团队对话已迁移/);
 assert.equal(panelAgg.messagesForActiveTeam(bus.store,group.id).length,0);
});

test('unknown Panel Agent runtime blocks the session until the user verifies it stopped', async t => {
  const { bus } = await fixture(t);
  const state = await createAgent(bus);
  const session = bus.store.panelSession(state.agent.id, 'private');
  bus.store.run(
    'INSERT INTO turns(id,conversation_id,executor_kind,executor_id,group_id,session,active_team_id,source_user_message_id,state,detail,created,ended) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    'unknown-panel-turn',
    session.id,
    'panel_agent',
    state.agent.id,
    null,
    session.session ?? null,
    null,
    null,
    'unknown',
    null,
    new Date().toISOString(),
    null,
  );
  await assert.rejects(bus.panelPrivateTurn({ text: 'must wait' }), /待核实运行/);
  bus.resolvePanelRuntime('unknown-panel-turn', '用户确认宿主进程已停止');
  const result = await bus.panelPrivateTurn({ text: 'resume' });
  assert.equal(result.result, 'panel reply');
});

test('Panel Agent identity, private conversation and session survive restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-panel-restart-'));
  const hosts = new Map([['fake', hostFixture([])]]);
  let bus = new Bus({ directory, hosts });
  bus.start();
  await createAgent(bus);
  await bus.panelPrivateTurn({ text: 'persist me' });
  const before = bus.panelAgentState();
  const sessionBefore = bus.store.panelSession(before.agent.id, 'private').session;
  await bus.close();

  bus = new Bus({ directory, hosts });
  bus.start();
  t.after(async () => {
    await bus.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  });
  const after = bus.panelAgentState();
  assert.equal(after.agent.id, before.agent.id);
  assert.deepEqual(after.conversation.map(message => message.role), ['user', 'assistant']);
  assert.equal(bus.store.panelSession(after.agent.id, 'private').session, sessionBefore);
});

test('summary preserves conversation team attribution for unread counts', async t => {
  const { bus, directory } = await fixture(t);
  const group = createTestGroup(bus, {
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
  bus.running.set('test-private', { endpoint: { context: 'private', owner_kind: 'panel_agent' }, turnId: 'private', abort: privateAbort, done: Promise.resolve() });
  bus.running.set('test-team', { endpoint: { context: 'coordination', owner_kind: 'panel_agent' }, turnId: 'team', abort: teamAbort, done: Promise.resolve() });
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
 t.after(async()=>{await bus.close();rmSync(directory,{recursive:true,force:true,maxRetries:20,retryDelay:100});});
 const state=await createAgent(bus);
 for(let i=0;i<205;i++) bus.store.panelAppend(state.agent.id,'private','assistant','old '+i,i%2?'legacy-team':null);
 const hosts=bus.hosts;await bus.close();bus=new Bus({directory,hosts});
 assert.equal(bus.panelBrowserState().conversation.length,0);
 const first=bus.panelMessagePage({history:true});const second=bus.panelMessagePage({history:true,before:first.nextBefore});
 assert.equal(first.messages.length,200);assert.equal(second.messages.length,5);assert.equal(second.nextBefore,null);
 assert.ok(second.messages.at(-1).seq<first.messages[0].seq);
 bus.store.panelAppend(state.agent.id,'private','assistant','new');
 assert.equal(bus.panelBrowserState().conversation[0].text,'new');
 assert.equal(bus.panelMessagePage().messages.length,1);
 assert.equal(bus.panelMessagePage({history:true}).messages.length,200);
});

test('panel private turns bind attachments, record requests and replay idempotently', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-panel-att-'));
  const workspace = mkdtempSync(join(tmpdir(), 'agent-team-panel-ws-'));
  const calls = [];
  const host = hostFixture(calls);
  const bus = new Bus({ directory, hosts: new Map([['fake', host]]) });
  bus.start();
  t.after(async () => {
    await bus.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
    try { rmSync(workspace, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  });
  const state = await createAgent(bus, workspace);
  const agentId = state.agent.id;
  await until(() => !bus.running.size);

  const first = await bus.attachmentUpload(agentId, Buffer.from('alpha content'), { name: 'a.txt', mediaType: 'text/plain' });
  const second = await bus.attachmentUpload(agentId, Buffer.from('beta content'), { name: 'b.txt', mediaType: 'text/plain' });

  // 附件-only 消息成功,按用户顺序绑定;宿主收到结构化输入(含内部路径)。
  const clientMessageId = randomUUID();
  const sent = await bus.panelPrivateTurn({ text: '', clientMessageId, attachmentIds: [first.id, second.id] });
  assert.ok(sent.message.id);
  await until(() => !bus.running.size);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].prompt, '');
  assert.deepEqual(calls[0].attachments, [
    { id: first.id, name: 'a.txt', mediaType: 'text/plain', hasPath: true },
    { id: second.id, name: 'b.txt', mediaType: 'text/plain', hasPath: true },
  ]);

  // 绑定与 request 记录持久化;会话行携带附件 DTO(不含路径)。
  assert.deepEqual(bus.store.panelAttachments(sent.message.id).map(row => row.id), [first.id, second.id]);
  const conversationRow = bus.panelBrowserState().conversation.find(row => row.id === sent.message.id);
  assert.deepEqual(conversationRow.attachments.map(row => row.id), [first.id, second.id]);
  assert.deepEqual(Object.keys(conversationRow.attachments[0]).sort(), ['availability', 'id', 'mediaType', 'name', 'size']);
  // 附件路径不泄漏到浏览器可见状态;用户正文保持原文(附件-only 为空)。
  assert.equal(conversationRow.text, '');
  assert.ok(!JSON.stringify(bus.panelBrowserState().conversation).includes(workspace), '会话行不泄漏工作区路径');

  // 同 ID 同 payload 重试:同一 messageId,不新增消息/回合/request。
  const replay = await bus.panelPrivateTurn({ text: '', clientMessageId, attachmentIds: [first.id, second.id] });
  assert.equal(replay.message.id, sent.message.id);
  assert.equal(replay.result.replayed, true);
  await until(() => !bus.running.size);
  assert.equal(calls.length, 1, '重试不触发第二条回合');
  assert.ok(panelAgg.panelPrivateOperation(bus.store, agentId, clientMessageId));
  assert.equal(panelAgg.privateMessagesForState(bus.store, agentId).filter(row => row.role === 'user').length, 1);

  // 同 ID 改正文、改附件集合、改顺序 → 409 语义冲突。
  for (const mutated of [
    { text: '改成别的', clientMessageId, attachmentIds: [first.id] },
    { text: '', clientMessageId, attachmentIds: [first.id] },
    { text: '', clientMessageId, attachmentIds: [second.id, first.id] },
  ]) {
    await assert.rejects(
      () => bus.panelPrivateTurn(mutated),
      error => error.code === 'conflict',
    );
  }

  // 已绑定附件不能用于第二条消息。
  await assert.rejects(
    () => bus.panelPrivateTurn({ text: '再发一次', attachmentIds: [first.id] }),
    error => error.code === 'conflict',
  );

  // 畸形/跨 agent 附件在 host.run 前拒绝,不产生 turn。
  const turnsBefore = turnsAgg.list(bus.store, { executorKind: 'panel_agent' }).length;
  await assert.rejects(() => bus.panelPrivateTurn({ text: '坏的', attachmentIds: [randomUUID()] }), error => error.code === 'not_found');
  assert.equal(turnsAgg.list(bus.store, { executorKind: 'panel_agent' }).length, turnsBefore);

  // 空正文且空附件拒绝;旧式纯文本请求继续通过。
  await assert.rejects(() => bus.panelPrivateTurn({ text: '   ' }), /消息内容不能为空/);
  const plain = await bus.panelPrivateTurn({ text: 'plain text' });
  assert.ok(plain.message.id);
  await until(() => !bus.running.size);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].attachments, []);
});

test('attachment metadata survives a service restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-panel-att-restart-'));
  const workspace = mkdtempSync(join(tmpdir(), 'agent-team-panel-ws2-'));
  let bus = new Bus({ directory, hosts: new Map([['fake', hostFixture()]]) });
  bus.start();
  t.after(async () => {
    await bus.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
    try { rmSync(workspace, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  });
  const state = await createAgent(bus, workspace);
  const uploaded = await bus.attachmentUpload(state.agent.id, Buffer.from('restart me'), { name: 'r.txt', mediaType: 'text/plain' });
  const clientMessageId = randomUUID();
  const sent = await bus.panelPrivateTurn({ text: '', clientMessageId, attachmentIds: [uploaded.id] });
  await until(() => !bus.running.size);
  const hosts = bus.hosts;
  await bus.close();

  bus = new Bus({ directory, hosts });
  bus.start();
  const row = bus.panelMessagePage({ history: true }).messages.find(message => message.id === sent.message.id);
  assert.ok(row, '重启后历史行仍在');
  assert.deepEqual(row.attachments.map(item => ({ id: item.id, name: item.name, availability: item.availability })), [
    { id: uploaded.id, name: 'r.txt', availability: 'available' },
  ]);
  // request 记录同样持久:同 ID 重试仍回放原消息,不再创建新消息。
  const replay = await bus.panelPrivateTurn({ text: '', clientMessageId, attachmentIds: [uploaded.id] });
  assert.equal(replay.message.id, sent.message.id);
  assert.equal(replay.result.replayed, true);
});

test('snapshot and runtime queries exclude one-time summary sessions and expose panel owner ids', async t => {
  const { bus, directory } = await fixture(t);
  const group = createTestGroup(bus, {
    name: 'runtime projection',
    workspace: directory,
    lead: { name: 'lead', host: 'fake' },
    members: [{ name: 'worker', host: 'fake' }],
  });
  await until(() => !bus.running.size);
  const state = await createAgent(bus);
  const agentId = state.agent.id;
  const coordination = bus.store.panelSession(agentId, 'coordination', group.id);
  const privateSession = bus.store.panelSession(agentId, 'private', group.id);
  const homeSummary = bus.store.panelSession(agentId, 'home-summary');
  const archiveSummary = bus.store.panelSession(agentId, 'archive-summary');
  const live = (session, overrides = {}) => ({
    endpoint: { ...session, ...overrides },
    turnId: `turn-${session.id}`,
    created: Date.now(),
    abort() {},
  });
  bus.running.set(coordination.id, live(coordination, { group_id: group.id }));
  bus.running.set(privateSession.id, live(privateSession, { group_id: group.id }));
  bus.running.set(homeSummary.id, live(homeSummary, { group_id: null }));
  bus.running.set(archiveSummary.id, live(archiveSummary, { group_id: null }));

  // 一次性摘要会话与私聊不进入团队可见端点,只有协调会话保留。
  const visibleIds = bus.store.conversationsForGroup(group.id).map(conversation => conversation.id);
  assert.ok(visibleIds.includes(coordination.id));
  for (const hidden of [privateSession.id, homeSummary.id, archiveSummary.id]) assert.equal(visibleIds.includes(hidden), false);
  const defaultContexts = bus.store.conversationsForGroup(undefined).map(conversation => conversation.context);
  for (const hidden of ['private', 'home-summary', 'archive-summary']) assert.equal(defaultContexts.includes(hidden), false);
  const allContexts = bus.store.conversationsForGroup(undefined, { includePrivate: true }).map(conversation => conversation.context);
  for (const hidden of ['private', 'home-summary', 'archive-summary']) assert.ok(allContexts.includes(hidden));

  const snapshot = bus.snapshot(group.id);
  assert.deepEqual(snapshot.runningEndpoints, [coordination.id]);
  assert.deepEqual(snapshot.panelRunning.filter(row => row.endpoint === coordination.id).map(row => row.groupId), [group.id]);
  assert.equal(snapshot.endpoints.some(endpoint => ['private', 'home-summary', 'archive-summary'].includes(endpoint.context)), false);

  assert.deepEqual(bus.queryRuntime(group.id), [{ id: coordination.id, group_id: group.id, member_id: agentId }]);
  assert.deepEqual(bus.queryRuntime().map(row => row.id), [coordination.id]);

  // Panel 协作会话沿用对外 panel-coordination 词汇,其它 context 保持原样。
  assert.equal(bus.querySession(group.id, coordination.id).context, 'panel-coordination');
  assert.equal(bus.querySession(group.id, privateSession.id), null);
  bus.running.clear();
});
});

describe('panel-access', () => {
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
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
    try { rmSync(workspace, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
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
    try { rmSync(fakeHome, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
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
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
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
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
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
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
    try { rmSync(workspace, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  });

  const files = writeMcpFiles(directory, join(directory, 'bus.sock'), { id: 'endpoint-1', key: 'key-1' }, 'turn-1', {
    mode: 'full-access', allowShell: true, access: 'full-access', workspace, tools: ['mcp__agent_team__team_read'],
  });
  const patch = JSON.parse(readFileSync(files.dsh, 'utf8'));
  assert.equal(patch.find(entry => entry.id === 'sandbox-policy').config.mode, 'danger-full-access');
  assert.equal(patch.find(entry => entry.id === 'permission').config.presets.team.sandbox, 'danger-full-access');
  const inserted = patch.flatMap(entry => entry.insert ?? []);
  // 文件路径型插件(以 .mjs 结尾)必须真实存在:写错路径会让 dsh 启动即
  // ERR_MODULE_NOT_FOUND。包名型插件(如 dsh-mcp-client)由 dsh 自行解析,跳过。
  for (const entry of inserted.filter(item => item.name.endsWith('.mjs'))) {
    assert.ok(
      existsSync(entry.name),
      `DSH 插件 ${entry.id} 的路径不存在: ${entry.name}`,
    );
  }
  const plugin = inserted.find(entry => entry.id === 'agent-team-policy');
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
    try { rmSync(fakeHome, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  });

  const { bus } = await fixture(t);
  // 未提供 workspace:创建时自动使用默认目录并确保存在。
  const state = await bus.createPanelAgent({ ...baseAgent });
  const workspace = state.agent.workspace;
  assert.equal(workspace, join(fakeHome, 'Documents', 'AgentTeam'), '默认工作区落在临时 HOME 下');
  assert.ok(await import('node:fs').then(fs => fs.existsSync(workspace)), '默认工作区已创建');
  // 显式提供的工作区仍然按原样校验使用。
  const explicit = mkdtempSync(join(tmpdir(), 'agent-explicit-ws-'));
  t.after(() => { try { rmSync(explicit, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ } });
  const updated = await bus.updatePanelAgent({ workspace: explicit, access: 'workspace-write' });
  assert.equal(updated.agent.workspace, explicit);
});
});

describe('panel-streaming', () => {
const until = async fn => {
  for (let index = 0; index < 400; index += 1) {
    if (fn()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('timeout');
};

function catalog() {
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
}

function streamingHost(control) {
  return {
    async listModels() {
      return catalog();
    },
    async run(context) {
      context.onSession(context.endpoint.session ?? 'fake-session');
      context.onAccepted();
      if (context.endpoint.context === 'profile') return 'ready';
      context.onReasoningDelta('想', { part: 'r1' });
      context.onReasoningDelta('法', { part: 'r2' });
      context.onTextDelta('你', { part: 1 });
      context.onTextDelta('好', { part: 2 });
      await new Promise(resolve => {
        control.release = resolve;
      });
      return '你好';
    },
  };
}

async function createPanel(bus, workspace) {
  await bus.createPanelAgent({
    name: 'Panel Agent',
    host: 'fake',
    model_provider: 'fake-provider',
    model: 'fake-model',
    reasoning_effort: 'low',
    workspace,
    access: 'workspace-write',
  });
}

test('Panel streaming state accumulates deltas and is replaced by the durable final reply', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-panel-stream-'));
  const workspace = mkdtempSync(join(tmpdir(), 'agent-panel-stream-work-'));
  const control = {};
  const bus = new Bus({
    directory,
    hosts: new Map([['fake', streamingHost(control)]]),
  });
  t.after(async () => {
    await bus.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
    try { rmSync(workspace, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  });
  await createPanel(bus, workspace);
  const events = [];
  bus.on('panel-stream', event => events.push(event));

  const pending = bus.panelPrivateTurn({ text: 'stream this' });
  await until(() => bus.panelAgentState().streaming?.[0]?.text === '你好');
  const active = bus.panelAgentState().streaming[0];
  assert.equal(active.context, 'private');
  assert.equal(active.text, '你好');
  assert.equal(active.reasoning, '想法');
  assert.equal(events.filter(event => event.type === 'delta').length, 2);
  assert.ok(
    events
      .filter(event => event.type === 'delta')
      .every(event => event.stream.text === '' && event.delta.length > 0),
  );
  assert.equal(events.filter(event => event.type === 'reasoning-delta').length, 2);
  assert.ok(
    events
      .filter(event => event.type === 'reasoning-delta')
      .every(event => event.stream.reasoning === '' && event.delta.length > 0),
  );

  control.release();
  const result = await pending;
  assert.equal(result.result, '你好');
  assert.deepEqual(bus.panelAgentState().streaming, []);
  assert.deepEqual(bus.panelAgentState().conversation.map(message => message.role), ['user', 'assistant']);
  assert.equal(bus.panelAgentState().conversation.at(-1).text, '你好');
  const complete = events.find(event => event.type === 'complete');
  assert.equal(complete.stream.text, '你好');
  assert.equal(complete.stream.reasoning, '想法');
});

test('Panel SSE sends live deltas and completion over the local event stream', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-panel-sse-'));
  const workspace = mkdtempSync(join(tmpdir(), 'agent-panel-sse-work-'));
  const control = {};
  const server = await startServer({
    directory,
    hosts: new Map([['fake', streamingHost(control)]]),
  });
  const abort = new AbortController();
  let closed = false;
  t.after(async () => {
    if (!closed) await server.close();
    abort.abort();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
    try { rmSync(workspace, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  });
  await createPanel(server.bus, workspace);
  const base = new URL(server.url).origin;
  const events = await fetch(`${base}/api/panel-agent/events`, {
    signal: abort.signal,
  });
  assert.match(events.headers.get('content-type'), /^text\/event-stream/);
  const reader = events.body.getReader();
  const decoder = new TextDecoder();
  let received = '';
  const readUntil = async pattern => {
    while (!pattern.test(received)) {
      const { value, done } = await reader.read();
      if (done) break;
      received += decoder.decode(value, { stream: true });
    }
    assert.match(received, pattern);
  };

  const pending = fetch(`${base}/api/panel-agent/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ text: 'live reply' }),
    signal: abort.signal,
  });
  await readUntil(/"type":"reasoning-delta".*"delta":"想"/);
  await readUntil(/"type":"delta".*"text":"".*"delta":"你"/);
  control.release();
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal((await response.json()).reply.text, '你好');
  await readUntil(/"type":"complete".*"text":"你好"/);
  await server.close();
  closed = true;
  abort.abort();
});

test('Panel stream exposes the run phase and clears it after a tool call', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-panel-phase-'));
  const workspace = mkdtempSync(join(tmpdir(), 'agent-panel-phase-work-'));
  const control = {};
  const toolHost = {
    async listModels() {
      return catalog();
    },
    async run(context) {
      context.onSession(context.endpoint.session ?? 'fake-session');
      context.onAccepted();
      if (context.endpoint.context === 'profile') return 'ready';
      context.onReasoningDelta('看', { part: 'r1' });
      await context.onTool('teams_list', {});
      context.onTextDelta('好', { part: 1 });
      await new Promise(resolve => {
        control.release = resolve;
      });
      return '好';
    },
  };
  const bus = new Bus({ directory, hosts: new Map([['fake', toolHost]]) });
  t.after(async () => {
    await bus.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
    try { rmSync(workspace, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  });
  await createPanel(bus, workspace);
  const events = [];
  bus.on('panel-stream', event => events.push(event));

  const pending = bus.panelPrivateTurn({ text: 'check phase' });
  await until(() => bus.panelAgentState().streaming?.[0]?.text === '好');
  // 先放行并等回合收尾,再做断言:断言失败时不会把宿主的等待 promise 永久悬空。
  const livePhase = bus.panelAgentState().streaming[0].runPhase;
  const phaseEvents = events.filter(event => event.type === 'phase');
  control.release();
  await pending;

  const start = events.find(event => event.type === 'start');
  assert.equal(start.stream.runPhase, 'accepted');
  // 思考增量自带新阶段,无需额外 phase 事件。
  assert.equal(events.find(event => event.type === 'reasoning-delta').stream.runPhase, 'thinking');
  assert.equal(phaseEvents[0].stream.runPhase, 'tool');
  assert.equal(phaseEvents[0].stream.tool.name, 'teams_list');
  // 工具结束后回到内容阶段,并清掉工具名。
  assert.deepEqual(phaseEvents.at(-1).stream.tool, null);
  // 正文增量把阶段推进到输出中,该信息随 delta 事件下发。
  assert.equal(events.filter(event => event.type === 'delta').at(-1).stream.runPhase, 'writing');
  assert.equal(livePhase, 'writing');
  assert.deepEqual(bus.panelAgentState().streaming, []);
});

test('team SSE sends directive deltas before the durable team reply', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-sse-'));
  const control = {};
  const server = await startServer({
    directory,
    hosts: new Map([['fake', streamingHost(control)]]),
  });
  const abort = new AbortController();
  let closed = false;
  t.after(async () => {
    if (!closed) await server.close();
    abort.abort();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  });
  const group = createTestGroup(server.bus, {
    name: 'team stream',
    workspace: directory,
    lead: { name: 'Lead', host: 'fake' },
    members: [],
  });
  await until(() => !server.bus.running.size);
  const base = new URL(server.url).origin;
  const events = await fetch(
    `${base}/api/teams/${group.id}/events`,
    { signal: abort.signal },
  );
  assert.match(events.headers.get('content-type'), /^text\/event-stream/);
  const reader = events.body.getReader();
  const decoder = new TextDecoder();
  let received = '';
  const lateAbort = new AbortController();
  const readUntil = async pattern => {
    while (!pattern.test(received)) {
      const { value, done } = await reader.read();
      if (done) break;
      received += decoder.decode(value, { stream: true });
    }
    assert.match(received, pattern);
  };
  const pending = fetch(`${base}/api/teams/${group.id}/directives`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      text: 'stream to team',
      operationId: 'team-stream',
      controllerId: group.lead,
    }),
    signal: abort.signal,
  });
  await readUntil(/"type":"reasoning-delta".*"delta":"想"/);
  await readUntil(/"type":"delta".*"delta":"你"/);
  const lateEvents = await fetch(
    `${base}/api/teams/${group.id}/events`,
    { signal: lateAbort.signal },
  );
  const lateReader = lateEvents.body.getReader();
  let lateReceived = '';
  while (!/"type":"snapshot".*"text":"你好"/.test(lateReceived)) {
    const { value, done } = await lateReader.read();
    if (done) break;
    lateReceived += decoder.decode(value, { stream: true });
  }
  assert.match(lateReceived, /"type":"snapshot".*"text":"你好"/);
  lateAbort.abort();
  control.release();
  const response = await pending;
  assert.equal(response.status, 200);
  const receipt = await response.json();
  await readUntil(/"type":"complete".*"text":"你好"/);
  const reply = server.bus.store.get(
    'SELECT * FROM messages WHERE reply_to=?',
    receipt.messageId,
  );
  assert.equal(reply.text, '你好');
  await server.close();
  closed = true;
  abort.abort();
});
});

describe('panel-agent-http', () => {
async function until(fn) {
  for (let index = 0; index < 400; index++) {
    if (fn()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('timeout');
}

const fakeHost = {
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
    context.onSession(context.endpoint.session ?? context.endpoint.id);
    context.onAccepted();
    return context.endpoint.context.startsWith('panel-') ? 'panel reply' : 'done';
  },
};

test('Panel Agent HTTP API lazily creates identity and controls team relations', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-panel-http-'));
  const server = await startServer({
    directory,

    hosts: new Map([['fake', fakeHost]]),
  });
  t.after(async () => {
    await server.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  });
  const group = server.bus.createGroup({
    name: 'legacy team',
    workspace: directory,
    lead: { name: 'lead', host: 'fake' },
    members: [{ name: 'worker', host: 'fake' }],
  });
  const base = new URL(server.url).origin;

  const empty = await (await fetch(base + '/api/panel-agent')).json();
  assert.equal(empty.agent, null);

  const createdResponse = await fetch(base + '/api/panel-agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      name: 'Panel Agent',
      host: 'fake',
      model_provider: 'fake-provider',
      model: 'fake-model',
      reasoning_effort: 'low',
    }),
  });
  assert.equal(createdResponse.status, 200);
  const created = await createdResponse.json();
  assert.equal(created.agent.name, 'Panel Agent');
  assert.equal(created.teams.find(team => team.id === group.id).relation, 'observer');
  assert.equal(server.bus.members(group.id).some(member => member.id === created.agent.id), false);

  const chatResponse = await fetch(base + '/api/panel-agent/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ text: '总结当前团队' }),
  });
  assert.equal(chatResponse.status, 200);
  const conversation = await (await fetch(base + '/api/panel-agent')).json();
  assert.deepEqual(conversation.conversation.map(message => message.role), ['user', 'assistant']);
  assert.equal(conversation.conversation[0].active_team_id, null);
  // 公共消息投影里没有这条私人聊天（panel 私聊不写群消息）。
  const groupMessages = await (await fetch(base + `/api/messages?group=${group.id}`)).json();
  assert.equal(groupMessages.some(message => message.text === '总结当前团队'), false);

  const privateSession = server.bus.store.panelSession(created.agent.id, 'private');
  const approvedTeam = await server.bus.panelTool(
    privateSession.id,
    privateSession.key,
    'team_create',
    {
      name: 'panel-created over HTTP',
      workspace: directory,
      members: 'created-worker=fake',
    },
  );
  assert.equal(approvedTeam.lead, null);
  assert.equal(server.bus.panelTeamRelation(approvedTeam.id), 'main');

  const takeoverRequest = await server.bus.panelTool(
    privateSession.id,
    privateSession.key,
    'request_team_takeover',
    { groupId: group.id },
    { activeTeamId: group.id },
  );
  assert.equal(takeoverRequest.kind, 'takeover');
  assert.equal(takeoverRequest.state, 'pending');
  const takeoverResponse = await fetch(base + `/api/interactions/${takeoverRequest.id}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ answer: { approved: true } }),
  });
  assert.equal(takeoverResponse.status, 200);
  const taken = await takeoverResponse.json();
  assert.equal(taken.state, 'answered');
  assert.equal(server.bus.controllerState(group.id).controller.kind, 'panel_agent');
  assert.equal(server.bus.controllerState(group.id).panelRelation, 'main');
  const coordinationSession = server.bus.store.panelSession(created.agent.id, 'coordination', group.id);
  assert.equal((await fetch(base + `/api/history?endpoint=${coordinationSession.id}`)).status, 200);
  assert.equal((await fetch(base + `/api/models?endpoint=${coordinationSession.id}`)).status, 200);
  await until(() => !server.bus.running.size);
  const beforeTeamChat = server.bus.panelAgentState().conversation.length;
  const teamFirstChat = await rpc(server.socketPath, {
    op: 'chat',
    group: group.id,
    text: '从团队入口发起的私人消息',
  });
  assert.equal(teamFirstChat.status, 'queued');
  await until(() => !server.bus.running.size);
  const afterTeamChat = await (await fetch(base + '/api/panel-agent')).json();
  assert.equal(afterTeamChat.conversation.at(-1).active_team_id, null);
  assert.equal(afterTeamChat.conversation.length, beforeTeamChat);
  // 公共消息列表里该指令的 recipient 是 Panel Agent 身份。
  const teamMessages = await (await fetch(base + `/api/messages?group=${group.id}&latest=1`)).json();
  assert.equal(teamMessages.find(message => message.id === teamFirstChat.messageId)?.recipient, created.agent.id);

  const staleHandback = await fetch(base + `/api/teams/${group.id}/handback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: 0 }),
  });
  assert.equal(staleHandback.status, 400);

  const action = server.bus.requestPanelControllerAction(
    created.agent,
    server.bus.store.panelSession(created.agent.id, 'private'),
    { turnId: 'test-turn', callId: 'test-call', activeTeamId: group.id },
    'handback',
    group.id,
  );
  assert.equal(action.kind, 'handback');
  assert.equal(action.state, 'pending');
  const handback = await fetch(base + `/api/interactions/${action.id}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ answer: { approved: true } }),
  });
  assert.equal(handback.status, 200);
  const returned = await handback.json();
  assert.equal(returned.state, 'answered');
  assert.equal(returned.answer.approved, true);
  assert.equal(server.bus.controllerState(group.id).controller.kind, 'member');
  assert.equal(server.bus.controllerState(group.id).panelRelation, 'observer');

  const plainText = await fetch(base + '/api/panel-agent/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: 'hello',
  });
  assert.equal(plainText.status, 415);
});

test('panel messages accept clientMessageId with attachments and replay idempotently', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'panel-att-http-'));
  const workspace = mkdtempSync(join(tmpdir(), 'panel-att-ws-'));
  const server = await startServer({ directory, hosts: new Map([['fake', fakeHost]]) });
  t.after(async () => {
    await server.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
    try { rmSync(workspace, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  });
  const bus = server.bus;
  const base = new URL(server.url).origin;
  await fetch(base + '/api/panel-agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Panel Agent',
      host: 'fake',
      model_provider: 'fake-provider',
      model: 'fake-model',
      reasoning_effort: 'low',
      workspace,
      access: 'workspace-write',
    }),
  });
  await until(() => !bus.running.size);

  // 经生产上传接口取得附件。
  const upload = await fetch(base + '/api/panel-agent/attachments', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'X-Agent-Team-Filename': encodeURIComponent('http.txt') },
    body: 'attachment via http',
  });
  assert.equal(upload.status, 201);
  const { id: attachmentId } = await upload.json();

  // 附件-only + clientMessageId 发送。
  const clientMessageId = randomUUID();
  const send = await fetch(base + '/api/panel-agent/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '', activeTeamId: null, clientMessageId, attachmentIds: [attachmentId] }),
  });
  assert.equal(send.status, 200);
  const sent = await send.json();
  assert.ok(sent.message.id);
  await until(() => !bus.running.size);

  // 同 ID 同 payload 重试:返回同一消息,不再触发回合。
  const retry = await fetch(base + '/api/panel-agent/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '', activeTeamId: null, clientMessageId, attachmentIds: [attachmentId] }),
  });
  assert.equal(retry.status, 200);
  const replayed = await retry.json();
  assert.equal(replayed.message.id, sent.message.id);
  assert.equal(replayed.result.replayed, true);
  // 公共记录投影：幂等重放没有追加第二条 user 消息。
  const records = await (await fetch(base + '/api/panel-agent/records')).json();
  assert.equal(records.messages.filter(message => message.role === 'user').length, 1);

  // 同 ID 不同正文 → 409 稳定错误。
  const conflict = await fetch(base + '/api/panel-agent/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '别的正文', activeTeamId: null, clientMessageId }),
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, 'conflict');

  // 未知附件 ID → 404 稳定错误,不进入宿主回合。
  const missing = await fetch(base + '/api/panel-agent/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '带坏附件', attachmentIds: [randomUUID()] }),
  });
  assert.equal(missing.status, 404);

  // 旧客户端(无 clientMessageId、无附件)继续通过。
  const legacy = await fetch(base + '/api/panel-agent/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'legacy text', activeTeamId: null }),
  });
  assert.equal(legacy.status, 200);

  // 会话行携带附件 DTO。
  const state = await (await fetch(base + '/api/panel-agent')).json();
  const row = state.conversation.find(message => message.id === sent.message.id);
  assert.deepEqual(row.attachments.map(item => item.id), [attachmentId]);
  assert.deepEqual(Object.keys(row.attachments[0]).sort(), ['availability', 'id', 'mediaType', 'name', 'size']);
});
});
