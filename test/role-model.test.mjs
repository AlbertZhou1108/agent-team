import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../src/bus.mjs';
import { modelCatalog } from '../src/hosts/catalog.mjs';
import { writeMcpFiles } from '../src/hosts/process.mjs';
import { startServer } from '../src/server.mjs';
import { confirmedGroup, testContract } from './helpers.mjs';

async function until(predicate) {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('condition timed out');
}

test('preparation inherits its session model and plans ordinary role models', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-role-model-'));
  const calls = [];
  const catalog = modelCatalog({
    host: 'fake',
    source: 'test',
    defaultModel: 'lead-model',
    models: [
      { id: 'lead-model', reasoningEfforts: [{ id: 'high' }], defaultReasoningEffort: 'high', isDefault: true },
      { id: 'worker-model', reasoningEfforts: [{ id: 'low' }, { id: 'high' }], defaultReasoningEffort: 'low' },
    ],
  });
  const host = {
    async listModels() { return catalog; },
    async run(context) {
      calls.push(context);
      if (context.endpoint.context === 'preparation') {
        context.onSelection({ model: 'lead-model', reasoning_effort: 'high' });
        await context.onTool('team_plan_update', {
          revision: 0,
          roles: JSON.stringify([
            { name: 'worker', model_provider: null, model: 'worker-model', reasoning_effort: 'high' },
          ]),
        });
      }
      if (context.endpoint.context === 'profile') await context.onTool('profile_set', { text: 'worker profile' });
      context.onAccepted();
      return 'done';
    },
  };
  const bus = new Bus({ directory, hosts: new Map([['fake', host]]) });
  t.after(async () => { await bus.close(); rmSync(directory, { recursive: true, force: true }); });
  bus.updateModelPolicy({ mode: 'smart', rules: '成本优先，审查使用更强模型。' });

  let preparation = bus.prepareGroup({
    name: 'model plan',
    workspace: directory,
    lead: { name: 'lead', host: 'fake' },
    members: [{ name: 'worker', host: 'fake' }],
  });
  await bus.preparationTurn(preparation.id, '整理目标和角色模型计划');
  preparation = bus.collaboration.preparation(preparation.id);
  assert.deepEqual(preparation.sessionModel, { model_provider: null, model: 'lead-model', reasoning_effort: 'high' });
  assert.deepEqual(preparation.rolePlan.roles[0], {
    name: 'worker',
    host: 'fake',
    model_provider: null,
    model: 'worker-model',
    reasoning_effort: 'high',
  });
  preparation = bus.collaboration.propose(preparation.id, testContract, preparation.revision);
  const group = bus.confirmPreparation(preparation.id, preparation.revision, preparation.hash);
  await until(() => !bus.running.size);

  const [lead, worker] = bus.members(group.id);
  assert.deepEqual(
    { model: lead.model, provider: lead.model_provider, effort: lead.reasoning_effort },
    { model: 'lead-model', provider: null, effort: 'high' },
  );
  assert.deepEqual(
    { model: worker.model, provider: worker.model_provider, effort: worker.reasoning_effort },
    { model: 'worker-model', provider: null, effort: 'high' },
  );
  const policy = bus.modelPolicy();
  assert.equal(policy.mode, 'smart');
  assert.equal(policy.rules, '成本优先，审查使用更强模型。');
  const workerProfile = calls.find(context => context.endpoint.context === 'profile' && context.endpoint.member_id === worker.id);
  assert.equal(workerProfile.modelSelection.model, 'worker-model');
  assert.equal(workerProfile.modelSelection.reasoning_effort, 'high');
});

