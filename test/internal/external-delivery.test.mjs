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

test('Codex wake plan uses app-server queue with the MCP server reattached', () => {
  const plan = externalWakePlan(binding, { teamName: '团队', count: 2, workspace: '/workspace' });
  assert.equal(plan.supported, true);
  assert.equal(plan.command, '/custom/codex');
  assert.equal(plan.driver, 'codex-app-server');
  assert.equal(plan.threadId, 'thread-1');
  assert.equal(plan.cwd, '/workspace');
  assert.match(plan.text, /control_inbox/);
  assert.match(plan.text, /2 条待处理/);
  assert.deepEqual(plan.mcpConfig, {
    command: '/node',
    args: ['/cli.mjs', 'mcp', '--socket', '/tmp/bus.sock', '--client', 'binding-1'],
    env: { AGENT_TEAM_CLIENT_KEY: 'secret' },
  });
});

test('missing session or unsupported host stays pull-only', () => {
  assert.equal(externalWakePlan({ ...binding, session: null }, { teamName: 't', count: 1 }).supported, false);
  assert.equal(externalWakePlan({ ...binding, host: 'claude' }, { teamName: 't', count: 1 }).supported, false);
  assert.equal(externalWakePlan({ ...binding, wake_config: null }, { teamName: 't', count: 1 }).supported, false);
});

test('wake verification uses a non-business prompt and does not claim the inbox', () => {
  const plan = externalWakePlan(binding, {
    teamName: '团队',
    count: 0,
    verification: true,
  });
  assert.match(plan.text, /control_protocol/);
  assert.doesNotMatch(plan.text, /请调用 control_inbox/);
  assert.match(plan.text, /不是业务消息/);
});

test('delivery delegates the structured wake plan to the host driver', async () => {
  const calls = [];
  const result = await deliverExternalWake(binding, { teamName: '团队', count: 1 }, {
    wake: async plan => {
      calls.push(plan);
      return { supported: true, state: 'started', mode: 'codex' };
    },
  });
  assert.equal(result.supported, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].driver, 'codex-app-server');
  assert.equal(calls[0].command, '/custom/codex');
});

test('a changed wake fingerprint blocks automatic wake until explicit retest', async () => {
  let called = 0;
  const result = await deliverExternalWake({
    ...binding,
    wake_fingerprint: 'old-fingerprint',
  }, { teamName: '团队', count: 1 }, {
    wake: async () => {
      called += 1;
      return { supported: true, state: 'started' };
    },
  });
  assert.equal(called, 0);
  assert.equal(result.supported, true);
  assert.equal(result.state, 'failed');
  assert.match(result.reason, /重新执行验证/);
});
