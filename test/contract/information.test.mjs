import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../../src/bus.mjs';
import { createCodexHost } from '../../src/hosts/codex.mjs';
import { toolsFor } from '../../src/tools.mjs';
import { panelToolsFor } from '../../src/panel-tools.mjs';
import {
  byteSize,
  CONTEXT_SCHEMA_VERSION,
  projectTurnInput,
} from '../../src/information.mjs';
import { busScenario, createTestGroup } from '../support/fixture.mjs';

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
  assert.doesNotMatch(first.instructions, /当前有效契约与执行状态：/);
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
  assert.equal(bus.store.get('SELECT session FROM conversations WHERE id=?', legacy.id).session, 'legacy-native-session');
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
    assert.equal(bus.store.get('SELECT COUNT(*) AS n FROM turns WHERE conversation_id=?', endpoint.id).n, 0);
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
      if (context.endpoint.context === 'panel-coordination' && !captures.done) {
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
    rmSync(directory, { recursive: true, force: true });
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
    rmSync(directory, { recursive: true, force: true });
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