test('invalid role model plans are rejected before group creation', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-role-model-invalid-'));
  const catalog = modelCatalog({
    host: 'fake',
    source: 'test',
    defaultModel: 'model-a',
    models: [{ id: 'model-a', reasoningEfforts: [{ id: 'low' }], defaultReasoningEffort: 'low' }],
  });
  const bus = new Bus({
    directory,
    hosts: new Map([['fake', {
      async listModels() { return catalog; },
      async run(context) { context.onAccepted(); return ''; },
    }]]),
  });
  try {
    const preparation = bus.prepareGroup({
      name: 'invalid plan',
      workspace: directory,
      lead: { name: 'lead', host: 'fake' },
      members: [{ name: 'worker', host: 'fake' }],
    });
    assert.throws(() => bus.collaboration.setRolePlan(
      preparation.id,
      0,
      [{ name: 'worker', model: 'missing', reasoning_effort: 'low' }],
      (roles, spec) => bus.validateRolePlan(roles, spec, {
        hosts: [{ host: 'fake', ok: true, catalog }],
      }),
    ), /不在fake目录中/);
    assert.equal(bus.store.all('SELECT * FROM groups').length, 0);
  } finally {
    await bus.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('global policy changes affect later roles in existing teams without rewriting existing members', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-global-policy-roles-'));
  const catalog = modelCatalog({
    host: 'fake',
    source: 'test',
    defaultModel: 'model-a',
    models: [
      { id: 'model-a', reasoningEfforts: [{ id: 'low' }], defaultReasoningEffort: 'low', isDefault: true },
      { id: 'model-b', reasoningEfforts: [{ id: 'high' }], defaultReasoningEffort: 'high' },
    ],
  });
  const host = {
    async listModels() { return catalog; },
    async run(context) {
      if (context.endpoint.context === 'member-plan') {
        return context.prompt.includes('POLICY_B')
          ? JSON.stringify({ model_provider: null, model: 'model-b', reasoning_effort: 'high' })
          : JSON.stringify({ model_provider: null, model: 'model-a', reasoning_effort: 'low' });
      }
      if (context.endpoint.context === 'profile') await context.onTool('profile_set', { text: 'role' });
      context.onAccepted();
      return '';
    },
  };
  let bus = new Bus({ directory, hosts: new Map([['fake', host]]) });
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  bus.updateModelPolicy({ mode: 'user', rules: 'POLICY_A' });
  const group = confirmedGroup(bus, {
    name: 'global policy',
    workspace: directory,
    lead: { name: 'lead', host: 'fake' },
  });
  await until(() => !bus.running.size);
  const first = await bus.addMember(group.id, { name: 'first', host: 'fake' });
  assert.equal(first.model, 'model-a');
  assert.equal(first.reasoning_effort, 'low');

  bus.updateModelPolicy({ mode: 'user', rules: 'POLICY_B' });
  const second = await bus.addMember(group.id, { name: 'second', host: 'fake' });
  assert.equal(second.model, 'model-b');
  assert.equal(second.reasoning_effort, 'high');
  const unchanged = bus.store.get('SELECT model,reasoning_effort FROM members WHERE id=?', first.id);
  assert.equal(unchanged.model, 'model-a');
  assert.equal(unchanged.reasoning_effort, 'low');

  await bus.close();
  bus = new Bus({ directory, hosts: new Map([['fake', host]]) });
  assert.deepEqual(
    { mode: bus.modelPolicy().mode, rules: bus.modelPolicy().rules },
    { mode: 'user', rules: 'POLICY_B' },
  );
  await bus.close();
});

test('DSH invocation patch applies the role model and effort override', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-dsh-model-patch-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { dsh } = writeMcpFiles(directory, join(directory, 'bus.sock'), { id: 'endpoint', key: 'key' }, 'turn', {
    mode: 'communication',
    allowShell: false,
    workspace: directory,
    tools: [],
    modelSelection: {
      model_provider: 'deepseek-official',
      model: 'deepseek-flash',
      reasoning_effort: 'low',
    },
  });
  const patch = JSON.parse(readFileSync(dsh, 'utf8'));
  assert.deepEqual(
    patch.find(item => item.id === 'agent-default-model').config,
    { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' },
  );
});

test('panel model-policy settings only expose the authenticated policy mutation', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-model-policy-ui-'));
  const server = await startServer({
    directory,

    hosts: new Map([['fake', {
      async run(context) { context.onAccepted(); return ''; },
    }]]),
  });
  t.after(async () => { await server.close(); rmSync(directory, { recursive: true, force: true }); });
  let preparation = server.bus.prepareGroup({
    name: 'settings',
    workspace: directory,
    lead: { name: 'lead', host: 'fake' },
  });
  preparation = server.bus.collaboration.propose(preparation.id, testContract, preparation.revision);
  const group = server.bus.confirmPreparation(preparation.id, preparation.revision, preparation.hash);
  const base = new URL(server.url).origin;
  const response = await fetch(`${base}/api/model-policy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ mode: 'user', rules: '审查角色性能优先。' }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).rules, '审查角色性能优先。');
  assert.equal(server.bus.modelPolicy().mode, 'user');
  assert.equal((await fetch(`${base}/api/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })).status, 403);
});
