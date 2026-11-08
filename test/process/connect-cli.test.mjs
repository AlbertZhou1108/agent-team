import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../../src/store.mjs';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../../src/cli.mjs', import.meta.url));

test('connect installs the Skill, prints MCP config and rotates the same binding on repeat', async t => {
  const root = mkdtempSync(join(tmpdir(), 'agent-team-connect-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const data = join(root, 'data');
  const skill = join(root, 'skill');
  const args = [
    cli,
    'connect',
    '--data', data,
    '--host', 'codex',
    '--client', 'main',
    '--principal', 'user',
    '--workspace', root,
    '--skill-root', skill,
  ];
  const first = JSON.parse((await run(process.execPath, args)).stdout);
  assert.equal(first.binding.name, 'main');
  assert.ok(first.capabilities.capabilities.includes('session.wake'));
  assert.equal(first.mcp.agent_team.env.AGENT_TEAM_CONTROL_PROTOCOL, '1');
  assert.equal(first.skill.current, true);
  assert.equal(readFileSync(join(skill, 'SKILL.md'), 'utf8').startsWith('---'), true);

  const second = JSON.parse((await run(process.execPath, args)).stdout);
  assert.equal(second.binding.id, first.binding.id);
  assert.notEqual(second.mcp.agent_team.env.AGENT_TEAM_CLIENT_KEY, first.mcp.agent_team.env.AGENT_TEAM_CLIENT_KEY);
  assert.equal(second.skill.changed, false);
  const store = new Store(data);
  try {
    assert.equal(store.get("SELECT count(*) AS n FROM external_client_bindings WHERE name='main'").n, 1);
  } finally {
    store.close();
  }
});
