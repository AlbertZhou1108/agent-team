import { randomUUID } from 'node:crypto';
import { notePrompt, notesPrompt } from './notes-prompt.mjs';

// 随心记：用户的私人想法。它只负责「记」，不理解需求、不跟踪执行。
// 与 Panel Agent 的全部连接就是 notePrompt() 生成的一段文字，因此这里不读会话、不落回合。
// 来源团队（source_team_id）只是「这笔是在哪个团队里记的」这一历史事实：裸 id、无外键、
// 不级联、不构成权限、不进入提示词。团队删了笔记还在，只是来源显示为「团队已删除」。
const STATES = new Set(['active', 'done', 'archived']);
const MAX_BODY = 20000;
const MAX_TITLE = 200;
const MAX_TODOS = 30;
const MAX_TODO_TEXT = 200;
const MAX_TAGS_PER_NOTE = 20;
const MAX_TAG_NAME = 32;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export function deriveTitle(body) {
  const line = body.split('\n').map(text => text.trim()).find(Boolean) ?? '';
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

export function tagView(row) {
  return { id: row.id, name: row.name, color: row.color ?? null, created: row.created };
}

function normalizeTagName(value) {
  if (typeof value !== 'string') throw noteError(400, '标签名必须是文本');
  const name = value.trim();
  if (!name) throw noteError(400, '标签名不能为空');
  if (name.length > MAX_TAG_NAME) throw noteError(400, `标签名不能超过 ${MAX_TAG_NAME} 字`);
  return name;
}

function normalizeTagColor(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) throw noteError(400, '标签颜色无效');
  return value;
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

// 团队筛选：undefined/空=不限，'none'=仅无来源，其它按 id 精确匹配。
function normalizeTeamFilter(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw noteError(400, '团队筛选无效');
  const team = value.trim();
  if (!team) return null;
  if (team.length > 100) throw noteError(400, '团队筛选无效');
  return team;
}

// 标签筛选：undefined/空=不限，其它按标签 id 精确匹配(存在性不校验:标签可删)。
function normalizeTagFilter(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw noteError(400, '标签筛选无效');
  const tag = value.trim();
  if (!tag) return null;
  if (tag.length > 100) throw noteError(400, '标签筛选无效');
  return tag;
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
    tags: JSON.parse(row.tags ?? '[]'),
    pinnedAt: row.pinned_at ?? null,
    due: row.due ?? null,
    state: row.state,
    sourceTeamId: row.source_team_id ?? null,
    sourceTeamName: row.source_team_name ?? null,
    revision: row.revision,
    created: row.created,
    updated: row.updated,
    completed: row.completed ?? null,
    archived: row.archived ?? null,
  };
}

// 列表与详情都带上团队名（LEFT JOIN：团队已删除时为 null，但笔记照旧返回）。
const SELECT_NOTE = `SELECT n.*, g.name AS source_team_name FROM notes n
  LEFT JOIN groups g ON g.id=n.source_team_id`;

