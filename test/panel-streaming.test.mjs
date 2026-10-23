import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../src/bus.mjs';
import { startServer } from '../src/server.mjs';
import { confirmedGroup } from './helpers.mjs';

const until = async fn => {
  for (let index = 0; index < 400; index += 1) {
    if (fn()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('timeout');
};

function catalog() {
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
}

function streamingHost(control) {
  return {
    async listModels() {
      return catalog();
    },
    async run(context) {
      context.onSession(context.endpoint.session ?? 'fake-session');
      context.onAccepted();
      if (context.endpoint.context === 'profile') return 'ready';
      context.onTextDelta('你', { part: 1 });
      context.onTextDelta('好', { part: 2 });
      await new Promise(resolve => {
        control.release = resolve;
      });
      return '你好';
    },
  };
}

async function createPanel(bus, workspace) {
  await bus.createPanelAgent({
    name: 'Panel Agent',
    host: 'fake',
    model_provider: 'fake-provider',
    model: 'fake-model',
    reasoning_effort: 'low',
    workspace,
    access: 'workspace-write',
  });
}

test('Panel streaming state accumulates deltas and is replaced by the durable final reply', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-panel-stream-'));
  const workspace = mkdtempSync(join(tmpdir(), 'agent-panel-stream-work-'));
  const control = {};
  const bus = new Bus({
    directory,
    hosts: new Map([['fake', streamingHost(control)]]),
  });
  t.after(async () => {
    await bus.close();
    rmSync(directory, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });
  await createPanel(bus, workspace);
  const events = [];
  bus.on('panel-stream', event => events.push(event));

  const pending = bus.panelPrivateTurn('stream this');
  await until(() => bus.panelAgentState().streaming?.[0]?.text === '你好');
  const active = bus.panelAgentState().streaming[0];
  assert.equal(active.context, 'private');
  assert.equal(active.text, '你好');
  assert.equal(events.filter(event => event.type === 'delta').length, 2);
  assert.ok(
    events
      .filter(event => event.type === 'delta')
      .every(event => event.stream.text === '' && event.delta.length > 0),
  );

  control.release();
  const result = await pending;
  assert.equal(result.result, '你好');
  assert.deepEqual(bus.panelAgentState().streaming, []);
  assert.deepEqual(bus.panelAgentState().conversation.map(message => message.role), ['user', 'assistant']);
  assert.equal(bus.panelAgentState().conversation.at(-1).text, '你好');
  const complete = events.find(event => event.type === 'complete');
  assert.equal(complete.stream.text, '你好');
});

test('Panel SSE sends live deltas and completion over the local event stream', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-panel-sse-'));
  const workspace = mkdtempSync(join(tmpdir(), 'agent-panel-sse-work-'));
  const control = {};
  const server = await startServer({
    directory,
    hosts: new Map([['fake', streamingHost(control)]]),
  });
  const abort = new AbortController();
  let closed = false;
  t.after(async () => {
    if (!closed) await server.close();
    abort.abort();
    rmSync(directory, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });
  await createPanel(server.bus, workspace);
  const base = new URL(server.url).origin;
  const events = await fetch(`${base}/api/panel-agent/events`, {
    signal: abort.signal,
  });
  assert.match(events.headers.get('content-type'), /^text\/event-stream/);
  const reader = events.body.getReader();
  const decoder = new TextDecoder();
  let received = '';
  const readUntil = async pattern => {
    while (!pattern.test(received)) {
      const { value, done } = await reader.read();
      if (done) break;
      received += decoder.decode(value, { stream: true });
    }
    assert.match(received, pattern);
  };

  const pending = fetch(`${base}/api/panel-agent/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ text: 'live reply' }),
    signal: abort.signal,
  });
  await readUntil(/"type":"delta".*"text":"".*"delta":"你"/);
  control.release();
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal((await response.json()).reply.text, '你好');
  await readUntil(/"type":"complete".*"text":"你好"/);
  await server.close();
  closed = true;
  abort.abort();
});

test('team SSE sends directive deltas before the durable team reply', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-sse-'));
  const control = {};
  const server = await startServer({
    directory,
    hosts: new Map([['fake', streamingHost(control)]]),
  });
  const abort = new AbortController();
  let closed = false;
  t.after(async () => {
    if (!closed) await server.close();
    abort.abort();
    rmSync(directory, { recursive: true, force: true });
  });
  const group = confirmedGroup(server.bus, {
    name: 'team stream',
    workspace: directory,
    lead: { name: 'Lead', host: 'fake' },
    members: [],
  });
  await until(() => !server.bus.running.size);
  const base = new URL(server.url).origin;
  const events = await fetch(
    `${base}/api/teams/${group.id}/events`,
    { signal: abort.signal },
  );
  assert.match(events.headers.get('content-type'), /^text\/event-stream/);
  const reader = events.body.getReader();
  const decoder = new TextDecoder();
  let received = '';
  const lateAbort = new AbortController();
  const readUntil = async pattern => {
    while (!pattern.test(received)) {
      const { value, done } = await reader.read();
      if (done) break;
      received += decoder.decode(value, { stream: true });
    }
    assert.match(received, pattern);
  };
  const pending = fetch(`${base}/api/teams/${group.id}/directives`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      text: 'stream to team',
      operationId: 'team-stream',
      controllerId: group.lead,
    }),
    signal: abort.signal,
  });
  await readUntil(/"type":"delta".*"delta":"你"/);
  const lateEvents = await fetch(
    `${base}/api/teams/${group.id}/events`,
    { signal: lateAbort.signal },
  );
  const lateReader = lateEvents.body.getReader();
  let lateReceived = '';
  while (!/"type":"snapshot".*"text":"你好"/.test(lateReceived)) {
    const { value, done } = await lateReader.read();
    if (done) break;
    lateReceived += decoder.decode(value, { stream: true });
  }
  assert.match(lateReceived, /"type":"snapshot".*"text":"你好"/);
  lateAbort.abort();
  control.release();
  const response = await pending;
  assert.equal(response.status, 200);
  const receipt = await response.json();
  await readUntil(/"type":"complete".*"text":"你好"/);
  const reply = server.bus.store.get(
    'SELECT * FROM messages WHERE reply_to=?',
    receipt.messageId,
  );
  assert.equal(reply.text, '你好');
  await server.close();
  closed = true;
  abort.abort();
});
