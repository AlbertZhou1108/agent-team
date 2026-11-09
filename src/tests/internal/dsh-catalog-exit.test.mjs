import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('DSH catalog waits for stdout completion and defers exit outside the write callback', async () => {
  const timers = [];
  const writes = [];
  const exits = [];
  const source = readFileSync(new URL('../../hosts/dsh-model-catalog.mjs', import.meta.url), 'utf8');
  const apply = runInNewContext(source.replace('export const inject', 'const inject').replace('export function apply', 'function apply') + '; apply;', {
    process: { stdout: { write: (text, callback) => writes.push({ text, callback }) }, exit: code => exits.push(code) },
    setTimeout: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimeout: () => {},
  });
  apply({
    llm: { listProviders: () => [{ id: 'fixture', name: 'Fixture' }], listModels: async () => [{ id: 'model' }], resolveModelInfo: async () => ({ id: 'model', name: 'Model' }) },
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'model' }) },
    on: () => {},
  });
  await timers.find(timer => timer.delay === 1000).callback();
  assert.equal(writes.length, 1);
  const catalog = JSON.parse(writes[0].text.trim().slice('AGENT_TEAM_DSH_MODEL_CATALOG '.length));
  assert.equal(catalog.ok, true);
  assert.equal(catalog.providers[0].models[0].key, 'fixture/model');
  assert.equal(timers.filter(timer => timer.delay === 50).length, 0);
  writes[0].callback();
  assert.deepEqual(exits, []);
  const exitTimer = timers.find(timer => timer.delay === 50);
  assert.ok(exitTimer);
  exitTimer.callback();
  assert.deepEqual(exits, [0]);
});
