import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Bus } from '../src/bus.mjs';
import { startServer } from '../src/server.mjs';
import { rpc } from '../src/rpc.mjs';
import { createCodexHost } from '../src/hosts/codex.mjs';
import { toolsFor } from '../src/tools.mjs';
import { panelToolsFor } from '../src/panel-tools.mjs';
import {
  byteSize,
  projectCollaboration,
  projectFacts,
  projectTurnInput,
} from '../src/information.mjs';
import { confirmedGroup, testContract } from './helpers.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(fn, message = 'condition timed out') {
  for (let index = 0; index < 600; index += 1) {
    if (fn()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(message);
}
const cliPath = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

function baseHost(calls, run) {
  return {
    async run(context) {
      calls.push(context);
      context.onSession(context.endpoint.session ?? `native-${context.endpoint.id}`);
      if (context.endpoint.context === 'profile') {
        context.onAccepted();
        return 'profile';
      }
      if (run) return run(context);
      context.onAccepted();
      return 'done';
    },
  };
}

function fixture(t, run) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-information-'));
  const calls = [];
  const host = baseHost(calls, run);
  const bus = new Bus({ directory, hosts: new Map([['fake', host]]) });
  const group = confirmedGroup(bus, {
    name: 'information fixture',
    workspace: directory,
    lead: { name: 'lead', host: 'fake' },
    members: [{ name: 'one', host: 'fake' }],
  }, testContract);
  t.after(async () => {
    if (!bus.closing) await bus.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { bus, group, calls, directory };
}

function collabFixture() {
  const items = [
    { id: 'current-1', goalVersion: 1, revision: 2, state: 'in_progress', title: 'current work' },
    { id: 'blocked-old', goalVersion: 0, revision: 4, state: 'blocked', title: 'unresolved foreign' },
    { id: 'accepted-old', goalVersion: 0, revision: 5, state: 'accepted', title: 'accepted history' },
  ];
  const long = '日志🧪\n'.repeat(80) + 'MIDDLE' + '尾部';
  return {
    legacy: false,
    contract: { version: 1, hash: 'contract-hash', body: testContract },
    state: { goal_version: 1, contract_version: 1, phase: 'active', revision: 7, outcome: null, final: 'final delivery' },
    communicationOpen: true,
    items,
    requests: [
      { id: 'req-pending', state: 'pending', kind: 'contract', base_version: 1, body: { reason: 'needs decision' } },
      { id: 'req-done', state: 'approved', kind: 'contract', base_version: 1, body: {} },
    ],
    records: [
      { seq: 1, goal_version: 0, work_item_id: 'blocked-old', type: 'work_item', body: { title: 'unresolved foreign' } },
      { seq: 2, goal_version: 0, work_item_id: 'accepted-old', type: 'work_item', body: { title: 'old' } },
      { seq: 5, goal_version: 1, work_item_id: 'current-1', type: 'work_item', body: { title: 'current work' } },
    ],
    nextAfter: 5,
    unknown: ['unknown-runtime'],
    runningCount: 2,
    pendingMessages: [{ id: 'pending-msg', seq: 9, sender: 'a', recipient: 'b', kind: 'send', text: long }],
    outputs: [
      { id: 'out-current', goalVersion: 1, body: 'current output', created: 'now' },
      { id: 'out-old', goalVersion: 0, body: 'old output', created: 'before' },
    ],
    long,
  };
}

test('deterministic projection keeps required facts and reports budget exhaustion explicitly', () => {
  const input = {
    goal: 'G2',
    artifact: 'v3',
    constraints: { policy: 'read-only', allowShell: false },
    rows: [
      { id: 'valid', goal: 'G2', artifact: 'v3' },
      { id: 'unbound', goal: 'G2' },
      { id: 'unknown' },
      { id: 'old', goal: 'G1', artifact: 'v3' },
    ],
    pending: ['must-dispose'],
    unknown: ['runtime-unknown'],
  };
  const facts = projectFacts(input);
  assert.deepEqual(facts.relevant.map(row => row.id), ['valid']);
  assert.deepEqual(facts.unresolved.map(row => row.id), ['unbound', 'unknown']);
  assert.deepEqual(facts.constraints, input.constraints);
  assert.deepEqual(facts.pending, input.pending);
  assert.deepEqual(facts.unknown, input.unknown);
  assert.throws(() => projectFacts(input, 10), /exceed budget/);
  assert.throws(() => projectFacts({ ...input, goal: null }), /explicit identity/);

  const full = collabFixture();
  const view = projectCollaboration(full, { goalId: 'goal-1', budget: 1024 * 1024 });
  assert.equal(view.schema, 1);
  assert.equal(view.view, 'state');
  assert.equal(view.goalVersion, 1);
  assert.equal(view.contractVersion, 1);
  assert.equal(view.stateRevision, 7);
  assert.deepEqual(view.items.map(item => item.id), ['current-1']);
  assert.deepEqual(view.unresolved.map(item => item.id), ['blocked-old']);
  assert.deepEqual(view.pendingRequests.map(request => request.id), ['req-pending']);
  assert.equal(view.pendingMessages[0].id, 'pending-msg');
  assert.equal(view.pendingMessages[0].complete, false);
  assert.match(view.pendingMessages[0].ref.hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(view.unknown, ['unknown-runtime']);
  assert.equal(view.runningCount, 2);
  assert.deepEqual(view.records.map(record => record.seq), [5]);
  assert.deepEqual(view.outputs.map(output => output.id), ['out-current']);
  assert.equal(view.complete, true);

  const targeted = projectCollaboration(full, { itemId: 'blocked-old', budget: 1024 * 1024 });
  assert.equal(targeted.view, 'item');
  assert.equal(targeted.item.id, 'blocked-old');
  assert.deepEqual(targeted.records.map(record => record.seq), [1]);
  assert.throws(() => projectCollaboration(full, { itemId: 'missing' }), /工作项不存在/);

  const budgetFull = {
    legacy: false,
    contract: { version: 1, body: { goal: 'budget' } },
    state: { goal_version: 1, contract_version: 1, revision: 1, phase: 'active' },
    communicationOpen: true,
    items: [{ id: 'budget-item', goalVersion: 1, revision: 1, state: 'in_progress', title: 'budget item' }],
    requests: [],
    records: Array.from({ length: 50 }, (_, index) => ({
      seq: index + 1,
      goal_version: 1,
      work_item_id: 'budget-item',
      type: 'work_item',
      body: { title: 'record '.repeat(20) },
    })),
    nextAfter: 50,
    outputs: [{ id: 'budget-output', goalVersion: 1, body: 'delivery '.repeat(60), created: 'now' }],
    pendingMessages: [],
    unknown: [],
    runningCount: 0,
  };
  const minimal = projectCollaboration({ ...budgetFull, records: [], outputs: [] }, { budget: 1024 * 1024 });
  const tight = projectCollaboration(budgetFull, { budget: byteSize(minimal) + 500 });
  assert.equal(tight.complete, false);
  assert.ok(tight.omissions.some(omission => omission.field === 'records'));
  assert.equal(tight.nextAfter, tight.records.length ? tight.records.at(-1).seq : 0);
  assert.throws(() => projectCollaboration(budgetFull, { budget: 80 }), /超过预算/);

  const turnInput = projectTurnInput({
    full,
    group: { id: 'group-1', name: 'group' },
    policy: { mode: 'read-only', allowShell: false },
    schema: 1,
    goalId: 'goal-1',
    budget: 1024 * 1024,
    input: {
      message: { id: 'm1', seq: 11, sender: 'a', recipient: 'b', kind: 'send', text: full.long, created: 'now' },
      additionalMessages: [],
      notes: [{ id: 'n1', seq: 12, sender: 'c', recipient: 'b', kind: 'note', text: 'note body', created: 'now' }],
    },
  });
  assert.equal(turnInput.contextSchemaVersion, 1);
  assert.equal(turnInput.input.message.text, full.long);
  assert.equal(turnInput.input.message.complete, true);
  assert.equal(turnInput.input.notes[0].text, 'note body');
  assert.deepEqual(turnInput.workItems.map(item => item.id), ['current-1']);
  assert.deepEqual(turnInput.pendingRequests.map(request => request.id), ['req-pending']);
  assert.ok(turnInput.contract);
  assert.throws(() => projectTurnInput({
    full,
    group: { id: 'group-1', name: 'group' },
    policy: { mode: 'read-only' },
    input: { message: { id: 'm', seq: 1, sender: 'a', recipient: 'b', kind: 'send', text: 'x' } },
    budget: 20,
  }), /超过.*预算/);
});

test('new sessions use fixed rules with projected facts; legacy sessions keep their path and are never reset', async t => {
  const { bus, group, calls } = fixture(t);
  await until(() => bus.running.size === 0);
  const [lead, one] = bus.members(group.id);
  const leadEndpoint = bus.store.endpoint(lead.id, 'coordination');

  await bus.tool(leadEndpoint.id, leadEndpoint.key, 'send', { to: one.id, text: 'first projected task' });
  await until(() => calls.some(call => call.endpoint.context === 'pair:' + lead.id) && bus.running.size === 0);
  const first = calls.filter(call => call.endpoint.context === 'pair:' + lead.id).at(-1);
  const firstFacts = JSON.parse(first.prompt);
  assert.equal(firstFacts.contextSchemaVersion, 1);
  assert.equal(firstFacts.input.message.text, 'first projected task');
  assert.equal(firstFacts.stateRevision, bus.collaboration.state(group.id).revision);
  assert.equal(firstFacts.contractVersion, 1);
  assert.equal(firstFacts.goalVersion, 1);
  assert.equal(firstFacts.policy.mode, 'communication');
  assert.match(first.instructions, /当前有效契约与本轮权威状态见本轮输入/);
  assert.match(first.instructions, /目标完成或失败终止后，群仍可继续沟通/);
  assert.match(first.instructions, /独立审查必须由独立审查者完成/);
  assert.match(first.instructions, /审查者只读/);
  assert.doesNotMatch(first.instructions, /当前有效契约与执行状态：/);
  const format = bus.store.get(
    'SELECT * FROM endpoint_context_formats WHERE endpoint_id=?',
    first.endpoint.id,
  );
  assert.equal(format.schema_version, 1);
  assert.equal(format.source, 'new-session');

  // Change authoritative state, then deliver another turn to the same new session.
  bus.collaboration.apply(
    { role: 'lead', context: 'coordination', group_id: group.id },
    {
      title: 'second turn item',
      purpose: 'prove dynamic facts update',
      standard: 'revision visible',
      participants: [{ memberId: one.id, role: 'executor' }],
      note: 'create for dynamic facts',
    },
    bus.collaboration.state(group.id).revision,
    'information-create-item',
  );
  const revisionAfterItem = bus.collaboration.state(group.id).revision;
  await bus.tool(leadEndpoint.id, leadEndpoint.key, 'send', { to: one.id, text: 'second projected task' });
  await until(() => calls.filter(call => call.endpoint.context === 'pair:' + lead.id).length >= 2 && bus.running.size === 0);
  const second = calls.filter(call => call.endpoint.context === 'pair:' + lead.id).at(-1);
  const secondFacts = JSON.parse(second.prompt);
  assert.equal(second.instructions, first.instructions, 'fixed rules must not change per turn');
  assert.equal(secondFacts.stateRevision, revisionAfterItem);
  assert.ok(secondFacts.stateRevision > firstFacts.stateRevision);
  assert.deepEqual(secondFacts.workItems.map(item => item.title), ['second turn item']);
  assert.equal(secondFacts.input.message.text, 'second projected task');

  // A pre-existing native session stays legacy, keeps its id, and sees the old rules/read shape.
  const legacyEndpoint = bus.store.endpoint(lead.id, 'private');
  bus.store.run('UPDATE endpoints SET session=? WHERE id=?', 'legacy-native-session', legacyEndpoint.id);
  const legacy = bus.store.get('SELECT * FROM endpoints WHERE id=?', legacyEndpoint.id);
  bus.store.append(group.id, lead.id, lead.id, 'note', 'legacy body');
  await bus.runEndpoint(legacy, 'legacy turn');
  const legacyFormat = bus.store.get(
    'SELECT * FROM endpoint_context_formats WHERE endpoint_id=?',
    legacy.id,
  );
  assert.equal(legacyFormat.schema_version, 0);
  assert.equal(legacyFormat.source, 'legacy-detected');
  const legacyCall = calls.filter(call => call.endpoint.id === legacy.id).at(-1);
  assert.match(legacyCall.instructions, /当前有效契约与执行状态：/);
  assert.equal(bus.store.get('SELECT session FROM endpoints WHERE id=?', legacy.id).session, 'legacy-native-session');
  const legacyRead = await bus.tool(legacy.id, legacy.key, 'read', {});
  assert.ok(legacyRead.messages.some(message => message.text === 'legacy body'));
  const newRead = await bus.tool(first.endpoint.id, first.endpoint.key, 'read', {});
  assert.equal(newRead.view, 'bounded');
  assert.ok(newRead.messages.every(message => !Object.hasOwn(message, 'text')));
});

test('authoritative event pagination reports exact 100-row boundaries correctly', async t => {
  const { bus, group } = fixture(t);
  await until(() => bus.running.size === 0);
  const [lead, one] = bus.members(group.id);
  const actor = { role: 'lead', context: 'coordination', group_id: group.id };
  const create = index => bus.collaboration.apply(
    actor,
    {
      title: `record-${index}`,
      purpose: 'paging boundary',
      standard: 'exact cursor',
      participants: [{ memberId: one.id, role: 'executor' }],
      note: 'create for boundary test',
    },
    bus.collaboration.state(group.id).revision,
    `record-op-${index}`,
  );
  for (let index = 0; index < 100; index += 1) create(index);
  const exact = bus.collaboration.read(group.id);
  assert.equal(exact.records.length, 100);
  assert.equal(exact.recordsHasMore, false);
  const exactView = projectCollaboration(exact, { budget: 1024 * 1024 });
  assert.equal(exactView.recordsHasMore, false);
  assert.equal(exactView.complete, true);

  create(100);
  const more = bus.collaboration.read(group.id);
  assert.equal(more.records.length, 100);
  assert.equal(more.recordsHasMore, true);
  const moreView = projectCollaboration(more, { budget: 1024 * 1024 });
  assert.equal(moreView.recordsHasMore, true);
  assert.equal(moreView.complete, false);
  assert.equal(moreView.nextAfter, more.records.at(-1).seq);

  const next = bus.collaboration.read(group.id, more.nextAfter);
  assert.equal(next.records.length, 1);
  assert.equal(next.recordsHasMore, false);
  assert.equal(projectCollaboration(next, { budget: 1024 * 1024 }).complete, true);
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
    assert.equal(bus.store.get('SELECT COUNT(*) AS n FROM turns WHERE endpoint_id=?', endpoint.id).n, 0);
    bus.information.measureRules({
      groupId: group.id,
      endpointId: endpoint.id,
      turnId: 'rules-budget-diagnostic',
      schemaVersion: 1,
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

test('bounded message list, database body references, targeted state and measurements work through the tool entry', async t => {
  let captured = null;
  const { bus, group, calls } = fixture(t, async context => {
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
    const state = await context.onTool('collaboration_read', {});
    const item = await context.onTool('collaboration_read', { itemId: captured.itemId });
    captured = {
      endpoint,
      turnId: context.turnId,
      prompt: JSON.parse(context.prompt),
      first,
      second,
      trigger,
      restore,
      state,
      item,
      itemRevision: bus.collaboration.item(captured.itemId, group.id).revision,
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
  const created = bus.collaboration.apply(
    { role: 'lead', context: 'coordination', group_id: group.id },
    {
      title: 'targeted item',
      purpose: 'targeted read',
      standard: 'revision matches',
      participants: [{ memberId: one.id, role: 'executor' }],
      note: 'create targeted item',
    },
    bus.collaboration.state(group.id).revision,
    'information-targeted-create',
  ).item;
  captured = { itemId: created.id };
  const secret = 'A🧪中\n'.repeat(300) + '尾部';
  await bus.tool(leadEndpoint.id, leadEndpoint.key, 'send', { to: one.id, text: secret });
  await until(() => captured?.restore, 'tool entry capture timed out');
  assert.equal(captured.prompt.contextSchemaVersion, 1);
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
  assert.equal(captured.state.view, 'state');
  assert.equal(captured.state.goalVersion, 1);
  assert.ok(captured.state.contract);
  assert.equal(captured.item.view, 'item');
  assert.equal(captured.item.item.revision, captured.itemRevision);
  assert.equal(captured.item.stateRevision, bus.collaboration.state(group.id).revision);

  const manifest = bus.informationManifest(captured.turnId);
  assert.ok(manifest.rulesBytes > 0);
  assert.ok(manifest.turnInputBytes > 0);
  assert.ok(manifest.toolResultBytes > 0);
  assert.ok(manifest.toolCalls >= 4);
  assert.equal(manifest.expandCount, captured.restore.pages);
  assert.deepEqual(manifest.schemaVersions, [1]);
  assert.ok(manifest.measurements.some(row => row.kind === 'rules' && row.goal_version === 1 && row.contract_version === 1));
  assert.ok(manifest.measurements.some(row => row.kind === 'turn_input' && row.revision === captured.state.stateRevision));
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
    /无效整数/,
  );
  const other = confirmedGroup(bus, {
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

function mcpExchange({ socketPath, endpoint, key, turnId }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, 'mcp', '--socket', socketPath, '--endpoint', endpoint], {
      env: {
        ...process.env,
        AGENT_TEAM_KEY: key,
        ...(turnId ? { AGENT_TEAM_TURN: turnId } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const answers = new Map();
    let buffer = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('MCP exchange timed out'));
    }, 8000);
    const finish = () => {
      if (!answers.has('tools') || !answers.has('call')) return;
      clearTimeout(timer);
      child.kill();
      resolve({ tools: answers.get('tools'), call: answers.get('call') });
    };
    child.stdout.on('data', chunk => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const line = buffer.slice(0, buffer.indexOf('\n'));
        buffer = buffer.slice(buffer.indexOf('\n') + 1);
        if (!line.trim()) continue;
        const row = JSON.parse(line);
        if (row.id === 1) {
          answers.set('tools', row);
          child.stdin.write(JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'read', arguments: { limit: 5 } },
          }) + '\n');
        } else if (row.id === 2) {
          answers.set('call', row);
        }
        finish();
      }
    });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) + '\n');
  });
}

test('real RPC/MCP entry returns the same bounded projection and keeps authentication', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-info-mcp-'));
  let server;
  const captures = {};
  const host = {
    async run(context) {
      context.onSession(context.endpoint.session ?? `native-${context.endpoint.id}`);
      if (context.endpoint.context === 'profile') {
        context.onAccepted();
        return 'profile';
      }
      if (context.endpoint.context.startsWith('pair:') && !captures.done) {
        const direct = await server.bus.tool(
          context.endpoint.id,
          context.endpoint.key,
          'read',
          { limit: 5 },
          { turnId: context.turnId },
        );
        const exchange = await mcpExchange({
          socketPath: server.socketPath,
          endpoint: context.endpoint.id,
          key: context.endpoint.key,
          turnId: context.turnId,
        });
        captures.direct = direct;
        captures.exchange = exchange;
        captures.call = JSON.parse(exchange.call.result.content[0].text);
        captures.done = true;
      }
      context.onAccepted();
      return 'done';
    },
  };
  server = await startServer({ directory, hosts: new Map([['fake', host]]) });
  t.after(async () => {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const prep = await rpc(server.socketPath, {
    op: 'prepare',
    args: {
      name: 'mcp team',
      workspace: directory,
      lead: { name: 'lead', host: 'fake' },
      members: [{ name: 'one', host: 'fake' }],
    },
  });
  const proposed = await rpc(server.socketPath, { op: 'propose', id: prep.id, revision: prep.revision, contract: testContract });
  const group = await rpc(server.socketPath, { op: 'approve_preparation', id: prep.id, revision: proposed.revision, hash: proposed.hash });
  await until(() => server.bus.running.size === 0);
  const [lead, one] = server.bus.members(group.id);
  const snapshot = server.bus.store.endpoint(lead.id, 'coordination');
  await server.bus.tool(snapshot.id, snapshot.key, 'send', { to: one.id, text: 'MCP projection 🧪' });
  await until(() => captures.done, 'MCP capture timed out');
  assert.equal(captures.exchange.call.result.isError, false);
  assert.deepEqual(captures.call, captures.direct);
  assert.equal(captures.call.schema, 1);
  assert.equal(captures.call.view, 'bounded');
  assert.ok(captures.call.messages.some(message => message.preview.includes('MCP projection')));
  assert.ok(captures.call.messages.every(message => !Object.hasOwn(message, 'text')));
  const listed = captures.exchange.tools.result.tools.find(tool => tool.name === 'read');
  assert.ok(listed.inputSchema.properties.messageId);
  assert.ok(listed.inputSchema.properties.bodyLimit);
  assert.equal(listed.inputSchema.properties.offset.minimum, 0);
  await assert.rejects(
    rpc(server.socketPath, { op: 'tool', endpoint: snapshot.id, key: 'wrong-key', name: 'read', args: {} }),
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
        const state = await context.onTool('team_collaboration_read', { groupId: captures.groupId });
        captures.read = read;
        captures.message = message;
        captures.restored = restored;
        captures.state = state;
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
  const group = confirmedGroup(bus, {
    name: 'panel projection',
    workspace: directory,
    lead: { name: 'lead', host: 'fake' },
    members: [{ name: 'one', host: 'fake' }],
  }, testContract);
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
  assert.equal(captures.read.schema, 1);
  assert.equal(captures.read.view, 'bounded');
  assert.equal(captures.message.complete, false);
  assert.equal(captures.restored, secret);
  assert.equal(captures.state.schema, 1);
  assert.equal(captures.state.view, 'state');
  assert.ok(captures.state.contract);
  const coordination = bus.store.panelSession(taken.controller.id, 'coordination', group.id);
  const panelTools = panelToolsFor('coordination');
  assert.ok(panelTools.find(tool => tool.name === 'team_read').inputSchema.properties.messageId);
  assert.ok(panelTools.find(tool => tool.name === 'team_collaboration_read').inputSchema.properties.itemId);
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
  assert.equal(memberRead.schema, 1);
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
  const group = confirmedGroup(bus, {
    name: 'codex projection',
    workspace: directory,
    lead: { name: 'lead', host: 'fake' },
    members: [{ name: 'worker', host: 'codex' }],
  }, testContract);
  await until(() => bus.running.size === 0);
  const [lead, worker] = bus.members(group.id);
  const leadEndpoint = bus.store.endpoint(lead.id, 'coordination');
  await bus.tool(leadEndpoint.id, leadEndpoint.key, 'send', { to: worker.id, text: 'Codex dynamic tool 🧪' });
  const outputs = () => bus.store.all("SELECT event FROM history WHERE event LIKE '%framework.output%' ORDER BY seq")
    .map(row => JSON.parse(row.event).text)
    .flatMap(text => { try { return [JSON.parse(text)]; } catch { return []; } });
  await until(() => outputs().some(value => value?.view === 'bounded'), 'codex tool output missing');
  const projected = outputs().find(value => value?.view === 'bounded');
  assert.equal(projected.schema, 1);
  assert.equal(projected.view, 'bounded');
  assert.ok(projected.messages.some(message => message.preview.includes('Codex dynamic tool')));
  assert.ok(projected.messages.every(message => !Object.hasOwn(message, 'text')));
  assert.match(projected.messages.at(-1).ref.hash, /^[0-9a-f]{64}$/);
  const workerEndpoint = bus.store.get("SELECT * FROM endpoints WHERE member_id=? AND context LIKE 'pair:%'", worker.id);
  const workerTools = bus.endpointTools(workerEndpoint.id, workerEndpoint.key);
  const readTool = workerTools.find(tool => tool.name === 'read');
  assert.ok(readTool.inputSchema.properties.messageId);
  assert.ok(readTool.inputSchema.properties.hash);
  assert.equal(readTool.inputSchema.properties.bodyLimit.maximum, 4096);
  const tools = toolsFor('member');
  assert.ok(tools.find(tool => tool.name === 'read').inputSchema.properties.itemId);
});
