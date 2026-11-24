import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { serverScenario, createTestGroup, seedPanelAgent } from '../support/fixture.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../server.mjs';
import { Bus } from '../../bus.mjs';
import { dismissWorkbench, homeWorkbench, searchWorkspace } from '../../productivity.mjs';
import { insertPrincipal } from '../../aggregates/external-control.mjs';
import * as panelAgg from '../../aggregates/panel.mjs';

describe('notes', () => {
async function setup(t, options = {}) {
  const { server, url, bus, group } = await serverScenario(t, options);
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
  return { server, bus, call, json, group };
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

test('batch prompt aggregates selected notes with one shared protocol', async t => {  const { call, json } = await setup(t);
  const first = await create(call, json, { body: '第一条：同步方案', todos: [{ text: '确认冲突合并' }] });
  const second = await create(call, json, { body: '第二条：周末去哪\n```js\nrun()\n```' });
  const prompt = await call('/api/notes/prompt', json('POST', { ids: [first.id, second.id], instruction: '一起判断' }));
  assert.equal(prompt.status, 200);
  const { text } = prompt.body;
  assert.match(text, /【随心记】先读懂这几条记录/);
  assert.match(text, /共 2 条记录。/);
  assert.match(text, /── 第 1 条 ──/);
  assert.match(text, /── 第 2 条 ──/);
  assert.match(text, /标题：第一条：同步方案/);
  assert.match(text, /- \[ \] 确认冲突合并/);
  assert.match(text, /标题：第二条：周末去哪/);
  assert.match(text, /补充要求：一起判断/);
  assert.match(text, /四个反引号/, '任一正文含代码块即提示嵌套风险');
  assert.equal((text.match(/在我明确同意之前，不要开始执行/g) ?? []).length, 1, '协议只出现一次');
  assert.doesNotMatch(text, new RegExp(first.id));
  assert.doesNotMatch(text, new RegExp(second.id));

  // 已归档记录不进提示词;未知 id 404;ids 数量钳制 1–50。
  await call(`/api/notes/${first.id}/state`, json('POST', { state: 'archived', revision: 1 }));
  assert.equal((await call('/api/notes/prompt', json('POST', { ids: [first.id] }))).status, 409);
  assert.equal((await call('/api/notes/prompt', json('POST', { ids: ['unknown'] }))).status, 404);
  assert.equal((await call('/api/notes/prompt', json('POST', { ids: [] }))).status, 400);
  assert.equal((await call('/api/notes/prompt', json('POST', { ids: Array.from({ length: 51 }, (_, index) => `id-${index}`) }))).status, 400);
});

test('a note remembers the team it was written in and lists by team or by no source', async t => {
  const { call, json, group } = await setup(t, { members: [] });
  const inTeam = await create(call, json, { body: '在团队里想到的', sourceTeamId: group.id });
  const loose = await create(call, json, { body: '随手写的' });

  assert.equal(inTeam.sourceTeamId, group.id);
  assert.equal(inTeam.sourceTeamName, group.name, '团队名现取，不落快照');
  assert.equal(loose.sourceTeamId, null);
  assert.equal(loose.sourceTeamName, null);

  const byTeam = await call(`/api/notes?state=all&team=${encodeURIComponent(group.id)}`);
  assert.deepEqual(byTeam.body.notes.map(row => row.id), [inTeam.id]);
  assert.deepEqual(byTeam.body.counts, { active: 1, done: 0, archived: 0 });

  const unfiled = await call('/api/notes?state=all&team=none');
  assert.deepEqual(unfiled.body.notes.map(row => row.id), [loose.id]);

  const everything = await call('/api/notes?state=all');
  assert.equal(everything.body.notes.length, 2, '不传 team 表示不筛选');
});

test('state counts follow the team filter so the header matches the list', async t => {
  const { call, json, group } = await setup(t, { members: [] });
  const first = await create(call, json, { body: '团队里的第一条', sourceTeamId: group.id });
  await create(call, json, { body: '团队里的第二条', sourceTeamId: group.id });
  await create(call, json, { body: '团队外的' });
  await call(`/api/notes/${first.id}/state`, json('POST', { state: 'done', revision: 1 }));

  const filtered = await call(`/api/notes?state=all&team=${encodeURIComponent(group.id)}`);
  assert.deepEqual(filtered.body.counts, { active: 1, done: 1, archived: 0 });
  const unfiled = await call('/api/notes?state=all&team=none');
  assert.deepEqual(unfiled.body.counts, { active: 1, done: 0, archived: 0 });
  const all = await call('/api/notes?state=all');
  assert.deepEqual(all.body.counts, { active: 2, done: 1, archived: 0 });
});

test('a deleted team leaves the note readable, still filterable and without a name', async t => {
  const { call, json, bus, group } = await setup(t, { members: [] });
  const note = await create(call, json, { body: '团队没了笔记还在', sourceTeamId: group.id });
  bus.store.run('DELETE FROM groups WHERE id=?', group.id);

  const after = await call(`/api/notes/${note.id}`);
  assert.equal(after.status, 200, '来源是历史事实，不随团队级联删除');
  assert.equal(after.body.sourceTeamId, group.id);
  assert.equal(after.body.sourceTeamName, null, '名字取不到就交给前端显示「团队已删除」');

  const byTeam = await call(`/api/notes?state=all&team=${encodeURIComponent(group.id)}`);
  assert.deepEqual(byTeam.body.notes.map(row => row.id), [note.id]);
});

test('only an existing team can become a source, and an existing note can change or clear it', async t => {
  const { call, json, group } = await setup(t, { members: [] });
  const ghost = await call('/api/notes', json('POST', { body: '来源写错了', sourceTeamId: 'no-such-team' }));
  assert.equal(ghost.status, 400);
  assert.equal(ghost.body.error, '来源团队不存在');

  const loose = await create(call, json, { body: '先随手记下' });
  const attached = await call(`/api/notes/${loose.id}`, json('PATCH', { revision: loose.revision, sourceTeamId: group.id }));
  assert.equal(attached.body.sourceTeamId, group.id);
  assert.equal(attached.body.sourceTeamName, group.name);

  const detached = await call(`/api/notes/${loose.id}`, json('PATCH', { revision: attached.body.revision, sourceTeamId: null }));
  assert.equal(detached.body.sourceTeamId, null);

  const bad = await call(`/api/notes/${loose.id}`, json('PATCH', { revision: detached.body.revision, sourceTeamId: 'no-such-team' }));
  assert.equal(bad.status, 400);
});

test('the same client id with a different source is treated as a different payload', async t => {
  const { call, json, group } = await setup(t, { members: [] });
  const payload = { id: 'note-source-fixed', body: '同一条想法', sourceTeamId: group.id };
  const first = await create(call, json, payload);
  const replay = await create(call, json, payload);
  assert.equal(replay.id, first.id);
  assert.equal(replay.revision, 1);

  const conflict = await call('/api/notes', json('POST', { id: 'note-source-fixed', body: '同一条想法' }));
  assert.equal(conflict.status, 409, '来源不同也算内容不同，不静默改写');
});

test('note tags have a registry, toggle on notes and filter the list', async t => {
  const { call, json } = await setup(t);
  const important = await call('/api/note-tags', json('POST', { name: '重要', color: '#22c55e' }));
  assert.equal(important.status, 200);
  assert.equal(important.body.tag.name, '重要');
  assert.equal(important.body.tag.color, '#22c55e');
  assert.equal(important.body.created, true);
  // 同名幂等返回既有标签,不报错不重复。
  const replay = await call('/api/note-tags', json('POST', { name: '重要' }));
  assert.equal(replay.body.created, false);
  assert.equal(replay.body.tag.id, important.body.tag.id);
  assert.equal((await call('/api/note-tags')).body.length, 1);
  assert.equal((await call('/api/note-tags', json('POST', { name: '' }))).status, 400);
  assert.equal((await call('/api/note-tags', json('POST', { name: 'x', color: 'red' }))).status, 400);

  // 笔记携带标签:创建与更新都按注册表校验引用,幽灵 id 400。
  const note = await create(call, json, { body: '带标签的记录', tags: [important.body.tag.id] });
  assert.deepEqual(note.tags, [important.body.tag.id]);
  const ghost = await call(`/api/notes/${note.id}`, json('PATCH', { revision: note.revision, tags: ['no-such-tag'] }));
  assert.equal(ghost.status, 400);
  const toggled = await call(`/api/notes/${note.id}`, json('PATCH', { revision: note.revision, tags: [] }));
  assert.deepEqual(toggled.body.tags, []);

  // 按标签筛选:列表与计数都跟随。
  const tagged = await create(call, json, { body: '另一条带标签', tags: [important.body.tag.id] });
  const byTag = await call(`/api/notes?state=all&tag=${encodeURIComponent(important.body.tag.id)}`);
  assert.deepEqual(byTag.body.notes.map(row => row.id), [tagged.id]);
  assert.deepEqual(byTag.body.counts, { active: 1, done: 0, archived: 0 });
  const untagged = await call('/api/notes?state=all');
  assert.ok(untagged.body.notes.length > 1);
});

test('pinned notes live in their own list, outside the paginated flow', async t => {
  const { call, json } = await setup(t);
  const first = await create(call, json, { body: '第一条要置顶' });
  const second = await create(call, json, { body: '第二条要置顶' });
  const plain = await create(call, json, { body: '普通记录' });
  await call(`/api/notes/${second.id}/pin`, json('POST', { pinned: true, revision: second.revision }));
  // pinned_at 精度是毫秒;连续置顶可能得到相同时间戳,顺序会退化为 id,这里拉开时间。
  await new Promise(resolve => setTimeout(resolve, 5));
  await call(`/api/notes/${first.id}/pin`, json('POST', { pinned: true, revision: first.revision }));

  const list = await (await call('/api/notes')).body;
  // pinned 全量返回、按置顶时间倒序(second 后置顶在前),且不占用分页流。
  assert.deepEqual(list.pinned.map(row => row.id), [first.id, second.id]);
  assert.deepEqual(list.notes.map(row => row.id), [plain.id]);
  assert.ok(list.pinned.every(row => row.pinnedAt));

  // 幂等:重复置顶不 bump revision。
  const repinned = await call(`/api/notes/${first.id}/pin`, json('POST', { pinned: true, revision: list.pinned.find(row => row.id === first.id).revision }));
  assert.equal(repinned.body.pinnedAt, list.pinned.find(row => row.id === first.id).pinnedAt, '幂等置顶不 bump revision');

  // 取消置顶回到分页流。
  const unpinned = await call(`/api/notes/${second.id}/pin`, json('POST', { pinned: false, revision: list.pinned.find(row => row.id === second.id).revision }));
  assert.equal(unpinned.body.pinnedAt, null);
  const again = await (await call('/api/notes')).body;
  assert.deepEqual(again.pinned.map(row => row.id), [first.id]);
  assert.ok(again.notes.some(row => row.id === second.id));

  // 校验:缺 pinned 字段 400,幽灵 id 404。
  assert.equal((await call('/api/notes/missing/pin', json('POST', { pinned: true, revision: 1 }))).status, 404);
  assert.equal((await call(`/api/notes/${first.id}/pin`, json('POST', { revision: 1 }))).status, 409, 'stale revision 走乐观锁冲突');
});

test('team facets only list teams that actually hold notes in the current scope', async t => {
  const { call, json, group } = await setup(t, { members: [] });
  const withTeam = await create(call, json, { body: '团队里的记录', sourceTeamId: group.id });
  const loose = await create(call, json, { body: '无来源记录' });

  const page = (await call('/api/notes?state=all')).body;
  const facets = page.teamFacets;
  assert.ok(facets.some(facet => facet.teamId === group.id && facet.count === 1), '有笔记的团队必须出现');
  assert.ok(facets.some(facet => facet.teamId === null && facet.count === 1), '无来源也作为候选');

  // 选中该团队后分面仍保留其它候选——否则下拉只剩当前项,用户切不走。
  const filtered = (await call(`/api/notes?state=all&team=${encodeURIComponent(group.id)}`)).body;
  assert.deepEqual(filtered.notes.map(row => row.id), [withTeam.id]);
  assert.ok(filtered.teamFacets.some(facet => facet.teamId === null), '选中团队后仍能看到其它维度候选');

  // 归档掉唯一那条后,该团队不再出现在候选里。
  await call(`/api/notes/${withTeam.id}/state`, json('POST', { state: 'archived', revision: withTeam.revision }));
  const activePage = (await call('/api/notes')).body;
  assert.ok(!activePage.teamFacets.some(facet => facet.teamId === group.id), '没有笔记的团队不出现');
  assert.ok(activePage.teamFacets.some(facet => facet.teamId === null));
  assert.equal(loose.sourceTeamId, null);
});

test('tag facets only list tags that actually hold notes in the current scope', async t => {
  const { call, json } = await setup(t);
  const used = (await call('/api/note-tags', json('POST', { name: '有用' }))).body.tag;
  const unused = (await call('/api/note-tags', json('POST', { name: '没人用' }))).body.tag;
  const tagged = await create(call, json, { body: '带标签的记录', tags: [used.id] });
  await create(call, json, { body: '无标签记录' });

  const page = (await call('/api/notes?state=all')).body;
  assert.ok(page.tagFacets.some(facet => facet.tagId === used.id && facet.count === 1), '有笔记的标签必须出现');
  assert.ok(!page.tagFacets.some(facet => facet.tagId === unused.id), '没有笔记的标签不出现');

  // 选中该标签后分面仍保留其它候选(排除标签维度本身),用户能切走。
  const filtered = (await call(`/api/notes?state=all&tag=${encodeURIComponent(used.id)}`)).body;
  assert.deepEqual(filtered.notes.map(row => row.id), [tagged.id]);
  assert.ok(filtered.tagFacets.length >= 1, '选中标签后候选仍可枚举');

  // 标签从笔记上摘掉后不再出现在候选里。
  await call(`/api/notes/${tagged.id}`, json('PATCH', { revision: tagged.revision, tags: [] }));
  const after = (await call('/api/notes?state=all')).body;
  assert.ok(!after.tagFacets.some(facet => facet.tagId === used.id), '没有笔记引用后该标签消失');
});
});

describe('productivity', () => {
test('search treats wildcard characters literally, filters groups and dates and links exact records', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'productivity-'));
  const bus = new Bus({
    directory,
    hosts: new Map([
      [
        'fake',
        {
          async run() {
            return 'ok';
          },
        },
      ],
    ]),
  });
  t.after(async () => {
    await bus.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  });
  const a = createTestGroup(bus, {
    name: 'a',
    workspace: directory,
    lead: { name: 'lead', host: 'fake' },
    members: [],
  });
  const b = createTestGroup(bus, {
    name: 'b',
    workspace: directory,
    lead: { name: 'lead', host: 'fake' },
    members: [],
  });
  const message = bus.store.append(
    a.id,
    'user',
    a.lead,
    'send',
    'search 100% literal_value',
  );
  bus.store.append(b.id, 'user', b.lead, 'send', 'search other');
  let rows = searchWorkspace(bus, new URLSearchParams({ q: '100%' }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, message.id);
  assert.ok(rows[0].path.includes(message.id));
  assert.equal(
    searchWorkspace(bus, new URLSearchParams({ q: 'search', group: b.id }))
      .length,
    1,
  );
  assert.equal(
    searchWorkspace(bus, new URLSearchParams({ q: 'literal_' })).length,
    1,
  );
  assert.equal(
    searchWorkspace(
      bus,
      new URLSearchParams({ q: 'search', from: '2099-01-01' }),
    ).length,
    0,
  );
  assert.throws(
    () =>
      searchWorkspace(bus, new URLSearchParams({ q: 'search', from: 'oops' })),
    /日期/,
  );
  assert.deepEqual(searchWorkspace(bus, new URLSearchParams()), []);
  const workbench = homeWorkbench(bus);
  assert.ok(Array.isArray(workbench.running));
  assert.ok(Array.isArray(workbench.pending));
  assert.equal(workbench.summary, null);
});

test('workbench counts only unanswered interactions and retains the last completed summary', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'workbench-'));
  const bus = new Bus({
    directory,
    hosts: new Map([
      [
        'fake',
        {
          async run() {
            return 'ok';
          },
        },
      ],
    ]),
  });
  t.after(async () => {
    await bus.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  });
  const group = createTestGroup(bus, {
    name: 'team',
    workspace: directory,
    lead: { name: 'lead', host: 'fake' },
    members: [],
  });
  const created = new Date().toISOString();
  const lead = bus.members(group.id)[0];
  const conversation = bus.store.conversation('member', lead.id, 'coordination');
  bus.store.run(
    'INSERT INTO turns(id,conversation_id,executor_kind,executor_id,group_id,state,detail,created) VALUES(?,?,?,?,?,?,?,?)',
    'uncertain',
    conversation.id,
    'member',
    lead.id,
    group.id,
    'unknown',
    '核实宿主',
    created,
  );
  bus.store.run(
    'INSERT INTO panel_agents(id,name,host,created,updated) VALUES(?,?,?,?,?)',
    'panel-fixture',
    'Panel',
    'fake',
    created,
    created,
  );
  const agent = bus.panelAgent();
  const append = (id, role, text) =>
    bus.store.run(
      "INSERT INTO panel_messages(id,panel_agent_id,context,role,text,created) VALUES(?,?,'private',?,?,?)",
      id,
      agent.id,
      role,
      text,
      created,
    );
  append('summary-request', 'user', '[主页进展摘要]\n汇总团队');
  append('summary-reply', 'assistant', '已经完成 A');
  append('ordinary-request', 'user', '别的问题');
  append('ordinary-reply', 'assistant', '无关回答');
  append('summary-pending', 'user', '[主页进展摘要]\n再次汇总');
  const endpoint = bus.store.endpoint(group.lead, 'coordination');
  bus.store.run(
    'INSERT INTO outbox(id,conversation_id,payload,error) VALUES(?,?,?,?)',
    'failed-delivery',
    endpoint.id,
    '[]',
    'send error',
  );
  for (const text of ['merged input 1', 'merged input 2']) {
    const message = bus.store.append(
      group.id,
      'user',
      group.lead,
      'send',
      text,
    );
    bus.store.run(
      'INSERT INTO attached VALUES(?,?)',
      message.id,
      'failed-delivery',
    );
  }
  bus.store.run(
    `INSERT INTO interactions(id,group_id,member_id,conversation_id,context,turn_id,call_id,kind,payload,state,created) VALUES(?,?,?,?,'coordination','fixture-turn','fixture-call','choice',?,'pending',?)`,
    'confirmation',
    group.id,
    group.lead,
    endpoint.id,
    JSON.stringify({
      kind: 'choice',
      text: '请确认方案',
      options: ['同意', '拒绝'],
    }),
    created,
  );
  const withInteraction = homeWorkbench(bus);
  assert.equal(withInteraction.pending.length, 1);
  assert.equal(withInteraction.pending[0].id, 'confirmation');
  assert.equal(withInteraction.pending[0].interactionKind, 'choice');
  assert.equal(withInteraction.pending[0].senderName, 'lead');
  assert.equal(new URL(withInteraction.pending[0].path,'http://localhost').searchParams.has('session'),false);
  assert.equal(withInteraction.recent.find((row) => row.id === 'uncertain')?.detail, '核实宿主');
  bus.store.run(
    "UPDATE interactions SET state='answered' WHERE id='confirmation'",
  );
  const view = homeWorkbench(bus);
  assert.deepEqual(view.pending, []);
  assert.equal(view.summary.id, 'summary-reply');
  assert.equal(view.summary.text, '已经完成 A');
  assert.equal(view.summaryRequest.id, 'summary-pending');
  bus.store.run(
    "UPDATE turns SET state='stopped' WHERE id='uncertain'",
  );
  assert.ok(
    !homeWorkbench(bus).pending.some((item) => item.id === 'uncertain'),
  );
});

