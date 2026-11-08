import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverExternalWake, externalWakePlan } from '../../src/external-delivery.mjs';

const binding = {
  status: 'active',
  host: 'codex',
  command: '/custom/codex',
  session: 'thread-1',
  wake_config: JSON.stringify({
    command: '/node',
    args: ['/cli.mjs', 'mcp', '--socket', '/tmp/bus.sock', '--client', 'binding-1'],
    env: { AGENT_TEAM_CLIENT_KEY: 'secret' },
  }),
};

test('Codex wake plan resumes the discovered thread with the MCP server reattached', () => {
  const plan = externalWakePlan(binding, { teamName: '团队', count: 2 });
  assert.equal(plan.supported, true);
  assert.equal(plan.command, '/custom/codex');
  assert.deepEqual(plan.args.slice(0, 3), ['exec', 'resume', 'thread-1']);
  assert.ok(plan.args.includes('sandbox_mode="read-only"'));
  assert.ok(!plan.args.includes('--sandbox'));
  assert.ok(!plan.args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.match(plan.args.at(-1), /control_inbox/);
  assert.match(plan.args.at(-1), /2 条待处理/);
  assert.ok(plan.args.includes('mcp_servers.agent_team.command="/node"'));
  assert.ok(plan.args.includes('mcp_servers.agent_team.default_tools_approval_mode="approve"'));
});

test('missing session or unsupported host stays pull-only', () => {
  assert.equal(externalWakePlan({ ...binding, session: null }, { teamName: 't', count: 1 }).supported, false);
  assert.equal(externalWakePlan({ ...binding, host: 'claude' }, { teamName: 't', count: 1 }).supported, false);
  assert.equal(externalWakePlan({ ...binding, wake_config: null }, { teamName: 't', count: 1 }).supported, false);
});

test('delivery preserves the CLI argument boundary with an injected runner', async () => {
  const calls = [];
  const result = await deliverExternalWake(binding, { teamName: '团队', count: 1 }, {
    run: async (command, args, timeout) => {
      calls.push({ command, args, timeout });
    },
  });
  assert.equal(result.supported, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, '/custom/codex');
  assert.equal(calls[0].args[0], 'exec');
  assert.equal(calls[0].timeout, 8 * 60 * 1000);
});
