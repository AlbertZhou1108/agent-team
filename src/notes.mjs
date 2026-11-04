import { randomUUID } from 'node:crypto';
import { notePrompt } from './notes-prompt.mjs';

// 随心记：用户的私人想法。它只负责「记」，不理解需求、不跟踪执行。
// 与 Panel Agent 的全部连接就是 notePrompt() 生成的一段文字，因此这里不读会话、不落回合。
const STATES = new Set(['active', 'done', 'archived']);
const MAX_BODY = 20000;
const MAX_TITLE = 200;
const MAX_TODOS = 30;
const MAX_TODO_TEXT = 200;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export function deriveTitle(body) {
  const line = body.split('\n').map(text => text.trim()).find(Boolean) ?? '';
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

function noteError(status, message) {
  return Object.assign(new Error(message), { status });
}

function normalizeId(id) {
  if (typeof id !== 'string' || !id.trim() || id.length > 100) throw noteError(400, '记录 ID 无效');
  return id.trim();
}

function normalizeBody(value) {
  if (typeof value !== 'string') throw noteError(400, '正文必须是文本');
  const body = value.replace(/\r\n/g, '\n').trim();
  if (!body) throw noteError(400, '正文不能为空');
  if (body.length > MAX_BODY) throw noteError(400, `正文不能超过 ${MAX_BODY} 字`);
  return body;
}

function normalizeTitle(value) {
  if (typeof value !== 'string') throw noteError(400, '标题必须是文本');
  const title = value.trim();
  if (title.length > MAX_TITLE) throw noteError(400, `标题不能超过 ${MAX_TITLE} 字`);
  return title;
}

function normalizeTodos(value) {
  if (!Array.isArray(value)) throw noteError(400, '待办必须是列表');
  if (value.length > MAX_TODOS) throw noteError(400, `待办不能超过 ${MAX_TODOS} 条`);
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw noteError(400, '待办条目无效');
    if (Object.keys(item).some(key => !['text', 'done'].includes(key))) throw noteError(400, '待办条目包含未知字段');
    const text = typeof item.text === 'string' ? item.text.trim() : '';
    if (!text) throw noteError(400, '待办内容不能为空');
    if (text.length > MAX_TODO_TEXT) throw noteError(400, `待办内容不能超过 ${MAX_TODO_TEXT} 字`);
    if (item.done !== undefined && typeof item.done !== 'boolean') throw noteError(400, '待办完成状态无效');
    return { text, done: item.done === true };
  });
}

function normalizeDue(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw noteError(400, '截止日期格式应为 YYYY-MM-DD');
  }
  return value;
}

function normalizeLimit(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_LIMIT;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw noteError(400, '每页数量无效');
  return limit;
}

function parseCursor(value) {
  if (!value) return null;
  const index = String(value).lastIndexOf('|');
  if (index <= 0) throw noteError(400, '游标无效');
  const updated = String(value).slice(0, index);
  const id = String(value).slice(index + 1);
  if (!updated || !id || Number.isNaN(Date.parse(updated))) throw noteError(400, '游标无效');
  return { updated, id };
}

function escapeLike(text) {
  return `%${text.replace(/[\\%_]/g, '\\$&')}%`;
}

export function noteView(row) {
  return {
    id: row.id,
    title: row.title,
    titleManual: row.title_manual === 1,
    body: row.body,
    todos: JSON.parse(row.todos),
    due: row.due ?? null,
    state: row.state,
    revision: row.revision,
    created: row.created,
    updated: row.updated,
    completed: row.completed ?? null,
    archived: row.archived ?? null,
  };
}

