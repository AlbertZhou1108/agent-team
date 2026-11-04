import { describe, expect, it } from 'vitest';
import type { Note } from '@/shared/api/raw-types';
import {
  draftFrom,
  groupNotesByDay,
  isDirty,
  noteDayLabel,
  noteExcerpt,
  noteStateLabel,
  toggleTodo,
} from './notes-state';

function note(overrides: Partial<Note> = {}): Note {
  return {
    id: 'n1',
    title: '把同步方案写清楚',
    titleManual: false,
    body: '把同步方案写清楚\n现在最后写入者赢，产品不希望丢数据。',
    todos: [{ text: '确认冲突合并策略', done: false }],
    due: null,
    state: 'active',
    revision: 1,
    created: '2026-11-04T08:00:00.000Z',
    updated: '2026-11-04T08:00:00.000Z',
    completed: null,
    archived: null,
    ...overrides,
  };
}

describe('随心记列表展示', () => {
  it('摘要跳过作为标题的首行，并截断过长正文', () => {
    expect(noteExcerpt(note())).toBe('现在最后写入者赢，产品不希望丢数据。');
    expect(noteExcerpt(note({ body: '标题\n' + '长'.repeat(120) }))).toHaveLength(81);
  });

  it('三态文案固定', () => {
    expect(noteStateLabel('active')).toBe('正常');
    expect(noteStateLabel('done')).toBe('已完成');
    expect(noteStateLabel('archived')).toBe('已归档');
  });

  it('按更新日期分组，保持服务端顺序', () => {
    const now = new Date('2026-11-04T12:00:00.000Z');
    const groups = groupNotesByDay([
      note({ id: 'today', updated: '2026-11-04T09:00:00.000Z' }),
      note({ id: 'alsoToday', updated: '2026-11-04T07:00:00.000Z' }),
      note({ id: 'yesterday', updated: '2026-11-03T09:00:00.000Z' }),
    ], now);
    expect(groups.map(group => group.label)).toEqual(['今天', '昨天']);
    expect(groups[0].notes.map(row => row.id)).toEqual(['today', 'alsoToday']);
  });

  it('一周以前显示日期', () => {
    const label = noteDayLabel('2026-10-20T09:00:00.000Z', new Date('2026-11-04T12:00:00.000Z'));
    expect(label).not.toMatch(/今天|昨天|更早/);
    expect(label).toMatch(/\d/);
  });
});

describe('详情草稿', () => {
  it('改动正文或待办都算未保存', () => {
    const current = note();
    const draft = draftFrom(current);
    expect(isDirty(current, draft)).toBe(false);
    draft.body = '改了正文';
    expect(isDirty(current, draft)).toBe(true);
    const todoDraft = draftFrom(current);
    todoDraft.todos[0]!.done = true;
    expect(isDirty(current, todoDraft)).toBe(true);
  });

  it('勾选待办只翻转目标项', () => {
    const todos = [{ text: 'a', done: false }, { text: 'b', done: false }];
    expect(toggleTodo(todos, 1)).toEqual([{ text: 'a', done: false }, { text: 'b', done: true }]);
    expect(todos[1]!.done).toBe(false);
  });
});
