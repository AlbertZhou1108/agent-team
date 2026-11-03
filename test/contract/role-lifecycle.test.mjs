import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../../src/bus.mjs';
import { modelCatalog } from '../../src/hosts/catalog.mjs';
import { createTestGroup } from '../support/fixture.mjs';

async function until(predicate) {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('condition timed out');
}

test('roles are permanent identities: names stay reserved and new roles get new sessions', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-role-lifecycle-'));
  const catalog = modelCatalog({
    host: 'fake',
    source: 'test',
    defaultModel: 'role-model',
    models: [
      { id: 'role-model', reasoningEfforts: [{ id: 'low' }], defaultReasoningEffort: 'low', isDefault: true },
      { id: 'added-model', reasoningEfforts: [{ id: 'high' }], defaultReasoningEffort: 'high' },
    ],
  });
  const bus = new Bus({
    directory,
    hosts: new Map([['fake', {
      async listModels() { return catalog; },
      async run(context) {
        if (context.endpoint.context === 'member-plan') {
          return JSON.stringify({
            model_provider: null,
            model: 'added-model',
            reasoning_effort: 'high',
          });
        }
        if (context.endpoint.context === 'profile') await context.onTool('profile_set', { text: 'role' });
        context.onSession(context.endpoint.session ?? `${context.endpoint.id}-session`);
        context.onAccepted();
        return 'done';
      },
    }]]),
  });
  t.after(async () => {
    await bus.close();
    rmSync(directory, { recursive: true, force: true });
  });

  assert.throws(() => bus.createGroup({
    name: 'duplicate names',
    workspace: directory,
    lead: { name: 'Alice', host: 'fake' },
    members: [{ name: 'ＡＬＩＣＥ', host: 'fake' }],
  }), /重复/);

  const group = createTestGroup(bus, {
    name: 'roles',
    workspace: directory,
    lead: { name: 'Lead', host: 'fake' },
    members: [{ name: 'Worker', host: 'fake' }],
  });
  await until(() => bus.running.size === 0);
  const worker = bus.members(group.id).find(member => member.name === 'Worker');
  const workerEndpoint = bus.store.endpoint(worker.id, `pair:${group.lead}`, group.lead);
  const historical = bus.store.append(group.id, worker.id, group.lead, 'send', 'historical contribution');
  await bus.runEndpoint(workerEndpoint, 'establish original role session');
  const historicalSession = bus.store.get('SELECT session FROM conversations WHERE id=?', workerEndpoint.id).session;
  assert.ok(historicalSession);

  await bus.removeMember(group.id, worker.id);
  const removed = bus.store.get('SELECT removed FROM members WHERE id=?', worker.id);
  assert.ok(removed.removed);
  assert.equal(bus.store.get('SELECT text FROM messages WHERE id=?', historical.id).text, 'historical contribution');
  assert.equal(bus.store.get('SELECT session FROM conversations WHERE id=?', workerEndpoint.id).session, historicalSession);
  await assert.rejects(bus.tool(workerEndpoint.id, workerEndpoint.key, 'read', {}), /成员不存在或已移除/);

  await assert.rejects(bus.addMember(group.id, { name: 'worker', host: 'fake' }), /名称已被本团队历史使用/);
  await assert.rejects(bus.addMember(group.id, { name: 'ＷＯＲＫＥＲ', host: 'fake' }), /名称已被本团队历史使用/);
  const replacement = await bus.addMember(group.id, { name: 'Worker Two', host: 'fake' });
  assert.notEqual(replacement.id, worker.id);
  await until(() => bus.running.size === 0);
  const replacementEndpoint = bus.store.endpoint(replacement.id, `pair:${group.lead}`, group.lead);
  await bus.runEndpoint(replacementEndpoint, 'establish replacement role session');
  const replacementSession = bus.store.get('SELECT session FROM conversations WHERE id=?', replacementEndpoint.id).session;
  assert.notEqual(replacementEndpoint.id, workerEndpoint.id);
  assert.ok(replacementSession);
  assert.notEqual(replacementSession, historicalSession);
  assert.equal(bus.members(group.id).some(member => member.id === worker.id), false);
  assert.equal(bus.members(group.id).some(member => member.id === replacement.id), true);
});
