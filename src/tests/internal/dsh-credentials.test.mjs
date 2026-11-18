import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDshApiKey, dshProcessEnv } from '../../hosts/dsh-credentials.mjs';
import { runDshCatalogProbe } from '../../hosts/dsh.mjs';

function credentialsFixture(t, content) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-credentials-'));
  const path = join(directory, '.credentials.yaml');
  if (content !== null) writeFileSync(path, content);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
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
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = dshProcessEnv({ PATH: process.env.PATH ?? '' }, credentialsFixture(t, 'DEEPSEEK_API_KEY: sk-injected\n'));
  const result = await runDshCatalogProbe(fake, directory, { env });
  assert.ok(Array.isArray(result.providers));
  assert.equal(readFileSync(seen, 'utf8'), 'sk-injected');
});