test('home summary uses the existing Panel Agent execution and survives a later query', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'home-summary-'));
  const host = {
    async run(context) {
      context.onSession('summary-session');
      context.onAccepted();
      return '本轮摘要：已完成验证。';
    },
  };
  const bus = new Bus({ directory, hosts: new Map([['fake', host]]) });
  t.after(async () => {
    await bus.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  });
  const created = new Date().toISOString();
  bus.store.run(
    'INSERT INTO panel_agents(id,name,host,created,updated) VALUES(?,?,?,?,?)',
    'panel-summary',
    'Panel',
    'fake',
    created,
    created,
  );
  const response = await bus.panelPrivateTurn({
    text: '[主页进展摘要]\n请只读总结。',
    clientMessageId: 'summary-test',
  });
  assert.equal(response.reply.role, 'assistant');
  assert.equal(homeWorkbench(bus).summary.text, '本轮摘要：已完成验证。');
  const replay = await bus.panelPrivateTurn({
    text: '[主页进展摘要]\n请只读总结。',
    clientMessageId: 'summary-test',
  });
  assert.equal(replay.result.replayed, true);
  assert.equal(homeWorkbench(bus).summary.id, response.reply.id);
});

test('workbench HTTP stays readable throughout Panel Agent summary generation', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'workbench-running-'));
  let release;
  let started;
  const accepted = new Promise((resolve) => {
    started = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const server = await startServer({
    directory,
    hosts: new Map([
      [
        'fake',
        {
          async run(context) {
            context.onSession('running-summary');
            context.onAccepted();
            context.onTextDelta('摘要第一段');
            started();
            await gate;
            return '摘要完成';
          },
        },
      ],
    ]),
  });
  const bus = server.bus;
  const abort = new AbortController();
  const responseStream = await fetch(`${server.url}api/panel-agent/events`, {
    signal: abort.signal,
  });
  const reader = responseStream.body.getReader();
  const decoder = new TextDecoder();
  let received = '';
  async function readUntil(pattern) {
    while (!pattern.test(received)) {
      const { value, done } = await reader.read();
      if (done) break;
      received += decoder.decode(value, { stream: true });
    }
    assert.match(received, pattern);
  }
  let pending;
  t.after(async () => {
    release();
    await pending?.catch(() => {});
    abort.abort();
    await server.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  });
  const created = new Date().toISOString();
  bus.store.run(
    'INSERT INTO panel_agents(id,name,host,created,updated) VALUES(?,?,?,?,?)',
    'panel-running',
    'Panel',
    'fake',
    created,
    created,
  );
  pending = fetch(`${server.url}api/panel-agent/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: '[主页进展摘要]\n请总结。',
      clientMessageId: 'running-summary',
    }),
  });
  await accepted;
  await readUntil(/"type":"delta".*"delta":"摘要第一段"/);
  assert.match(received, /"homeSummary":true/);
  assert.equal(bus.panelStreaming()[0].text, '摘要第一段');
  const reconnectAbort = new AbortController();
  const reconnect = await fetch(`${server.url}api/panel-agent/events`, {
    signal: reconnectAbort.signal,
  });
  const snapshot = await reconnect.body.getReader().read();
  assert.match(
    decoder.decode(snapshot.value),
    /"type":"snapshot".*"text":"摘要第一段"/,
  );
  reconnectAbort.abort();
  for (let index = 0; index < 3; index++) {
    const response = await fetch(`${server.url}api/workbench`);
    assert.equal(
      response.status,
      200,
      'summary generation must not break workbench polling',
    );
    const view = await response.json();
    assert.equal(view.running.length, 1);
    assert.equal(view.running[0].name, 'Panel');
    assert.equal(view.running[0].path, '/agent');
  }
  release();
  assert.equal((await pending).status, 200);
  await readUntil(/"type":"complete".*"text":"摘要完成"/);
  const settled = await fetch(`${server.url}api/workbench`);
  assert.equal(settled.status, 200);
  assert.equal((await settled.json()).summary.text, '摘要完成');
});

test('dismissing a team notification hides it from the panel list without touching the update log', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'productivity-notify-'));
  const bus = new Bus({ directory, hosts: new Map([['fake', { async run() { return 'ok'; } }]]) });
  t.after(async () => { await bus.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
  const group = createTestGroup(bus, { name: 'notify', workspace: directory, lead: { name: 'lead', host: 'fake' }, members: [] });
  const agentId = seedPanelAgent(bus);
  bus.store.run(
    `INSERT INTO panel_updates(id,panel_agent_id,group_id,text,created) VALUES(?,?,?,?,?)`,
    'update-1', agentId, group.id, '成员已完成本轮任务', new Date().toISOString(),
  );
  assert.ok(bus.panelAgentState().notifications.some(row => row.id === 'update-1'));

  assert.equal(dismissWorkbench(bus, [{ category: 'panel:update', id: 'update-1' }]).dismissed, 1);
  assert.equal(bus.panelAgentState().notifications.some(row => row.id === 'update-1'), false);
  assert.ok(panelAgg.updateById(bus.store, 'update-1'), '投递台账本身保留');
  assert.throws(() => dismissWorkbench(bus, [{ category: 'panel:update', id: 'gone' }]), /已失效/);
});

test('home summary runs in a fresh read-only session using the Panel Agent model without touching private session', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'home-summary-isolated-'));
  const observed = [];
  const host = {
    async run(context) {
      observed.push({
        context: context.endpoint.context,
        session: context.endpoint.session,
        modelSelection: context.modelSelection,
        tools: context.tools.map(tool => tool.name),
        policy: context.policy,
      });
      context.onSession(`ephemeral-${observed.length}`);
      context.onAccepted();
      context.onTextDelta('独立汇总');
      return `独立汇总 #${observed.length}`;
    },
  };
  const server = await startServer({ directory, hosts: new Map([['fake', host]]) });
  const bus = server.bus;
  t.after(async () => {
    await server.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* ignore */ }
  });
  const created = new Date().toISOString();
  bus.store.run(
    'INSERT INTO panel_agents(id,name,host,model_provider,model,reasoning_effort,created,updated) VALUES(?,?,?,?,?,?,?,?)',
    'panel-isolated', 'Panel', 'fake', 'prov-1', 'model-x', 'high', created, created,
  );
  // 模拟私聊会话上挂着一个已失效的旧宿主 session
  const privateSession = bus.store.conversation('panel_agent', 'panel-isolated', 'private');
  bus.store.setConversationSession(privateSession.id, 'stale-private-session');

  const first = await fetch(`${server.url}api/workbench/summary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).summary.text, '独立汇总 #1');

  const second = await fetch(`${server.url}api/workbench/summary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(second.status, 200);
  assert.equal((await second.json()).summary.text, '独立汇总 #2');

  // 两次汇总都复用 Panel Agent 的同模型配置，但每次均新建空宿主会话、仅开放只读工具。
  assert.equal(observed.length, 2);
  for (const call of observed) {
    assert.equal(call.context, 'home-summary');
    assert.equal(call.session, null);
    assert.deepEqual(call.modelSelection, { model_provider: 'prov-1', model: 'model-x', reasoning_effort: 'high' });
    assert.equal(call.policy.allowShell, false);
    assert.ok(call.tools.includes('teams_list'));
    assert.ok(call.tools.includes('team_read'));
    assert.equal(call.tools.includes('team_create'), false);
    assert.equal(call.tools.includes('ask'), false);
  }
  // 私聊消息流未被摘要污染，工作台直接读取最新独立摘要。
  assert.equal(bus.panelAgentState().conversation.length, 0);
  const workbench = await (await fetch(`${server.url}api/workbench`)).json();
  assert.equal(workbench.summary.text, '独立汇总 #2');
});

