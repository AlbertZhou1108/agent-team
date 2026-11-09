import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../../bus.mjs';
import { createCodexHost } from '../../hosts/codex.mjs';
import { createClaudeHost, createDshHost } from '../../hosts/cli-hosts.mjs';
import { modelCatalog } from '../../hosts/catalog.mjs';
import { rpc } from '../../rpc.mjs';
import { startServer } from '../../server.mjs';

test('Codex discovers models through model/list without starting a turn', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-codex-catalog-'));
  const fake = join(directory, 'fake-codex.mjs');
  writeFileSync(fake, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
createInterface({ input: process.stdin }).on('line', line => {
  const row = JSON.parse(line);
  if (row.method === 'initialize') return send({ id: row.id, result: {} });
  if (row.method === 'config/read') return send({ id: row.id, result: { config: { mcp_servers: {} } } });
  if (row.method === 'model/list') return send({ id: row.id, result: { data: [{
    id: 'model-a', model: 'model-a', displayName: 'Model A', description: 'catalog fixture',
    hidden: false, isDefault: true, defaultReasoningEffort: 'low',
    supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'fast' }],
    inputModalities: ['text']
  }], nextCursor: null } });
});
`);
  chmodSync(fake, 0o700);
  const host = createCodexHost({ command: fake });
  t.after(async () => { await host.close(); rmSync(directory, { recursive: true, force: true }); });
  const catalog = await host.listModels();
  assert.equal(catalog.defaultModel, 'model-a');
  assert.deepEqual(catalog.models.map(model => model.id), ['model-a']);
  assert.deepEqual(catalog.models[0].reasoningEfforts.map(effort => effort.id), ['low']);
});

test('Claude discovers models through initialization without sending a user message', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-claude-catalog-'));
  const fake = join(directory, 'fake-claude.mjs');
  writeFileSync(fake, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', line => {
  const row = JSON.parse(line);
  if (row.type !== 'control_request') process.exit(9);
  process.stdout.write(JSON.stringify({type:'control_response',response:{request_id:row.request_id,subtype:'success',response:{models:[
    {value:'default',displayName:'Default',supportedEffortLevels:['low','high']},
    {value:'sonnet',displayName:'Sonnet',supportedEffortLevels:['low','high']}
  ]}}}) + '\\n');
});
`);
  chmodSync(fake, 0o700);
  const host = createClaudeHost({ directory, socketPath: join(directory, 'bus.sock'), command: fake });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const catalog = await host.listModels();
  assert.equal(catalog.defaultModel, 'default');
  assert.ok(catalog.models.some(model => model.id === 'sonnet'));
  assert.deepEqual(catalog.models[0].reasoningEfforts.map(effort => effort.id), ['low', 'high']);
});

test('DSH discovers its live provider catalog through the invocation probe', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-dsh-catalog-'));
  const fake = join(directory, 'fake-dsh.mjs');
  writeFileSync(fake, `#!/usr/bin/env node
process.stdout.write('AGENT_TEAM_DSH_MODEL_CATALOG ' + JSON.stringify({
  ok: true,
  defaultModel: 'provider/model-a',
  providers: [{ id: 'provider', label: 'Provider', models: [{
    key: 'provider/model-a', id: 'model-a', label: 'Model A', provider: 'provider',
    inputModalities: ['text'], contextWindow: 1000000,
    reasoningEfforts: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }],
    defaultReasoningEffort: 'high', isDefault: true
  }] }],
  failures: []
}) + '\\n');
`);
  chmodSync(fake, 0o700);
  const host = createDshHost({ directory, socketPath: join(directory, 'bus.sock'), command: fake });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const catalog = await host.listModels();
  assert.equal(catalog.defaultModel, 'provider/model-a');
  assert.equal(catalog.models[0].contextWindow, 1000000);
  assert.deepEqual(catalog.models[0].reasoningEfforts.map(effort => effort.id), ['low', 'high']);
});

test('model catalog is cached, refreshable, and exposed through the read-only API', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-model-catalog-api-'));
  let calls = 0;
  const host = {
    async listModels() {
      calls++;
      return modelCatalog({
        host: 'fake',
        source: 'test',
        defaultModel: 'model-a',
        models: [{ id: 'model-a', label: 'Model A', isDefault: true }],
      });
    },
  };
  const server = await startServer({ directory, hosts: new Map([['fake', host]]) });
  t.after(async () => { await server.close(); rmSync(directory, { recursive: true, force: true }); });
  const first = await server.bus.modelCatalog();
  const second = await server.bus.modelCatalog();
  const refreshed = await server.bus.modelCatalog({ refresh: true });
  assert.equal(calls, 2);
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(refreshed.cached, false);
  const response = await (await fetch(`${new URL(server.url).origin}/api/model-catalog?refresh=1`)).json();
  assert.equal(response.hosts[0].catalog.models[0].id, 'model-a');
  assert.equal(calls, 3);
  const rpcResult = await rpc(server.socketPath, { op: 'model_catalog', refresh: true });
  assert.equal(rpcResult.hosts[0].catalog.models[0].id, 'model-a');
  assert.equal(calls, 4);
});

test('Bus reports a host that cannot discover models without failing other hosts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-model-catalog-unsupported-'));
  const bus = new Bus({
    directory,
    hosts: new Map([
      ['unsupported', { async run() { return ''; } }],
      ['supported', {
        async listModels() {
          return modelCatalog({ host: 'supported', source: 'test', models: [{ id: 'ok' }] });
        },
      }],
    ]),
  });
  try {
    const result = await bus.modelCatalog({ refresh: true });
    assert.equal(result.hosts.find(host => host.host === 'unsupported').ok, false);
    assert.equal(result.hosts.find(host => host.host === 'supported').ok, true);
  } finally {
    await bus.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

 test('DSH rejects abnormal exit even after a complete valid catalog', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-dsh-abnormal-'));
  const fake = join(directory, 'fake-dsh.mjs');
  writeFileSync(fake, `#!/usr/bin/env node
process.stdout.write('AGENT_TEAM_DSH_MODEL_CATALOG ' + JSON.stringify({ok:true,providers:[],failures:[]}) + '\\n', () => setTimeout(() => process.exit(7), 50));
`);
  chmodSync(fake, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  await assert.rejects(createDshHost({directory, command:fake}).listModels(), /退出 \(7\)/);
});
