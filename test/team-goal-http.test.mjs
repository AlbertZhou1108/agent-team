import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.mjs';
import { confirmedGroup, testContract } from './helpers.mjs';

async function until(fn) {
  for (let index = 0; index < 400; index++) {
    if (fn()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('timeout');
}

async function post(base, path, body) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}

test('goal lifecycle HTTP endpoints confirm queue and archive actions as the trusted user', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-goal-http-'));
  const server = await startServer({
    directory,
    panelAuth: false,
    hosts: new Map([['fake', {
      async run(context) {
        if (context.endpoint.context === 'profile') {
          await context.onTool('profile_set', { text: 'ready' });
        }
        context.onAccepted();
        return 'done';
      },
    }]]),
  });
  t.after(async () => {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const group = confirmedGroup(server.bus, {
    name: 'HTTP lifecycle',
    workspace: directory,
    lead: { name: 'Lead', host: 'fake' },
    members: [{ name: 'Worker', host: 'fake' }],
  });
  await until(() => server.bus.running.size === 0);
  const base = new URL(server.url).origin;
  const initial = server.bus.lifecycle.read(group.id);

  const coordination = server.bus.store.endpoint(group.lead, 'coordination');
  const created = await server.bus.tool(
    coordination.id,
    coordination.key,
    'goal_draft_create',
    {
      contract: JSON.stringify({ ...testContract, goal: 'queued over HTTP' }),
      revision: initial.team.revision,
      operationId: 'http-draft-create',
    },
  );
  const confirmed = await post(
    base,
    `/api/teams/${group.id}/goal-drafts/${created.draft.id}/confirm`,
    {
      revision: created.revision,
      operationId: 'http-draft-confirm',
      draftRevision: created.draft.revision,
      hash: created.draft.hash,
    },
  );
  assert.equal(confirmed.goal.state, 'queued');

  const cancelled = await post(
    base,
    `/api/teams/${group.id}/goals/${confirmed.goal.id}/cancel`,
    {
      revision: confirmed.revision,
      operationId: 'http-goal-cancel',
      reason: 'no longer needed',
    },
  );
  assert.equal(cancelled.goal.state, 'cancelled');

  const current = server.bus.lifecycle.read(group.id).current;
  assert.ok(current);
  const terminated = await post(
    base,
    `/api/teams/${group.id}/goals/${current.id}/terminate`,
    {
      revision: cancelled.revision,
      operationId: 'http-goal-terminate',
      reason: 'HTTP test complete',
    },
  );
  assert.equal(terminated.current, null);

  const archived = await post(base, `/api/teams/${group.id}/archive`, {
    revision: terminated.revision,
    operationId: 'http-team-archive',
  });
  assert.equal(archived.team.state, 'archived');
  const read = await (await fetch(`${base}/api/teams/${group.id}/goals`)).json();
  assert.equal(read.team.state, 'archived');
  const worker = server.bus.members(group.id).find(member => member.role === 'member');
  const workerEndpoint = server.bus.store.endpoint(worker.id, `pair:${group.lead}`, group.lead);
  await assert.rejects(
    server.bus.tool(workerEndpoint.id, workerEndpoint.key, 'send', {
      to: group.lead,
      text: 'archived team message',
    }),
    /归档/,
  );

  const restored = await post(base, `/api/teams/${group.id}/restore`, {
    revision: archived.revision,
    operationId: 'http-team-restore',
  });
  assert.equal(restored.team.state, 'open');
});