export class Notes {
  constructor(bus) {
    this.bus = bus;
  }
  get store() {
    return this.bus.store;
  }
  get(id) {
    const row = this.store.get(`${SELECT_NOTE} WHERE n.id=?`, id);
    if (!row) throw noteError(404, '记录不存在');
    return noteView(row);
  }
  // team 三态：缺省=不限；'none'=仅无来源；其它=该团队 id。
  // 不用空串表示「无来源」——空串在这里已经表示「不筛选」。
  list({ state = null, q = '', cursor = null, limit = undefined, team = null, tag = null } = {}) {
    const scope = [];
    const scopeParams = [];
    const teamFilter = normalizeTeamFilter(team);
    if (teamFilter === 'none') scope.push('n.source_team_id IS NULL');
    else if (teamFilter) {
      scope.push('n.source_team_id=?');
      scopeParams.push(teamFilter);
    }
    const tagFilter = normalizeTagFilter(tag);
    if (tagFilter) {
      // JSON 数组按成员筛选:标签 id 存在即命中(个人量级无需索引)。
      scope.push('EXISTS (SELECT 1 FROM json_each(n.tags) je WHERE je.value = ?)');
      scopeParams.push(tagFilter);
    }
    const keyword = typeof q === 'string' ? q.trim().slice(0, 200) : '';
    if (keyword) {
      const pattern = escapeLike(keyword);
      scope.push("(n.title LIKE ? ESCAPE '\\' OR n.body LIKE ? ESCAPE '\\' OR n.todos LIKE ? ESCAPE '\\')");
      scopeParams.push(pattern, pattern, pattern);
    }
    const filters = [...scope];
    const params = [...scopeParams];
    if (state && state !== 'all') {
      if (!STATES.has(state)) throw noteError(400, '状态无效');
      filters.push('n.state=?');
      params.push(state);
    } else if (!state) {
      filters.push("n.state='active'");
    }
    const after = parseCursor(cursor);
    if (after) {
      filters.push('(n.updated<? OR (n.updated=? AND n.id<?))');
      params.push(after.updated, after.updated, after.id);
    }
    // 置顶笔记不进分页流:它们由响应里的 pinned 数组单独全量返回,
    // 取消置顶后自然回到本页的日期分组。
    filters.push('n.pinned_at IS NULL');
    const size = normalizeLimit(limit);
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const rows = this.store.all(
      `${SELECT_NOTE} ${where} ORDER BY n.updated DESC, n.id DESC LIMIT ?`,
      ...params,
      size + 1,
    );
    const page = rows.slice(0, size);
    const nextCursor = rows.length > size ? `${page.at(-1).updated}|${page.at(-1).id}` : null;
    // 置顶数组与分页流同 scope/state(游标除外),按置顶时间倒序全量返回。
    const pinnedFilters = [...scope];
    const pinnedParams = [...scopeParams];
    if (state && state !== 'all') {
      if (!STATES.has(state)) throw noteError(400, '状态无效');
      pinnedFilters.push('n.state=?');
      pinnedParams.push(state);
    } else if (!state) {
      pinnedFilters.push("n.state='active'");
    }
    const pinnedWhere = pinnedFilters.length ? `WHERE ${pinnedFilters.join(' AND ')} AND n.pinned_at IS NOT NULL` : 'WHERE n.pinned_at IS NOT NULL';
    const pinned = this.store.all(
      `${SELECT_NOTE} ${pinnedWhere} ORDER BY n.pinned_at DESC, n.id DESC`,
      ...pinnedParams,
    ).map(noteView);
    // 计数跟随当前筛选（团队、标签、搜索），只是不按状态过滤：否则页头数字会和列表条数对不上。
    const counts = { active: 0, done: 0, archived: 0 };
    const countWhere = scope.length ? `WHERE ${scope.join(' AND ')}` : '';
    for (const row of this.store.all(`SELECT n.state, COUNT(*) AS total FROM notes n ${countWhere} GROUP BY n.state`, ...scopeParams)) {
      counts[row.state] = row.total;
    }
    // 维度候选只列真有笔记的取值（空团队/无笔记的标签选了就是空列表）。分面必须排除
    // 自己那个维度——否则选中后候选只剩它，用户再也切不走；状态/搜索与另一维度照常生效。
    const buildFacetScope = exclude => {
      const where = [];
      const params = [];
      if (exclude !== 'tag' && tagFilter) {
        where.push('EXISTS (SELECT 1 FROM json_each(n.tags) je WHERE je.value = ?)');
        params.push(tagFilter);
      }
      if (exclude !== 'team') {
        if (teamFilter === 'none') where.push('n.source_team_id IS NULL');
        else if (teamFilter) {
          where.push('n.source_team_id=?');
          params.push(teamFilter);
        }
      }
      if (keyword) {
        const pattern = escapeLike(keyword);
        where.push("(n.title LIKE ? ESCAPE '\\' OR n.body LIKE ? ESCAPE '\\' OR n.todos LIKE ? ESCAPE '\\')");
        params.push(pattern, pattern, pattern);
      }
      // 分面口径与列表一致:置顶也算有笔记(置顶行就在页面顶部)。
      if (state && state !== 'all') {
        where.push('n.state=?');
        params.push(state);
      } else if (!state) {
        where.push("n.state='active'");
      }
      return { where: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
    };
    const teamFacet = buildFacetScope('team');
    const teamFacets = this.store.all(
      `SELECT n.source_team_id AS team_id, COUNT(*) AS total FROM notes n ${teamFacet.where} GROUP BY n.source_team_id`,
      ...teamFacet.params,
    ).map(row => ({ teamId: row.team_id ?? null, count: row.total }));
    const tagFacet = buildFacetScope('tag');
    const tagFacets = this.store.all(
      `SELECT je.value AS tag_id, COUNT(*) AS total FROM notes n, json_each(n.tags) je ${tagFacet.where} GROUP BY je.value`,
      ...tagFacet.params,
    ).map(row => ({ tagId: row.tag_id, count: row.total }));
    return { notes: page.map(noteView), pinned, nextCursor, counts, teamFacets, tagFacets };
  }
  create({ id = null, body, title = undefined, todos = [], due = null, sourceTeamId = null, tags = [] } = {}) {
    const noteId = id === null || id === undefined ? randomUUID() : normalizeId(id);
    const normalizedBody = normalizeBody(body);
    const normalizedTodos = normalizeTodos(todos);
    const normalizedDue = normalizeDue(due);
    const normalizedTitle = title === undefined ? '' : normalizeTitle(title);
    const normalizedSource = this.normalizeSource(sourceTeamId);
    const normalizedTags = this.normalizeTags(tags);
    const existing = this.store.get('SELECT * FROM notes WHERE id=?', noteId);
    if (existing) {
      // 同一 ID 同内容重发视为幂等回放；内容不同则拒绝，避免静默覆盖另一条记录。
      const current = noteView(existing);
      const same = current.body === normalizedBody
        && current.due === normalizedDue
        && current.sourceTeamId === normalizedSource
        && JSON.stringify(current.todos) === JSON.stringify(normalizedTodos)
        && JSON.stringify(current.tags) === JSON.stringify(normalizedTags)
        && (normalizedTitle === '' || current.title === normalizedTitle);
      if (!same) throw noteError(409, '同一记录 ID 已用于不同内容');
      return { note: current, created: false };
    }
    const now = new Date().toISOString();
    const titleValue = normalizedTitle || deriveTitle(normalizedBody);
    this.store.run(
      `INSERT INTO notes(id,title,title_manual,body,todos,due,state,archived_from,revision,created,updated,completed,archived,source_team_id,tags)
       VALUES(?,?,?,?,?,?,'active',NULL,1,?,?,NULL,NULL,?,?)`,
      noteId,
      titleValue,
      normalizedTitle ? 1 : 0,
      normalizedBody,
      JSON.stringify(normalizedTodos),
      normalizedDue,
      now,
      now,
      normalizedSource,
      JSON.stringify(normalizedTags),
    );
    return { note: this.get(noteId), created: true };
  }
  update(id, { revision, body, title, todos, due, sourceTeamId, tags } = {}) {
    const current = this.store.get('SELECT * FROM notes WHERE id=?', id);
    if (!current) throw noteError(404, '记录不存在');
    if (current.state === 'archived') throw noteError(409, '记录已归档，请先恢复再修改');
    this.assertRevision(current, revision);
    const next = {
      body: body === undefined ? current.body : normalizeBody(body),
      todos: todos === undefined ? JSON.parse(current.todos) : normalizeTodos(todos),
      due: due === undefined ? current.due : normalizeDue(due),
      source: sourceTeamId === undefined ? (current.source_team_id ?? null) : this.normalizeSource(sourceTeamId),
      tags: tags === undefined ? JSON.parse(current.tags ?? '[]') : this.normalizeTags(tags),
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
      'UPDATE notes SET title=?,title_manual=?,body=?,todos=?,due=?,source_team_id=?,tags=?,revision=revision+1,updated=? WHERE id=? AND revision=?',
      next.title,
      next.titleManual ? 1 : 0,
      next.body,
      JSON.stringify(next.todos),
      next.due,
      next.source,
      JSON.stringify(next.tags),
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
      if (current.state !== 'archived') return this.get(id);
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
    if (current.state === state) return this.get(id);
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
  // 置顶是展示层诉求,不改变状态机:pinned_at 有值即置顶,取消置 NULL。
  // 幂等:重复置顶/取消不 bump revision,避免与详情草稿的乐观锁互相踩。
  setPin(id, { pinned, revision } = {}) {
    const current = this.store.get('SELECT * FROM notes WHERE id=?', id);
    if (!current) throw noteError(404, '记录不存在');
    this.assertRevision(current, revision);
    if (typeof pinned !== 'boolean') throw noteError(400, '置顶状态无效');
    const now = new Date().toISOString();
    if (pinned === Boolean(current.pinned_at)) return this.get(id);
    this.store.run(
      'UPDATE notes SET pinned_at=?,revision=revision+1,updated=? WHERE id=? AND revision=?',
      pinned ? now : null,
      now,
      id,
      current.revision,
    );
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
  // 批量汇总提示词:多选「发给 Panel Agent」的数据源。列表页按状态过滤,
  // 正常页才有这个动作;这里仍兜底拒绝已归档记录,不让半失效内容混进提示词。
  promptMany(ids, { instruction = '' } = {}) {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 50) throw noteError(400, '需要 1–50 条记录');
    if (ids.some(id => typeof id !== 'string' || !id.trim())) throw noteError(400, '记录 ID 无效');
    if (typeof instruction !== 'string' || instruction.length > 2000) throw noteError(400, '补充要求过长');
    const notes = ids.map(id => this.get(id));
    if (notes.some(note => note.state === 'archived')) throw noteError(409, '包含已归档记录，无法交给 Panel Agent');
    return { text: notesPrompt(notes, { instruction }) };
  }
  // 来源只存 id：新建与修改时校验团队存在（防幽灵 id）。已存在的笔记不因团队后来被删而失效，
  // 因此读路径从不校验，只在写入时确认。
  normalizeSource(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string') throw noteError(400, '来源团队无效');
    const team = value.trim();
    if (!team || team.length > 100) throw noteError(400, '来源团队无效');
    if (!this.store.get('SELECT 1 FROM groups WHERE id=?', team)) throw noteError(400, '来源团队不存在');
    return team;
  }
  // 标签引用与来源团队同款约定:写路径校验注册表存在,读路径从不校验——
  // 标签未来删除时历史笔记不失效,只是内容里留下一个不再出现在列表里的 id。
  normalizeTags(value) {
    if (!Array.isArray(value)) throw noteError(400, '标签必须是列表');
    if (value.length > MAX_TAGS_PER_NOTE) throw noteError(400, `标签不能超过 ${MAX_TAGS_PER_NOTE} 个`);
    const seen = new Set();
    for (const id of value) {
      if (typeof id !== 'string' || !id.trim() || id.length > 100) throw noteError(400, '标签引用无效');
      if (seen.has(id)) throw noteError(400, '标签引用重复');
      seen.add(id);
      if (!this.store.get('SELECT 1 FROM note_tags WHERE id=?', id)) throw noteError(400, '标签不存在');
    }
    return [...seen];
  }
  listTags() {
    return this.store.all('SELECT id,name,color,created FROM note_tags ORDER BY created').map(tagView);
  }
  createTag({ name, color = null } = {}) {
    const tagName = normalizeTagName(name);
    const tagColor = normalizeTagColor(color);
    // 同名幂等返回既有标签:新增面板里重复创建不报错,直接落到已有标签上。
    const existing = this.store.get('SELECT * FROM note_tags WHERE name=?', tagName);
    if (existing) return { tag: tagView(existing), created: false };
    const id = randomUUID();
    this.store.run('INSERT INTO note_tags(id,name,color,created) VALUES(?,?,?,?)', id, tagName, tagColor, new Date().toISOString());
    return { tag: this.getTag(id), created: true };
  }
  getTag(id) {
    const row = this.store.get('SELECT * FROM note_tags WHERE id=?', normalizeId(id));
    if (!row) throw noteError(404, '标签不存在');
    return tagView(row);
  }
  assertRevision(row, revision) {    if (revision === undefined || revision === null) throw noteError(400, '需要记录版本');
    const value = Number(revision);
    if (!Number.isInteger(value)) throw noteError(400, '记录版本无效');
    if (value !== row.revision) throw noteError(409, '记录已被更新，请刷新后重试');
  }
}
