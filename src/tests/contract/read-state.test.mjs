// 读水位的对外行为：按会话隔离、只进不退、拒绝非法目标。
// 断言对象是 HTTP 返回值和它自己的读回结果，不直接断言表内容。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestGroup, serverScenario, seedPanelAgent } from '../support/fixture.mjs';

function poster(url) {
  const endpoint = new URL('/api/read', url);
  return (body, contentType = 'application/json') => fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('读水位按会话隔离，且只接受向前的更新', async t => {
  const { bus, url, group, directory } = await serverScenario(t, { members: ['one'] });
  const other = createTestGroup(bus, {
    name: 'other',
    workspace: directory,
    lead: { name: 'lead2', host: 'fake' },
  });
  const lead = bus.teamController(group.id);
  const first = bus.store.append(group.id, 'user', lead.id, 'send', '第一条指令');
  const second = bus.store.append(group.id, 'user', lead.id, 'send', '第二条指令');
  const post = poster(url);

  const advanced = await post({ scope: 'group', scopeId: group.id, seq: second.seq });
  assert.equal(advanced.status, 200);
  assert.deepEqual(await advanced.json(), { scope: 'group', scopeId: group.id, seq: second.seq });

  // 往回退的请求被忽略，已读不会变回未读。
  const regressed = await post({ scope: 'group', scopeId: group.id, seq: first.seq });
  assert.equal(regressed.status, 200);
  assert.equal((await regressed.json()).seq, second.seq);

  // 另一个团队的会话是另一个水位，互不影响。
  const isolated = await post({ scope: 'group', scopeId: other.id, seq: 1 });
  assert.equal((await isolated.json()).seq, 1);
  assert.equal((await (await post({ scope: 'group', scopeId: group.id, seq: 0 })).json()).seq, second.seq);
});

test('读水位拒绝非法目标与畸形请求', async t => {
  const { url, group } = await serverScenario(t, { members: ['one'] });
  const post = poster(url);

  assert.equal((await post({ scope: 'group', scopeId: 'missing-group', seq: 1 })).status, 400);
  assert.equal((await post({ scope: 'unknown', scopeId: group.id, seq: 1 })).status, 400);
  assert.equal((await post({ scope: 'group', scopeId: group.id, seq: -1 })).status, 400);
  assert.equal((await post({ scope: 'group', scopeId: group.id, seq: 1.5 })).status, 400);
  assert.equal((await post({ scope: 'group', scopeId: '', seq: 1 })).status, 400);
  assert.equal((await post({ scope: 'group', scopeId: group.id, seq: 1, extra: true })).status, 400);
  assert.equal((await post('{}', 'text/plain')).status, 415);
});

test('面板私聊的水位只允许当前 Panel Agent 自己的目标', async t => {
  const { bus, url } = await serverScenario(t);
  const agentId = seedPanelAgent(bus);
  const own = await poster(url)({ scope: 'panel', scopeId: `${agentId}:__global__`, seq: 3 });
  assert.equal(own.status, 200);
  assert.equal((await own.json()).seq, 3);

  const foreign = await poster(url)({ scope: 'panel', scopeId: 'someone-else:__global__', seq: 4 });
  assert.equal(foreign.status, 400);
});
