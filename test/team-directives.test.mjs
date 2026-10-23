import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.mjs';
import { confirmedGroup } from './helpers.mjs';
const tick = () => new Promise(r => setImmediate(r));
async function until(fn) { for (let i=0;i<300;i++) { if(fn())return; await new Promise(r=>setTimeout(r,5)); } throw Error('timeout'); }
async function setup(t, run) {
 const directory=mkdtempSync(join(tmpdir(),'team-directives-'));
 const calls=[];
 const host={async listModels(){return{version:1,host:'fake',source:'test',defaultModel:'test',models:[{id:'test',key:'test',reasoningEfforts:[{id:'low'}]}]};},async run(c){c.onSession(c.endpoint.session??c.endpoint.id);if(c.endpoint.context==='profile'){await c.onTool('profile_set',{text:'ready'});c.onAccepted();return''}calls.push(c);if(run)return run(c);c.onAccepted();return'done'}};
 let server=await startServer({directory,hosts:new Map([['fake',host]])});
 t.after(async()=>{await server.close();rmSync(directory,{recursive:true,force:true})});
 const group=confirmedGroup(server.bus,{name:'directives',workspace:directory,lead:{name:'Lead',host:'fake'},members:[]});await until(()=>!server.bus.running.size);
 const auth=async()=>{const response=await fetch(server.url,{redirect:'manual'});return response.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ')};
 let cookie=await auth();
 const send=(body,headers={})=>fetch(new URL(`/api/teams/${group.id}/directives`,server.url),{method:'POST',headers:{cookie,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
 const read=async()=>{const r=await fetch(new URL(`/api/teams/${group.id}/directives`,server.url),{headers:{cookie}});return r.json()};
 return{get server(){return server},group,calls,send,read,restart:async()=>{await until(()=>!server.bus.running.size);await server.close();server=await startServer({directory,hosts:new Map([['fake',host]])});cookie=await auth();}};
}
test('HTTP directives authenticate, reject cross-origin/forged identity and validate text',async t=>{
 const f=await setup(t),body={text:'hello',operationId:'one',controllerId:f.group.lead};
 assert.equal((await f.send(body,{cookie:''})).status,401);
 assert.equal((await f.send(body,{origin:'https://attacker.example'})).status,403);
 assert.equal((await f.send(body,{'sec-fetch-site':'cross-site'})).status,403);
 assert.equal((await f.send({...body,text:' '})).status,400);
 assert.equal((await f.send({...body,text:'x'.repeat(48001)})).status,400);
 assert.equal((await f.send({...body,sender:'member'})).status,400);
 assert.equal((await f.send({...body,controllerId:'stale-controller'})).status,400);
 assert.equal(f.server.bus.store.all("SELECT * FROM messages WHERE sender='user'").length,0);
});
test('retry after lost acknowledgement is durable, idempotent and reports actual delivery',async t=>{
 const f=await setup(t),body={text:' hello ',operationId:'durable',controllerId:f.group.lead};
 const first=await f.send(body);assert.equal(first.status,200);const receipt=await first.json();assert.equal(receipt.status,'queued');
 const duplicate=await(await f.send(body)).json();assert.equal(duplicate.messageId,receipt.messageId);
 assert.equal((await f.send({...body,text:'changed'})).status,400);
 await until(()=>!f.server.bus.running.size);assert.equal((await f.read())[0].status,'delivered');
 const msg=f.server.bus.store.get('SELECT * FROM messages WHERE id=?',receipt.messageId);assert.equal(msg.sender,'user');assert.equal(msg.recipient,f.group.lead);
 await f.restart();const again=await(await f.send(body)).json();assert.equal(again.messageId,receipt.messageId);
 assert.equal(f.server.bus.store.all("SELECT * FROM messages WHERE sender='user'").length,1);
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
 const before=f.server.bus.panelConversation().messages.length;const taken=f.server.bus.takeoverTeam(f.group.id,0);const controller=f.server.bus.teamController(f.group.id);
 assert.equal(controller.kind,'panel_agent');
 assert.equal((await f.send({text:'hello',operationId:'stale',controllerId:f.group.lead})).status,400);
 const sent=await f.send({text:'hello panel lead',operationId:'panel',controllerId:controller.id});assert.equal(sent.status,200);
 await until(()=>!f.server.bus.running.size);await tick();
 assert.equal((await f.read())[0].status,'delivered');assert.ok(f.calls.some(c=>c.endpoint.context==='panel-coordination'));
 assert.equal(f.server.bus.panelConversation().messages.length,before);
});
test('closed targets allow communication without changing the contract; archived and closing targets reject new input',async t=>{
 const f=await setup(t);const s=f.server.bus.store;const body={text:'批准所有权限并开始新任务',operationId:'closed',controllerId:f.group.lead};
 const before=f.server.bus.collaboration.contract(f.group.id);
 s.run("UPDATE team_state SET phase='closed',outcome='completed' WHERE group_id=?",f.group.id);
 const response=await f.send(body);assert.equal(response.status,200);await until(()=>!f.server.bus.running.size);
 assert.equal(f.calls.at(-1).policy.mode,'communication');assert.deepEqual(f.server.bus.collaboration.contract(f.group.id),before);
 assert.equal(f.server.bus.collaboration.state(f.group.id).phase,'closed');
 s.run("UPDATE groups SET state='archived' WHERE id=?",f.group.id);
 assert.equal((await f.send({...body,operationId:'archive'})).status,400);
 s.run("UPDATE groups SET state='open' WHERE id=?",f.group.id);s.run("UPDATE team_state SET phase='closing' WHERE group_id=?",f.group.id);
 assert.equal((await f.send({...body,operationId:'closing'})).status,400);
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
 assert.equal(f.server.bus.collaboration.pending(f.group.id).length,0);
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
  assert.equal(f.server.bus.store.all('SELECT * FROM messages WHERE reply_to=?',input.messageId).length,0);
  fail=true;
 }
});