export class Notes {
  constructor(bus) {
    this.bus = bus;
  }
  get store() {
    return this.bus.store;
  }
  get(id) {
    const row = this.store.get('SELECT * FROM notes WHERE id=?', id);
    if (!row) throw noteError(404, '记录不存在');
    return noteView(row);
  }
  list({ state = null, q = '', cursor = null, limit = undefined } = {}) {
    const filters = [];
    const params = [];
    if (state && state !== 'all') {
      if (!STATES.has(state)) throw noteError(400, '状态无效');
      filters.push('state=?');
      params.push(state);
    } else if (!state) {
      filters.push("state='active'");
    }
    const keyword = typeof q === 'string' ? q.trim().slice(0, 200) : '';
    if (keyword) {
      const pattern = escapeLike(keyword);
      filters.push("(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' OR todos LIKE ? ESCAPE '\\')");
      params.push(pattern, pattern, pattern);
    }
    const after = parseCursor(cursor);
    if (after) {
      filters.push('(updated<? OR (updated=? AND id<?))');
      params.push(after.updated, after.updated, after.id);
    }
    const size = normalizeLimit(limit);
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const rows = this.store.all(
      `SELECT * FROM notes ${where} ORDER BY updated DESC, id DESC LIMIT ?`,
      ...params,
      size + 1,
    );
    const page = rows.slice(0, size);
    const nextCursor = rows.length > size ? `${page.at(-1).updated}|${page.at(-1).id}` : null;
    const counts = { active: 0, done: 0, archived: 0 };
    for (const row of this.store.all('SELECT state,COUNT(*) AS total FROM notes GROUP BY state')) {
      counts[row.state] = row.total;
    }
    return { notes: page.map(noteView), nextCursor, counts };
  }
  create({ id = null, body, title = undefined, todos = [], due = null } = {}) {
    const noteId = id === null || id === undefined ? randomUUID() : normalizeId(id);
    const normalizedBody = normalizeBody(body);
    const normalizedTodos = normalizeTodos(todos);
    const normalizedDue = normalizeDue(due);
    const normalizedTitle = title === undefined ? '' : normalizeTitle(title);
    const existing = this.store.get('SELECT * FROM notes WHERE id=?', noteId);
    if (existing) {
      // 同一 ID 同内容重发视为幂等回放；内容不同则拒绝，避免静默覆盖另一条记录。
      const current = noteView(existing);
      const same = current.body === normalizedBody
        && current.due === normalizedDue
        && JSON.stringify(current.todos) === JSON.stringify(normalizedTodos)
        && (normalizedTitle === '' || current.title === normalizedTitle);
      if (!same) throw noteError(409, '同一记录 ID 已用于不同内容');
      return { note: current, created: false };
    }
    const now = new Date().toISOString();
    const titleValue = normalizedTitle || deriveTitle(normalizedBody);
    this.store.run(
      `INSERT INTO notes(id,title,title_manual,body,todos,due,state,archived_from,revision,created,updated,completed,archived)
       VALUES(?,?,?,?,?,?,'active',NULL,1,?,?,NULL,NULL)`,
      noteId,
      titleValue,
      normalizedTitle ? 1 : 0,
      normalizedBody,
      JSON.stringify(normalizedTodos),
      normalizedDue,
      now,
      now,
    );
    return { note: this.get(noteId), created: true };
  }
  update(id, { revision, body, title, todos, due } = {}) {
    const current = this.store.get('SELECT * FROM notes WHERE id=?', id);
    if (!current) throw noteError(404, '记录不存在');
    if (current.state === 'archived') throw noteError(409, '记录已归档，请先恢复再修改');
    this.assertRevision(current, revision);
    const next = {
      body: body === undefined ? current.body : normalizeBody(body),
      todos: todos === undefined ? JSON.parse(current.todos) : normalizeTodos(todos),
      due: due === undefined ? current.due : normalizeDue(due),
      title: current.title,
      titleManual: current.title_manual === 1,
    };
    if (title !== undefined) {
      const value = normalizeTitle(title);
      next.titleManual = Boolean(value);
      next.title = value || deriveTitle(next.body);
    } else if (body !== undefined && !next.titleManual) {
      // 标题跟随正文首行，除非用户手改过；手改后清空则重新跟随。
      next.title = deriveTitle(next.body);
    }
    const now = new Date().toISOString();
    this.store.run(
      'UPDATE notes SET title=?,title_manual=?,body=?,todos=?,due=?,revision=revision+1,updated=? WHERE id=? AND revision=?',
      next.title,
      next.titleManual ? 1 : 0,
      next.body,
      JSON.stringify(next.todos),
      next.due,
      now,
      id,
      current.revision,
    );
    return this.get(id);
  }
  setState(id, { state, revision } = {}) {
    const current = this.store.get('SELECT * FROM notes WHERE id=?', id);
    if (!current) throw noteError(404, '记录不存在');
    this.assertRevision(current, revision);
    if (state !== 'restore' && !STATES.has(state)) throw noteError(400, '状态无效');
    const now = new Date().toISOString();
    if (state === 'restore') {
      if (current.state !== 'archived') return noteView(current);
      const target = current.archived_from ?? 'active';
      this.store.run(
        'UPDATE notes SET state=?,archived=NULL,archived_from=NULL,revision=revision+1,updated=? WHERE id=? AND revision=?',
        target,
        now,
        id,
        current.revision,
      );
      return this.get(id);
    }
    if (current.state === state) return noteView(current);
    if (state === 'archived') {
      this.store.run(
        "UPDATE notes SET state='archived',archived_from=?,archived=?,revision=revision+1,updated=? WHERE id=? AND revision=?",
        current.state,
        now,
        now,
        id,
        current.revision,
      );
    } else {
      this.store.run(
        'UPDATE notes SET state=?,archived=NULL,archived_from=NULL,completed=?,revision=revision+1,updated=? WHERE id=? AND revision=?',
        state,
        state === 'done' ? now : null,
        now,
        id,
        current.revision,
      );
    }
    return this.get(id);
  }
  remove(id) {
    const current = this.store.get('SELECT * FROM notes WHERE id=?', id);
    if (!current) throw noteError(404, '记录不存在');
    // 与团队一致：删除不可恢复，因此只允许已归档记录删除。
    if (current.state !== 'archived') throw noteError(409, '请先归档，再永久删除');
    this.store.run('DELETE FROM notes WHERE id=?', id);
    return { deleted: id };
  }
  prompt(id, { instruction = '' } = {}) {
    const note = this.get(id);
    if (typeof instruction !== 'string' || instruction.length > 2000) throw noteError(400, '补充要求过长');
    return { text: notePrompt(note, { instruction }) };
  }
  assertRevision(row, revision) {
    if (revision === undefined || revision === null) throw noteError(400, '需要记录版本');
    const value = Number(revision);
    if (!Number.isInteger(value)) throw noteError(400, '记录版本无效');
    if (value !== row.revision) throw noteError(409, '记录已被更新，请刷新后重试');
  }
}
