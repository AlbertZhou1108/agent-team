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
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  }
});

test('POST /api/teams/:groupId/stop stops running turns by member or whole team and overview reports runningByGroup', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-stop-route-'));
  let server;
  const started = new Map();
  let releaseAll;
  const hold = new Promise(resolve => { releaseAll = resolve; });
  const fakeHost = () => ({
    async run(ctx) {
      started.set(ctx.endpoint.member_id, ctx.signal);
      ctx.onAccepted?.();
      await new Promise((resolve, reject) => {
        if (ctx.signal.aborted) { reject(new Error('aborted')); return; }
        ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        hold.then(resolve);
      });
      return { text: 'done' };
    },
  });
  try {
    server = await startServer({
      directory,
      hosts: new Map([['codex', fakeHost()]]),
    });
    const post = (path, body) => fetch(new URL(path, server.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const createdRes = await post('/api/groups', {
      operationId: 'op-stop-test',
      name: '停止测试团队',
      workspace: directory,
      lead: { name: '主控', host: 'codex' },
      members: [{ name: '成员A', host: 'codex' }],
    });
    assert.equal(createdRes.status, 200);
    const group = await createdRes.json();
    const overviewBefore = await (await fetch(new URL('/api/overview', server.url))).json();
    const teamMembers = overviewBefore.members.filter(item => item.group_id === group.id);
    const lead = teamMembers.find(item => item.role === 'lead');
    const worker = teamMembers.find(item => item.role !== 'lead');

    // 等待主控与成员双双进入运行态
    const deadline = Date.now() + 5000;
    while (started.size < 2 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(started.size, 2);

    // 非法参数与不存在成员校验
    const badKey = await post(`/api/teams/${encodeURIComponent(group.id)}/stop`, { extra: true });
    assert.equal(badKey.status, 400);
    const badMemberId = await post(`/api/teams/${encodeURIComponent(group.id)}/stop`, { memberId: '  ' });
    assert.equal(badMemberId.status, 400);
    const missingMember = await post(`/api/teams/${encodeURIComponent(group.id)}/stop`, { memberId: 'no-such-member' });
    assert.equal(missingMember.status, 404);

    // overview.runningByGroup 准确反映当前 2 路运行
    const overviewRunning = await (await fetch(new URL('/api/overview', server.url))).json();
    assert.equal(overviewRunning.runningByGroup[group.id], 2);

    // 先仅停止 worker
    const stopOne = await post(`/api/teams/${encodeURIComponent(group.id)}/stop`, { memberId: worker.id });
    assert.equal(stopOne.status, 200);
    assert.deepEqual(await stopOne.json(), { groupId: group.id, memberId: worker.id, stopped: 1 });
    assert.equal(started.get(worker.id).aborted, true);
    assert.equal(started.get(lead.id).aborted, false);

    // 再停止整队剩余运行回合
    const stopAll = await post(`/api/teams/${encodeURIComponent(group.id)}/stop`, {});
    assert.equal(stopAll.status, 200);
    assert.deepEqual(await stopAll.json(), { groupId: group.id, memberId: null, stopped: 1 });
    assert.equal(started.get(lead.id).aborted, true);

    // 空运行时幂等返回 stopped: 0
    const idleRes = await post(`/api/teams/${encodeURIComponent(group.id)}/stop`, {});
    assert.equal(idleRes.status, 200);
    assert.deepEqual(await idleRes.json(), { groupId: group.id, memberId: null, stopped: 0 });

    const overviewAfter = await (await fetch(new URL('/api/overview', server.url))).json();
    assert.equal(overviewAfter.runningByGroup[group.id] ?? 0, 0);

    // 归档后停止请求应被 410 拦截
    const archiveRes = await post(`/api/teams/${encodeURIComponent(group.id)}/archive`, {});
    assert.equal(archiveRes.status, 200);
    const archivedStop = await post(`/api/teams/${encodeURIComponent(group.id)}/stop`, {});
    assert.equal(archivedStop.status, 410);
  } finally {
    releaseAll?.();
    await server?.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论 */ }
  }
});
