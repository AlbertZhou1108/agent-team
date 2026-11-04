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
  due: string | null;
  revision: number;
}

export function draftFrom(note: Note): NoteDraft {
  return {
    title: note.title,
    body: note.body,
    todos: note.todos.map(todo => ({ ...todo })),
    due: note.due,
    revision: note.revision,
  };
}

export function isDirty(note: Note | null, draft: NoteDraft | null): boolean {
  if (!note || !draft) return false;
  return draft.title !== note.title
    || draft.body !== note.body
    || draft.due !== note.due
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
