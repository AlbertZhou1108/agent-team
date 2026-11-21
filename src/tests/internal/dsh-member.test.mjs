import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { readDshApiKey, dshProcessEnv } from '../../member/dsh/credentials.mjs';
import { runDshCatalogProbe } from '../../member/dsh/index.mjs';
import { dshWakeEnv, wakeDshSession } from '../../member/dsh/wake.mjs';

function credentialsFixture(t, content) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-credentials-'));
  const path = join(directory, '.credentials.yaml');
  if (content !== null) writeFileSync(path, content);
  t.after(() => { try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ } });
  return path;
}

test('readDshApiKey extracts DEEPSEEK_API_KEY from credentials', t => {
  const path = credentialsFixture(t, 'other: 1\n  DEEPSEEK_API_KEY: "sk-test-abc123"\nlast: 2\n');
  assert.equal(readDshApiKey(path), 'sk-test-abc123');
});

test('readDshApiKey returns null when file or field is missing', t => {
  assert.equal(readDshApiKey(credentialsFixture(t, 'other: 1\n')), null);
  assert.equal(readDshApiKey(credentialsFixture(t, null)), null);
});

test('dshProcessEnv injects key only when absent, without mutating base', t => {
  const path = credentialsFixture(t, 'DEEPSEEK_API_KEY: sk-from-file\n');
  const base = { PATH: '/usr/bin' };
  const injected = dshProcessEnv(base, path);
  assert.equal(injected.DEEPSEEK_API_KEY, 'sk-from-file');
  assert.equal(base.DEEPSEEK_API_KEY, undefined, 'base env must stay untouched');
  assert.equal(injected.PATH, '/usr/bin');
});

test('dshProcessEnv preserves an existing key and passes through when unreadable', t => {
  const path = credentialsFixture(t, 'DEEPSEEK_API_KEY: sk-from-file\n');
  const existing = { DEEPSEEK_API_KEY: 'sk-from-env' };
  assert.equal(dshProcessEnv(existing, path).DEEPSEEK_API_KEY, 'sk-from-env');
  const empty = { PATH: '/usr/bin' };
  assert.deepEqual(dshProcessEnv(empty, credentialsFixture(t, null)), empty);
});

test('runDshCatalogProbe passes the injected key to the dsh child process', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-env-probe-'));
  const seen = join(directory, 'seen.txt');
  const script = join(directory, 'fake-dsh.mjs');
  writeFileSync(script, `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(seen)}, process.env.DEEPSEEK_API_KEY ?? '<missing>');
process.stdout.write('AGENT_TEAM_DSH_MODEL_CATALOG ' + JSON.stringify({ ok: true, defaultModel: 'p/m', providers: [{ id: 'p', models: [{ id: 'm' }] }], failures: [] }) + '\\n');
`);
  const fake = process.platform === 'win32' ? join(directory, 'fake-dsh.cmd') : script;
  if (process.platform === 'win32') writeFileSync(fake, `@echo off\r\n"${process.execPath}" "%~dp0fake-dsh.mjs" %*\r\n`);
  else { writeFileSync(script, `#!/usr/bin/env node\n` + readFileSync(script, 'utf8')); chmodSync(fake, 0o700); }
  t.after(() => { try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ } });
  const env = dshProcessEnv({ PATH: process.env.PATH ?? '' }, credentialsFixture(t, 'DEEPSEEK_API_KEY: sk-injected\n'));
  const result = await runDshCatalogProbe(fake, directory, { env });
  assert.ok(Array.isArray(result.providers));
  assert.equal(readFileSync(seen, 'utf8'), 'sk-injected');
});

test('dshWakeEnv 从凭据文件补齐唤醒回合的 key,extraEnv 优先', t => {
  const path = credentialsFixture(t, 'DEEPSEEK_API_KEY: sk-wake-file\n');
  const injected = dshWakeEnv({ baseEnv: { PATH: '/usr/bin' }, credentialsPath: path });
  assert.equal(injected.DEEPSEEK_API_KEY, 'sk-wake-file');
  assert.equal(injected.PATH, '/usr/bin');

  const explicit = dshWakeEnv({ baseEnv: { PATH: '/usr/bin' }, extraEnv: { DEEPSEEK_API_KEY: 'sk-explicit' }, credentialsPath: path });
  assert.equal(explicit.DEEPSEEK_API_KEY, 'sk-explicit', '调用方显式提供的 key 优先');

  const empty = { PATH: '/bin' };
  assert.deepEqual(dshWakeEnv({ baseEnv: empty, credentialsPath: credentialsFixture(t, null) }), empty);
});

test('wakeDshSession 把凭据注入唤醒子进程', async t => {
  const saved = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  t.after(() => { if (saved !== undefined) process.env.DEEPSEEK_API_KEY = saved; });

  const directory = mkdtempSync(join(tmpdir(), 'dsh-wake-env-'));
  const seen = join(directory, 'seen.txt');
  const script = join(directory, 'fake-dsh.mjs');
  writeFileSync(script, `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(seen)}, process.env.DEEPSEEK_API_KEY ?? '<missing>');
process.stdout.write(JSON.stringify({ type: 'status', phase: 'turn_end', reason: { kind: 'completed' } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'final', text: 'ok' }) + '\\n');
`);
  const fake = process.platform === 'win32' ? join(directory, 'fake-dsh.cmd') : script;
  if (process.platform === 'win32') writeFileSync(fake, `@echo off\r\n"${process.execPath}" "%~dp0fake-dsh.mjs" %*\r\n`);
  else { writeFileSync(script, `#!/usr/bin/env node\n` + readFileSync(script, 'utf8')); chmodSync(fake, 0o700); }
  t.after(() => { try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ } });

  const result = await wakeDshSession({
    command: fake,
    threadId: 'thread-1',
    text: 'hi',
    credentialsPath: credentialsFixture(t, 'DEEPSEEK_API_KEY: sk-wake-injected\n'),
    timeout: 15000,
  });

  assert.equal(result.state, 'started');
  assert.equal(readFileSync(seen, 'utf8'), 'sk-wake-injected');
});

test('DSH catalog waits for stdout completion and defers exit outside the write callback', async () => {
  const timers = [];
  const writes = [];
  const exits = [];
  const source = readFileSync(new URL('../../member/dsh/model-catalog.mjs', import.meta.url), 'utf8');
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

test('DSH 目录探测写入 patch 的插件模块路径必须真实存在', () => {
  const source = readFileSync(new URL('../../member/dsh/index.mjs', import.meta.url), 'utf8');
  const base = new URL('../../member/dsh/index.mjs', import.meta.url);
  const refs = [...source.matchAll(/new URL\('(\.\/[^']+)'/g)].map(match => match[1]);
  assert.ok(refs.length > 0, 'index.mjs 应至少引用一个相对插件模块');
  assert.ok(source.includes("'agent-team-model-catalog'"), '目录探测应插入 agent-team 模型目录插件');
  for (const ref of refs) {
    assert.ok(existsSync(new URL(ref, base)), `引用的插件模块不存在: ${ref}`);
  }
});
