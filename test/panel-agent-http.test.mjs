import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.mjs';
import { rpc } from '../src/rpc.mjs';

async function until(fn) {
  for (let index = 0; index < 400; index++) {
    if (fn()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('timeout');
}

const fakeHost = {
  async listModels() {
    return {
      version: 1,
      host: 'fake',
      source: 'test',
      defaultModel: 'fake-model',
      reasoningEfforts: [{ id: 'low', label: 'low' }],
      models: [{
        id: 'fake-model',
        key: 'fake-model',
        label: 'Fake Model',
        provider: 'fake-provider',
        reasoningEfforts: [{ id: 'low', label: 'low' }],
        defaultReasoningEffort: 'low',
        isDefault: true,
      }],
    };
  },
  async run(context) {
    context.onSession(context.endpoint.session ?? context.endpoint.id);
    context.onAccepted();
    return context.endpoint.context.startsWith('panel-') ? 'panel reply' : 'done';
  },
};

test('Panel Agent HTTP API lazily creates identity and controls team relations', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-panel-http-'));
  const server = await startServer({
    directory,

    hosts: new Map([['fake', fakeHost]]),
  });
  t.after(async () => {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const group = server.bus.createGroup({
    name: 'legacy team',
    workspace: directory,
    lead: { name: 'lead', host: 'fake' },
    members: [{ name: 'worker', host: 'fake' }],
  });
  const base = new URL(server.url).origin;

  const empty = await (await fetch(base + '/api/panel-agent')).json();
  assert.equal(empty.agent, null);

  const createdResponse = await fetch(base + '/api/panel-agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      name: 'Panel Agent',
      host: 'fake',
      model_provider: 'fake-provider',
      model: 'fake-model',
      reasoning_effort: 'low',
    }),
  });
  assert.equal(createdResponse.status, 200);
  const created = await createdResponse.json();
  assert.equal(created.agent.name, 'Panel Agent');
  assert.equal(created.teams.find(team => team.id === group.id).relation, 'observer');
  assert.equal(server.bus.members(group.id).some(member => member.id === created.agent.id), false);

  const chatResponse = await fetch(base + '/api/panel-agent/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ text: '总结当前团队' }),
  });
  assert.equal(chatResponse.status, 200);
  const conversation = await (await fetch(base + '/api/panel-agent')).json();
  assert.deepEqual(conversation.conversation.map(message => message.role), ['user', 'assistant']);
  assert.equal(conversation.conversation[0].active_team_id, null);
  assert.equal(server.bus.store.all('SELECT * FROM messages WHERE text=?', '总结当前团队').length, 0);

  const privateSession = server.bus.store.panelSession(created.agent.id, 'private');
  const approvedTeam = await server.bus.panelTool(
    privateSession.id,
    privateSession.key,
    'team_create',
    {
      name: 'panel-created over HTTP',
      workspace: directory,
      members: 'created-worker=fake',
    },
  );
  assert.equal(approvedTeam.lead, null);
  assert.equal(server.bus.panelTeamRelation(approvedTeam.id), 'main');

  const takeoverRequest = await server.bus.panelTool(
    privateSession.id,
    privateSession.key,
    'request_team_takeover',
    { groupId: group.id },
    { activeTeamId: group.id },
  );
  assert.equal(takeoverRequest.kind, 'takeover');
  assert.equal(takeoverRequest.state, 'pending');
  const takeoverResponse = await fetch(base + `/api/interactions/${takeoverRequest.id}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ answer: { approved: true } }),
  });
  assert.equal(takeoverResponse.status, 200);
  const taken = await takeoverResponse.json();
  assert.equal(taken.state, 'answered');
  assert.equal(server.bus.controllerState(group.id).controller.kind, 'panel_agent');
  assert.equal(server.bus.controllerState(group.id).panelRelation, 'main');
  const coordinationSession = server.bus.store.panelSession(created.agent.id, 'coordination', group.id);
  assert.equal((await fetch(base + `/api/history?endpoint=${coordinationSession.id}`)).status, 200);
  assert.equal((await fetch(base + `/api/models?endpoint=${coordinationSession.id}`)).status, 200);
  await until(() => !server.bus.running.size);
  const beforeTeamChat = server.bus.panelAgentState().conversation.length;
  const teamFirstChat = await rpc(server.socketPath, {
    op: 'chat',
    group: group.id,
    text: '从团队入口发起的私人消息',
  });
  assert.equal(teamFirstChat.status, 'queued');
  await until(() => !server.bus.running.size);
  const afterTeamChat = await (await fetch(base + '/api/panel-agent')).json();
  assert.equal(afterTeamChat.conversation.at(-1).active_team_id, null);
  assert.equal(afterTeamChat.conversation.length, beforeTeamChat);
  assert.equal(server.bus.store.get('SELECT recipient FROM messages WHERE id=?', teamFirstChat.messageId).recipient, created.agent.id);

  const staleHandback = await fetch(base + `/api/teams/${group.id}/handback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: 0 }),
  });
  assert.equal(staleHandback.status, 400);

  const action = server.bus.requestPanelControllerAction(
    created.agent,
    server.bus.store.panelSession(created.agent.id, 'private'),
    { turnId: 'test-turn', callId: 'test-call', activeTeamId: group.id },
    'handback',
    group.id,
  );
  assert.equal(action.kind, 'handback');
  assert.equal(action.state, 'pending');
  const handback = await fetch(base + `/api/interactions/${action.id}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ answer: { approved: true } }),
  });
  assert.equal(handback.status, 200);
  const returned = await handback.json();
  assert.equal(returned.state, 'answered');
  assert.equal(returned.answer.approved, true);
  assert.equal(server.bus.controllerState(group.id).controller.kind, 'member');
  assert.equal(server.bus.controllerState(group.id).panelRelation, 'observer');

  const plainText = await fetch(base + '/api/panel-agent/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: 'hello',
  });
  assert.equal(plainText.status, 415);
});
