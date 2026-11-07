import type { Note, NoteState, NoteTodo } from '@/shared/api/raw-types';

// 随心记的纯展示逻辑。状态只有三态，执行过程完全不在这里——
// 那些发生在 Panel Agent 的会话里，笔记页不感知。
export const NOTE_STATES: NoteState[] = ['active', 'done', 'archived'];

export function noteStateLabel(state: NoteState): string {
  return { active: '正常', done: '已完成', archived: '已归档' }[state];
}

export function noteStateDescription(state: NoteState): string {
  return {
    active: '还没做，或者还在想',
    done: '已经做完，留着回顾',
    archived: '已收起，可随时恢复',
  }[state];
}

/** 团队筛选的两个特殊值：全部（不筛选）与无来源。其余值都是团队 id。 */
export const TEAM_FILTER_ALL = 'all';
export const TEAM_FILTER_NONE = 'none';
/** 标签筛选的「不筛选」哨兵值(级联维度选「标签」但未选具体标签)。 */
export const TAG_FILTER_ALL = 'all';

/**
 * 来源徽标文案：有来源但取不到团队名，说明团队已经被删了。
 * 这不等于「没有来源」——这笔确实是在某个团队里记的，只是名字不在了。
 */
export function noteSourceLabel(note: Pick<Note, 'sourceTeamId' | 'sourceTeamName'>): string | null {
  if (!note.sourceTeamId) return null;
  return note.sourceTeamName ?? '团队已删除';
}

/** 列表摘要：跳过作为标题的首行，压缩空行后截断。 */
export function noteExcerpt(note: Note, limit = 80): string {
  const lines = note.body.split('\n').map(line => line.trim()).filter(Boolean);
  const rest = lines.length > 1 ? lines.slice(1).join(' ') : lines.join(' ');
  const text = rest || note.body.trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export function formatNoteTime(iso: string): string {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function noteDayLabel(iso: string, now = new Date()): string {
  const today = startOfDay(now);
  const day = startOfDay(new Date(iso));
  const diff = Math.round((today - day) / 86400000);
  if (diff <= 0) return '今天';
  if (diff === 1) return '昨天';
  if (diff < 7) return '更早';
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(new Date(iso));
}

export interface NoteDayGroup {
  key: string;
  label: string;
  notes: Note[];
}

/** 按更新时间的日期分组，保持服务端顺序（updated DESC）。 */
export function groupNotesByDay(notes: Note[], now = new Date()): NoteDayGroup[] {
  const groups: NoteDayGroup[] = [];
  for (const note of notes) {
    const key = new Date(note.updated).toDateString();
    const last = groups.at(-1);
    if (last && last.key === key) last.notes.push(note);
    else groups.push({ key, label: noteDayLabel(note.updated, now), notes: [note] });
  }
  return groups;
}

export interface NoteDraft {
  title: string;
  body: string;
  todos: NoteTodo[];
  tags: string[];
  due: string | null;
  sourceTeamId: string | null;
  revision: number;
}

export function draftFrom(note: Note): NoteDraft {
  return {
    title: note.title,
    body: note.body,
    todos: note.todos.map(todo => ({ ...todo })),
    tags: [...note.tags],
    due: note.due,
    sourceTeamId: note.sourceTeamId,
    revision: note.revision,
  };
}

export function isDirty(note: Note | null, draft: NoteDraft | null): boolean {
  if (!note || !draft) return false;
  return draft.title !== note.title
    || draft.body !== note.body
    || draft.due !== note.due
    || draft.sourceTeamId !== note.sourceTeamId
    || JSON.stringify(draft.tags) !== JSON.stringify(note.tags)
    || JSON.stringify(draft.todos) !== JSON.stringify(note.todos);
}

export function toggleTodo(todos: NoteTodo[], index: number): NoteTodo[] {
  return todos.map((todo, current) => (current === index ? { ...todo, done: !todo.done } : todo));
}

export function addTodo(todos: NoteTodo[], text: string): NoteTodo[] {
  const value = text.trim();
  if (!value) return todos;
  return [...todos, { text: value, done: false }];
}

export { selectRange, toggleSelection } from '@/shared/selection';

export type NoteBatchAction = 'handoff' | 'done' | 'archived' | 'active' | 'restore' | 'remove';

export interface NoteBatchActionSpec {
  key: NoteBatchAction;
  label: string;
  /** 投放区虚线与文字共用的语义色(消费主题 token,不写十六进制)。 */
  tone: 'primary' | 'success' | 'warning' | 'info' | 'destructive';
}

/** 各状态页的批量投放区动作;状态机与单条操作一致,这里只决定「放什么区」。
 *  「发给 Panel Agent」不在列:它走侧栏 Panel Agent 项的投放(目的地隐喻),不属于工具栏动作区。 */
export function noteBatchActions(state: NoteState): NoteBatchActionSpec[] {
  if (state === 'active') {
    return [
      { key: 'done', label: '完成', tone: 'success' },
      { key: 'archived', label: '归档', tone: 'warning' },
    ];
  }
  if (state === 'done') return [{ key: 'active', label: '取消完成', tone: 'info' }];
  return [
    { key: 'restore', label: '恢复', tone: 'primary' },
    { key: 'remove', label: '删除', tone: 'destructive' },
  ];
}
