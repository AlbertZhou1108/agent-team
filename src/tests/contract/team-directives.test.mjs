import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../server.mjs';
import { createTestGroup } from '../support/fixture.mjs';
const tick = () => new Promise(r => setImmediate(r));
async function until(fn) { for (let i=0;i<300;i++) { if(fn())return; await new Promise(r=>setTimeout(r,5)); } throw Error('timeout'); }
async function setup(t, run, { members = [] } = {}) {
 const directory=mkdtempSync(join(tmpdir(),'team-directives-'));
 const calls=[];
 const host={async listModels(){return{version:1,host:'fake',source:'test',defaultModel:'test',models:[{id:'test',key:'test',reasoningEfforts:[{id:'low'}]}]};},async run(c){c.onSession(c.endpoint.session??c.endpoint.id);if(c.endpoint.context==='profile'){await c.onTool('profile_set',{text:'ready'});c.onAccepted();return''}calls.push(c);if(run)return run(c);c.onAccepted();return'done'}};
 let server=await startServer({directory,hosts:new Map([['fake',host]])});
 t.after(async()=>{await server.close();rmSync(directory,{recursive:true,force:true})});
 const group=createTestGroup(server.bus,{name:'directives',workspace:directory,lead:{name:'Lead',host:'fake'},members});await until(()=>!server.bus.running.size);
 const send=(body,headers={})=>fetch(new URL(`/api/teams/${group.id}/directives`,server.url),{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
 const read=async()=>{const r=await fetch(new URL(`/api/teams/${group.id}/directives`,server.url));return r.json()};
 return{get server(){return server},group,calls,send,read,restart:async()=>{await until(()=>!server.bus.running.size);await server.close();server=await startServer({directory,hosts:new Map([['fake',host]])});}};
}
test('HTTP directives work without cookies, reject cross-origin/forged identity and validate text',async t=>{
 const f=await setup(t),body={text:'hello',operationId:'one',controllerId:f.group.lead};
 assert.equal((await f.send(body,{cookie:''})).status,200);
 assert.equal((await f.send(body,{origin:'https://attacker.example'})).status,403);
 assert.equal((await f.send(body,{'sec-fetch-site':'cross-site'})).status,403);
 assert.equal((await f.send({...body,text:' '})).status,400);
 assert.equal((await f.send({...body,text:'x'.repeat(48001)})).status,400);
 assert.equal((await f.send({...body,sender:'member'})).status,400);
 assert.equal((await f.send({...body,controllerId:'stale-controller'})).status,400);
 // 公共预览：只有一次有效指令落库（被拒请求不产生指令）。
 assert.equal((await f.read()).length,1);
});
test('retry after lost acknowledgement is durable, idempotent and reports actual delivery',async t=>{
 const f=await setup(t),body={text:' hello ',operationId:'durable',controllerId:f.group.lead};
 const first=await f.send(body);assert.equal(first.status,200);const receipt=await first.json();assert.equal(receipt.status,'queued');
 const duplicate=await(await f.send(body)).json();assert.equal(duplicate.messageId,receipt.messageId);
 assert.equal((await f.send({...body,text:'changed'})).status,400);
 await until(()=>!f.server.bus.running.size);assert.equal((await f.read())[0].status,'delivered');
 // 公共消息列表校验指令落库的发送者与接收者。
 const sentMessages=await(await fetch(new URL(`/api/messages?group=${f.group.id}&latest=1`,f.server.url))).json();
 const msg=sentMessages.find(message=>message.id===receipt.messageId);
 assert.equal(msg.sender,'user');assert.equal(msg.recipient,f.group.lead);
 await f.restart();const again=await(await f.send(body)).json();assert.equal(again.messageId,receipt.messageId);
 // 公共预览：重启 + 幂等重放后仍只有一条指令。
 assert.equal((await f.read()).length,1);
});
test('busy lead queues the next directive and keeps both messages in coordination',async t=>{
 let release;let first=true;
 const f=await setup(t,async c=>{c.onAccepted();if(first){first=false;await new Promise(r=>{release=r;c.signal.addEventListener('abort',r,{once:true})})}return'done'});
 const body={text:'first',operationId:'a',controllerId:f.group.lead};await f.send(body);await until(()=>Boolean(release));
 const next=await(await f.send({...body,text:'second',operationId:'b'})).json();assert.equal(next.status,'queued');assert.equal(f.calls.length,1);
 release();await until(()=>f.calls.length===2&&!f.server.bus.running.size);assert.equal((await f.read()).find(r=>r.messageId===next.messageId).status,'delivered');
 assert.ok(f.calls.every(c=>c.endpoint.context==='coordination'));
});
test('delivery failure is visible and does not turn retrying HTTP into duplicate dispatch',async t=>{
 const f=await setup(t,async()=>{throw Error('host unavailable')});const body={text:'hello',operationId:'failed',controllerId:f.group.lead};
 const receipt=await(await f.send(body)).json();await until(()=>!f.server.bus.running.size);await tick();
 assert.equal((await f.read())[0].status,'failed');assert.match((await f.read())[0].error,/host unavailable/);
 assert.equal((await(await f.send(body)).json()).messageId,receipt.messageId);assert.equal(f.calls.length,1);
});
test('controller change rejects stale submissions; panel takeover routes to its coordination and private stays untouched',async t=>{
 const f=await setup(t);await f.server.bus.createPanelAgent({name:'Panel',host:'fake',model:'test',reasoning_effort:'low'});
 const before=f.server.bus.panelConversation().messages.length;const _taken=f.server.bus.takeoverTeam(f.group.id,0);const controller=f.server.bus.teamController(f.group.id);
 assert.equal(controller.kind,'panel_agent');
 assert.equal((await f.send({text:'hello',operationId:'stale',controllerId:f.group.lead})).status,400);
 const sent=await f.send({text:'hello panel lead',operationId:'panel',controllerId:controller.id});assert.equal(sent.status,200);
 await until(()=>!f.server.bus.running.size);await tick();
 assert.equal((await f.read())[0].status,'delivered');assert.ok(f.calls.some(c=>c.endpoint.owner_kind==='panel_agent'&&c.endpoint.context==='coordination'));
 assert.equal(f.server.bus.panelConversation().messages.length,before);
});
test('open targets accept directives; archived targets reject new input until restored',async t=>{
 const f=await setup(t);const s=f.server.bus.store;const body={text:'同步当前进展',operationId:'open',controllerId:f.group.lead};
 const response=await f.send(body);assert.equal(response.status,200);await until(()=>!f.server.bus.running.size);
 assert.equal(f.calls.at(-1).policy.mode,'communication');
 s.run("UPDATE groups SET state='archived' WHERE id=?",f.group.id);
 assert.equal((await f.send({...body,operationId:'archive'})).status,410);
 s.run("UPDATE groups SET state=NULL WHERE id=?",f.group.id);
 assert.equal((await f.send({...body,operationId:'restored'})).status,200);
});

test('a failed directive does not indefinitely block a later directive or replay the failed input', async t => {
 let fail=true;
 const f=await setup(t,async c=>{if(fail){fail=false;throw Error('host unavailable')}c.onAccepted();return'done'});
 const body={text:'first',operationId:'first-failed',controllerId:f.group.lead};
 const first=await(await f.send(body)).json();
 await until(()=>!f.server.bus.running.size);await tick();
 assert.equal((await f.read()).find(r=>r.messageId===first.messageId).status,'failed');
 const next=await(await f.send({...body,text:'second',operationId:'next'})).json();
 await until(()=>f.calls.length===2&&!f.server.bus.running.size);
 const receipts=await f.read();
 assert.equal(receipts.find(r=>r.messageId===next.messageId).status,'delivered');
 assert.equal(receipts.find(r=>r.messageId===first.messageId).status,'failed');
 assert.equal(f.calls.length,2);
});

test('directive final output appears as a durable reply without dispatching another agent turn', async t => {
 const f=await setup(t,async c=>{c.onAccepted();return '当前工作已经完成。'});
 const first=await(await f.send({text:'报告进度',operationId:'reply',controllerId:f.group.lead})).json();
 await until(()=>!f.server.bus.running.size);await tick();
 const replies=()=>f.server.bus.store.all('SELECT * FROM messages WHERE reply_to=?',first.messageId);
 assert.equal(replies().length,1);
 assert.equal(replies()[0].text,'当前工作已经完成。');
 assert.equal(replies()[0].sender,f.group.lead);
 assert.equal(replies()[0].recipient,'user');
 assert.equal(f.calls.length,1);
 assert.equal(f.server.bus.store.pending().filter(m=>m.group_id===f.group.id).length,0);
 await f.restart();assert.equal(replies().length,1);
});

test('restart recovers a historical final output once without invoking the model again', async t => {
 const f=await setup(t,async c=>{c.onAccepted();return '历史回复'});
 const input=await(await f.send({text:'状态',operationId:'recover',controllerId:f.group.lead})).json();
 await until(()=>!f.server.bus.running.size);await tick();
 // Simulate a pre-fix database: final output exists but no chat reply was published.
 f.server.bus.store.run('DELETE FROM messages WHERE reply_to=?',input.messageId);
 const count=f.calls.length;
 await f.restart();
 const replies=()=>f.server.bus.store.all('SELECT * FROM messages WHERE reply_to=?',input.messageId);
 assert.equal(replies().length,1);assert.equal(replies()[0].text,'历史回复');
 f.server.bus.teamDirectives.recoverOutputs();assert.equal(replies().length,1);
 assert.equal(f.calls.length,count);
});

test('Panel Agent coordination also publishes a directive reply without leaking private conversation', async t => {
 const f=await setup(t);
 await f.server.bus.createPanelAgent({name:'Panel',host:'fake',model:'test',reasoning_effort:'low'});
 f.server.bus.takeoverTeam(f.group.id,0);
 const controller=f.server.bus.teamController(f.group.id);
 const before=f.server.bus.panelConversation().messages.length;
 const input=await(await f.send({text:'汇报',operationId:'panel-reply',controllerId:controller.id})).json();
 await until(()=>!f.server.bus.running.size);await tick();
 const replies=f.server.bus.store.all('SELECT * FROM messages WHERE reply_to=?',input.messageId);
 assert.equal(replies.length,1);assert.equal(replies[0].sender,controller.id);
 assert.equal(f.server.bus.panelConversation().messages.length,before);
});

test('empty and failed outputs never fabricate a user reply', async t => {
 let fail=false;
 const f=await setup(t,async c=>{if(fail)throw Error('failure');c.onAccepted();return '  '});
 for(const operationId of ['empty','error']){
  const input=await(await f.send({text:'状态',operationId,controllerId:f.group.lead})).json();
  await until(()=>!f.server.bus.running.size);await tick();
  // 公共消息列表（/api/messages）里没有 reply_to 指向这条指令的伪造回复。
  const groupMessages=await(await fetch(new URL(`/api/messages?group=${f.group.id}&latest=1`,f.server.url))).json();
  assert.equal(groupMessages.filter(message=>message.reply_to===input.messageId).length,0);
  fail=true;
 }
});

test('team directive publishes a live draft and completes it after the durable reply', async t => {
  const f = await setup(t, async context => {
    context.onAccepted();
    context.onTextDelta('你');
    context.onTextDelta('好');
    return '你好';
  });
  const events = [];
  f.server.bus.on('team-stream', event => events.push(event));
  const input = await (await f.send({
    text: '流式回复',
    operationId: 'team-live',
    controllerId: f.group.lead,
  })).json();
  await until(() => !f.server.bus.running.size);
  await tick();
  assert.deepEqual(events.map(event => event.type), [
    'start',
    'delta',
    'delta',
    'complete',
  ]);
  assert.deepEqual(
    events.filter(event => event.type === 'delta').map(event => event.delta),
    ['你', '好'],
  );
  assert.ok(
    events
      .filter(event => event.type === 'delta')
      .every(event => event.stream.text === ''),
  );
  const reply = f.server.bus.store.get('SELECT * FROM messages WHERE reply_to=?', input.messageId);
  assert.equal(reply.text, '你好');
  const complete = events.find(event => event.type === 'complete');
  assert.equal(complete.stream.messageId, reply.id);
  assert.equal(complete.stream.messageSeq, reply.seq);
});

test('agent-to-agent send tool arguments stream before the durable team message', async t => {
  const f = await setup(t, async context => {
    context.onAccepted();
    if (context.endpoint.context !== 'coordination') return '';
    context.onToolCallDelta({
      callId: 'send-1',
      name: 'send',
      argumentsDelta: '{"to":"Worker","text":"流',
    });
    context.onToolCallDelta({
      callId: 'send-1',
      name: 'send',
      argumentsDelta: '式消息"}',
    });
    await context.onTool('send', {
      to: 'Worker',
      text: '流式消息',
    }, { nativeCallId: 'send-1' });
    return '';
  }, {
    members: [{ name: 'Worker', host: 'fake' }],
  });
  const events = [];
  f.server.bus.on('team-stream', event => events.push(event));
  await f.send({
    text: 'send a message',
    operationId: 'team-send-stream',
    controllerId: f.group.lead,
  });
  await until(() => !f.server.bus.running.size);
  await tick();
  const messageEvents = events.filter(event => event.stream?.kind === 'message');
  assert.deepEqual(messageEvents.map(event => event.type), [
    'start',
    'delta',
    'delta',
    'complete',
  ]);
  assert.deepEqual(
    messageEvents.filter(event => event.type === 'delta').map(event => event.delta),
    ['流', '式消息'],
  );
  assert.equal(messageEvents.at(-1).stream.text, '流式消息');
  assert.equal(messageEvents.at(-1).stream.recipientName, 'Worker');
  assert.equal(messageEvents.at(-1).stream.messageKind, 'send');
  const durable = f.server.bus.store.get(
    "SELECT * FROM messages WHERE text='流式消息' AND kind='send'",
  );
  assert.equal(messageEvents.at(-1).stream.messageId, durable.id);
  assert.equal(messageEvents.at(-1).stream.messageSeq, durable.seq);
});

test('parallel same-name message tools complete against the matching stream', async t => {
  const f = await setup(t, async context => {
    context.onAccepted();
    if (context.endpoint.context !== 'coordination') return '';
    context.onToolCallDelta({
      callId: 'send-a',
      name: 'send',
      argumentsDelta: '{"text":"消息 A","to":"Worker"}',
      complete: true,
    });
    context.onToolCallDelta({
      callId: 'send-b',
      name: 'send',
      argumentsDelta: '{"to":"Worker","text":"消息 B"}',
      complete: true,
    });
    await context.onTool('send', { text: '消息 A', to: 'Worker' });
    await context.onTool('send', { to: 'Worker', text: '消息 B' });
    return '';
  }, {
    members: [{ name: 'Worker', host: 'fake' }],
  });
  const events = [];
  f.server.bus.on('team-stream', event => events.push(event));
  await f.send({
    text: 'send both',
    operationId: 'parallel-sends',
    controllerId: f.group.lead,
  });
  await until(() => !f.server.bus.running.size);
  await tick();
  const completed = events.filter(event => (
    event.type === 'complete' && event.stream.kind === 'message'
  ));
  assert.deepEqual(completed.map(event => event.stream.text), ['消息 A', '消息 B']);
  assert.equal(new Set(completed.map(event => event.stream.id)).size, 2);
});

test('note tools stream escaped text and keep note semantics', async t => {
  const f = await setup(t, async context => {
    context.onAccepted();
    if (context.endpoint.context !== 'coordination') return '';
    context.onToolCallDelta({
      callId: 'note-1',
      name: 'note',
      argumentsDelta: '{"text":"第一行\\\\n\\\\"',
    });
    context.onToolCallDelta({
      callId: 'note-1',
      name: 'note',
      argumentsDelta: JSON.stringify({
        text: '第一行\n"引用"',
        to: 'Worker',
      }),
      complete: true,
    });
    await context.onTool('note', {
      text: '第一行\n"引用"',
      to: 'Worker',
    });
    return '';
  }, {
    members: [{ name: 'Worker', host: 'fake' }],
  });
  const events = [];
  f.server.bus.on('team-stream', event => events.push(event));
  await f.send({
    text: 'leave a note',
    operationId: 'note-stream',
    controllerId: f.group.lead,
  });
  await until(() => !f.server.bus.running.size);
  await tick();
  const noteEvents = events.filter(event => event.stream?.kind === 'message');
  assert.ok(noteEvents.length >= 3);
  assert.ok(noteEvents.every(event => event.stream.messageKind === 'note'));
  assert.equal(noteEvents.at(-1).type, 'complete');
  assert.equal(noteEvents.at(-1).stream.text, '第一行\n"引用"');
});

test('failed message tool removes its live draft immediately', async t => {
  const events = [];
  const f = await setup(t, async context => {
    context.onAccepted();
    if (context.endpoint.context !== 'coordination') return '';
    context.onToolCallDelta({
      callId: 'failed-send',
      name: 'send',
      argumentsDelta: '{"to":"Worker","text":"不会发送"}',
      complete: true,
    });
    let failedImmediately = false;
    try {
      await context.onTool('send', { to: 'MissingMember', text: '不会发送' });
    } catch {
      failedImmediately = events.some(event => (
        event.type === 'error' && event.stream?.toolCallId === 'failed-send'
      ));
    }
    assert.equal(failedImmediately, true);
    return '失败已处理';
  }, {
    members: [{ name: 'Worker', host: 'fake' }],
  });
  f.server.bus.on('team-stream', event => events.push(event));
  await f.send({
    text: 'fail safely',
    operationId: 'failed-message-stream',
    controllerId: f.group.lead,
  });
  await until(() => !f.server.bus.running.size);
  await tick();
  assert.equal(events.filter(event => event.type === 'error').length, 1);
  assert.equal(
    f.server.bus.store.all(
      "SELECT * FROM messages WHERE text='不会发送' AND kind='send'",
    ).length,
    0,
  );
  assert.deepEqual(f.server.bus.teamStreaming(f.group.id), []);
});

test('Panel Agent team_note streams with note semantics', async t => {
  const f = await setup(t, async context => {
    context.onAccepted();
    if (!(context.endpoint.owner_kind === 'panel_agent' && context.endpoint.context === 'coordination')) return '';
    context.onToolCallDelta({
      callId: 'panel-note',
      name: 'mcp__agent_team__team_note',
      argumentsDelta: '{"groupId":"',
    });
    context.onToolCallDelta({
      callId: 'panel-note',
      name: 'mcp__agent_team__team_note',
      argumentsDelta: JSON.stringify({
        groupId: f.group.id,
        text: 'Panel 留言',
        to: 'Worker',
      }),
      complete: true,
    });
    await context.onTool('team_note', {
      groupId: f.group.id,
      text: 'Panel 留言',
      to: 'Worker',
    });
    return '留言已发送';
  }, {
    members: [{ name: 'Worker', host: 'fake' }],
  });
  await f.server.bus.createPanelAgent({
    name: 'Panel',
    host: 'fake',
    model: 'test',
    reasoning_effort: 'low',
  });
  f.server.bus.takeoverTeam(f.group.id, 0);
  const controller = f.server.bus.teamController(f.group.id);
  const events = [];
  f.server.bus.on('team-stream', event => events.push(event));
  const response = await f.send({
    text: 'leave a panel note',
    operationId: 'panel-note-stream',
    controllerId: controller.id,
  });
  assert.equal(response.status, 200, await response.text());
  await until(() => !f.server.bus.running.size);
  await tick();
  const notes = events.filter(event => (
    event.stream?.kind === 'message' && event.stream.messageKind === 'note'
  ));
  assert.ok(notes.length, JSON.stringify(events));
  assert.equal(notes.at(-1).type, 'complete');
  assert.equal(notes.at(-1).stream.text, 'Panel 留言');
});
