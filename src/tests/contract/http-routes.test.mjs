import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../server.mjs';

test('HTTP routes enforce methods, preserve errors and keep SSE open', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-routes-'));
  let server;
  try {
    server = await startServer({ directory, hosts: new Map() });
    const request = (path, init) => fetch(new URL(path, server.url), init);
    for (const [path, method, status] of [
      ['/api/missing', 'GET', 404], ['/api/missing', 'POST', 403],
      ['/api/groups', 'POST', 415], ['/api/panel-agent', 'DELETE', 403],
      ['/api/panel-agent/update', 'GET', 404], ['/api/panel-agent/events', 'POST', 403],
    ]) {
      const response = await request(path, { method });
      assert.equal(response.status, status, `${method} ${path}`);
      await response.text();
    }
    const unsupportedBody = await request('/api/panel-agent', { method: 'POST', body: '{}' });
    assert.equal(unsupportedBody.status, 415);
    await unsupportedBody.text();
    const telemetry = await request('/api/telemetry/missing?group=missing');
    assert.equal(telemetry.status, 404);
    assert.deepEqual(await telemetry.json(), { error: 'Not found' });
    const controller = new AbortController();
    const stream = await request('/api/panel-agent/events', { signal: controller.signal });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get('content-type'), /text\/event-stream/);
    const reader = stream.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /: connected/);
    controller.abort();
    await reader.cancel().catch(() => {});
  } finally {
    await server?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
