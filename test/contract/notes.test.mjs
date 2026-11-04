import test from 'node:test';
import assert from 'node:assert/strict';
import { serverScenario } from '../support/fixture.mjs';

async function setup(t) {
  const { server, url, bus } = await serverScenario(t);
  const call = async (path, init) => {
    const response = await fetch(new URL(path, url), init);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const json = (method, body) => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { server, bus, call, json };
}

async function create(call, json, body) {
  const result = await call('/api/notes', json('POST', body));
  assert.equal(result.status, 200);
  return result.body;
}

test('capture derives a title from the first line and keeps todos optional', async t => {
  const { call, json } = await setup(t);
  const note = await create(call, json, {
    body: '多端同步的冲突处理我一直没想清楚\n先记下来',
    todos: [{ text: '确认冲突合并策略' }, { text: '问运维窗口', done: true }],
    due: '2026-11-08',
  });
  assert.equal(note.title, '多端同步的冲突处理我一直没想清楚');
  assert.equal(note.titleManual, false);
  assert.deepEqual(note.todos, [
    { text: '确认冲突合并策略', done: false },
    { text: '问运维窗口', done: true },
  ]);
  assert.equal(note.state, 'active');
  assert.equal(note.revision, 1);
});

test('one client id is idempotent for the same payload and rejected for a different one', async t => {
  const { call, json } = await setup(t);
  const payload = { id: 'note-fixed', body: '同一条想法' };
  const first = await create(call, json, payload);
  const replay = await create(call, json, payload);
  assert.equal(replay.id, first.id);
  assert.equal(replay.revision, 1);
  const conflict = await call('/api/notes', json('POST', { id: 'note-fixed', body: '不同的想法' }));
  assert.equal(conflict.status, 409);
});

test('title follows the body until the user edits it, then stays put', async t => {
  const { call, json } = await setup(t);
  const note = await create(call, json, { body: '第一行标题\n正文' });
  const renamed = await call(`/api/notes/${note.id}`, json('PATCH', { revision: note.revision, body: '新的第一行\n正文' }));
  assert.equal(renamed.body.title, '新的第一行');
  const manual = await call(`/api/notes/${note.id}`, json('PATCH', { revision: renamed.body.revision, title: '我自己起的' }));
  assert.equal(manual.body.titleManual, true);
  const edited = await call(`/api/notes/${note.id}`, json('PATCH', { revision: manual.body.revision, body: '又换了第一行' }));
  assert.equal(edited.body.title, '我自己起的');
  const cleared = await call(`/api/notes/${note.id}`, json('PATCH', { revision: edited.body.revision, title: '' }));
  assert.equal(cleared.body.title, '又换了第一行');
  assert.equal(cleared.body.titleManual, false);
});

test('stale revisions are rejected instead of silently overwriting', async t => {
  const { call, json } = await setup(t);
  const note = await create(call, json, { body: '并发编辑' });
  const saved = await call(`/api/notes/${note.id}`, json('PATCH', { revision: note.revision, body: '改了一次' }));
  assert.equal(saved.status, 200);
  const stale = await call(`/api/notes/${note.id}`, json('PATCH', { revision: note.revision, body: '另一个窗口' }));
  assert.equal(stale.status, 409);
  assert.equal((await call(`/api/notes/${note.id}`)).body.body, '改了一次');
});

test('done and archive keep the state machine reversible, delete needs archive first', async t => {
  const { call, json } = await setup(t);
  const note = await create(call, json, { body: '状态流转' });

  const done = await call(`/api/notes/${note.id}/state`, json('POST', { state: 'done', revision: 1 }));
  assert.equal(done.body.state, 'done');
  assert.ok(done.body.completed);

  const undone = await call(`/api/notes/${note.id}/state`, json('POST', { state: 'active', revision: 2 }));
  assert.equal(undone.body.state, 'active');
  assert.equal(undone.body.completed, null);

  const early = await call(`/api/notes/${note.id}`, { method: 'DELETE' });
  assert.equal(early.status, 409, '未归档的记录不能删除');

  const archived = await call(`/api/notes/${note.id}/state`, json('POST', { state: 'archived', revision: 3 }));
  assert.equal(archived.body.state, 'archived');
  const restored = await call(`/api/notes/${note.id}/state`, json('POST', { state: 'restore', revision: 4 }));
  assert.equal(restored.body.state, 'active', '恢复回到归档前的状态');

  await call(`/api/notes/${note.id}/state`, json('POST', { state: 'archived', revision: 5 }));
  const removed = await call(`/api/notes/${note.id}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body, { deleted: note.id });
  assert.equal((await call(`/api/notes/${note.id}`)).status, 404);
});

test('archived notes are read-only until restored', async t => {
  const { call, json } = await setup(t);
  const note = await create(call, json, { body: '归档后改不了' });
  await call(`/api/notes/${note.id}/state`, json('POST', { state: 'archived', revision: 1 }));
  const edit = await call(`/api/notes/${note.id}`, json('PATCH', { revision: 2, body: '试试' }));
  assert.equal(edit.status, 409);
});

test('list filters by state, searches todos and pages stably', async t => {
  const { call, json } = await setup(t);
  const first = await create(call, json, { body: '同步方案', todos: [{ text: '确认冲突合并' }] });
  const second = await create(call, json, { body: '周末去哪' });
  await create(call, json, { body: '已经做完的事' });
  const doneNote = await call(`/api/notes/${second.id}/state`, json('POST', { state: 'done', revision: 1 }));
  assert.equal(doneNote.body.state, 'done');

  const active = await call('/api/notes');
  assert.equal(active.body.notes.length, 2);
  assert.ok(active.body.notes.some(row => row.id === first.id));
  assert.deepEqual(active.body.counts, { active: 2, done: 1, archived: 0 });

  const done = await call('/api/notes?state=done');
  assert.deepEqual(done.body.notes.map(row => row.id), [second.id]);

  const search = await call('/api/notes?state=all&q=冲突合并');
  assert.deepEqual(search.body.notes.map(row => row.id), [first.id], '待办文本也可被搜索');

  const paged = await call('/api/notes?state=all&limit=1');
  assert.equal(paged.body.notes.length, 1);
  assert.ok(paged.body.nextCursor);
  const next = await call(`/api/notes?state=all&limit=1&cursor=${encodeURIComponent(paged.body.nextCursor)}`);
  assert.equal(next.body.notes.length, 1);
  assert.notEqual(next.body.notes[0].id, paged.body.notes[0].id);
});

test('validation rejects empty bodies, bad todos and bad due dates', async t => {
  const { call, json } = await setup(t);
  assert.equal((await call('/api/notes', json('POST', { body: '   ' }))).status, 400);
  assert.equal((await call('/api/notes', json('POST', { body: 'x', todos: [{ text: ' ' }] }))).status, 400);
  assert.equal((await call('/api/notes', json('POST', { body: 'x', todos: 'nope' }))).status, 400);
  assert.equal((await call('/api/notes', json('POST', { body: 'x', due: '2026/11/08' }))).status, 400);
  assert.equal((await call('/api/notes/unknown')).status, 404);
});

test('prompt is self-contained, omits empty sections and never leaks internal ids', async t => {
  const { call, json } = await setup(t);
  const note = await create(call, json, {
    body: '把同步方案写清楚\n\n现在最后写入者赢，产品不希望丢数据。',
    todos: [{ text: '确认冲突合并策略' }, { text: '问运维窗口', done: true }],
    due: '2026-11-08',
  });
  const { text } = await call(`/api/notes/${note.id}/prompt?instruction=${encodeURIComponent('重点拆待办')}`).then(r => r.body);
  assert.match(text, /【随心记】/);
  assert.match(text, /标题：把同步方案写清楚/);
  assert.match(text, /现在最后写入者赢/);
  assert.match(text, /- \[ \] 确认冲突合并策略/);
  assert.match(text, /- \[x\] 问运维窗口/);
  assert.match(text, /截止：2026-11-08/);
  assert.match(text, /补充要求：重点拆待办/);
  assert.match(text, /A\. 已经清楚/);
  assert.match(text, /B\. 大致清楚/);
  assert.match(text, /C\. 关键信息缺失/);
  assert.match(text, /在我明确同意之前，不要开始执行/);
  assert.doesNotMatch(text, new RegExp(note.id));
  assert.doesNotMatch(text, /revision|版本 r\d/);

  const bare = (await call(`/api/notes/${note.id}/prompt`)).body.text;
  assert.doesNotMatch(bare, /补充要求：/);
  const simple = await create(call, json, { body: '没有待办也没有截止' });
  const simpleText = (await call(`/api/notes/${simple.id}/prompt`)).body.text;
  assert.doesNotMatch(simpleText, /待办：/);
  assert.doesNotMatch(simpleText, /截止：/);
});

test('prompt warns about nested fences when the note already contains code', async t => {
  const { call, json } = await setup(t);
  const note = await create(call, json, { body: '示例：\n```js\nrun()\n```' });
  const { text } = (await call(`/api/notes/${note.id}/prompt`)).body;
  assert.match(text, /四个反引号/);
});