test('turn executor does not persist a ghost session when a host fails before acceptance and panel reset clears stale bindings', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'turn-ghost-session-'));
  let failBeforeAccept = true;
  const seenSessions = [];
  const host = {
    async run(context) {
      seenSessions.push(context.endpoint.session ?? null);
      if (failBeforeAccept) {
        context.onSession('ghost-session-id');
        throw new Error('init failed before accept');
      }
      context.onSession(`real-session-${seenSessions.length}`);
      context.onAccepted();
      return '正常回复';
    },
  };
  const server = await startServer({ directory, hosts: new Map([['fake', host]]) });
  const bus = server.bus;
  t.after(async () => {
    await server.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* ignore */ }
  });
  const created = new Date().toISOString();
  bus.store.run(
    'INSERT INTO panel_agents(id,name,host,created,updated) VALUES(?,?,?,?,?)',
    'panel-ghost', 'Panel', 'fake', created, created,
  );

  // 第一次：宿主在 onAccepted 之前调了 onSession 但报错 -> 不得落盘幽灵 session。
  await assert.rejects(
    bus.panelPrivateTurn({ text: '第一次尝试', clientMessageId: 'm-1' }),
    /init failed before accept/,
  );
  assert.equal(bus.panelAgentState().sessions.find(s => s.context === 'private')?.session ?? null, null);

  // 第二次：正常入队完成 -> 此时才持久化真实 session。
  failBeforeAccept = false;
  await bus.panelPrivateTurn({ text: '第二次成功', clientMessageId: 'm-2' });
  assert.deepEqual(seenSessions, [null, null]);
  assert.equal(bus.panelAgentState().sessions.find(s => s.context === 'private')?.session, 'real-session-2');

  // 通过 HTTP 重置私聊会话 -> 清空宿主绑定但保留聊天记录，下一条以 null 开启新会话。
  const reset = await fetch(`${server.url}api/panel-agent/reset-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(reset.status, 200);
  assert.equal((await reset.json()).reset, true);
  assert.equal(bus.panelAgentState().sessions.find(s => s.context === 'private')?.session ?? null, null);
  assert.ok(bus.panelAgentState().conversation.length >= 2);

  await bus.panelPrivateTurn({ text: '重置后的第一条', clientMessageId: 'm-3' });
  assert.deepEqual(seenSessions, [null, null, null]);
});

test('workbench and search resolve external principals as external_agent identities', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'productivity-external-'));
  const bus = new Bus({
    directory,
    hosts: new Map([['fake', { async run() { return 'ok'; } }]]),
  });
  t.after(async () => {
    await bus.close();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* 清理失败不影响结论(Windows 句柄/杀软) */ }
  });
  const group = createTestGroup(bus, {
    name: 'external identities',
    workspace: directory,
    lead: { name: 'lead', host: 'fake' },
    members: [],
  });
  const created = new Date().toISOString();
  insertPrincipal(bus.store, { id: 'external-1', name: '外部主控甲', created });

  // 搜索:外部主控发出的消息展示 principal 名称而非裸 id。
  const externalMessage = bus.store.append(group.id, 'external-1', group.lead, 'send', '外部主控下发的调度指令');
  const found = searchWorkspace(bus, new URLSearchParams({ q: '调度指令' }));
  assert.equal(found.length, 1);
  assert.equal(found[0].id, externalMessage.id);
  assert.equal(found[0].senderName, '外部主控甲');

  // 等待用户回复:收件人为外部主控。
  const toExternal = bus.store.append(group.id, 'user', 'external-1', 'send', '请确认外部主控状态');
  // Agent 间请求:外部主控显式声明需要回复。
  const externalRequest = bus.store.append(group.id, 'external-1', group.lead, 'send', '请外部协作方回复', null, true);

  const workbench = homeWorkbench(bus, { now: Date.now() + 10 * 60 * 1000 });
  const waiting = workbench.waiting.find(row => row.id === toExternal.id);
  assert.equal(waiting.recipientName, '外部主控甲');
  assert.equal(waiting.recipientKind, 'external_agent');
  const agentWaiting = workbench.agentWaiting.find(row => row.id === externalRequest.id);
  assert.equal(agentWaiting.senderName, '外部主控甲');
  assert.equal(agentWaiting.senderKind, 'external_agent');
  assert.equal(agentWaiting.recipientName, 'lead');
  assert.equal(agentWaiting.recipientKind, 'member');
});
});
