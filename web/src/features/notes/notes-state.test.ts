import { describe, expect, it } from 'vitest';
import type { Note } from '@/shared/api/raw-types';
import {
  draftFrom,
  groupNotesByDay,
  isDirty,
  noteBatchActions,
  noteDayLabel,
  noteExcerpt,
  noteSourceLabel,
  noteStateLabel,
  selectRange,
  toggleSelection,
  toggleTodo,
} from './notes-state';

function note(overrides: Partial<Note> = {}): Note {
  return {
    id: 'n1',
    title: '把同步方案写清楚',
    titleManual: false,
    body: '把同步方案写清楚\n现在最后写入者赢，产品不希望丢数据。',
    todos: [{ text: '确认冲突合并策略', done: false }],
    tags: [],
    pinnedAt: null,
    due: null,
    state: 'active',
    sourceTeamId: null,
    sourceTeamName: null,
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

  it('来源徽标区分「无来源」与「团队已删除」', () => {
    expect(noteSourceLabel(note())).toBeNull();
    expect(noteSourceLabel(note({ sourceTeamId: 'g1', sourceTeamName: '同步方案' }))).toBe('同步方案');
    // 有来源 id 但取不到名字：团队被删了，不等于没有来源。
    expect(noteSourceLabel(note({ sourceTeamId: 'g1', sourceTeamName: null }))).toBe('团队已删除');
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

  it('改来源团队也算未保存', () => {
    const current = note({ sourceTeamId: 'g1', sourceTeamName: '同步方案' });
    const draft = draftFrom(current);
    expect(isDirty(current, draft)).toBe(false);
    draft.sourceTeamId = 'g2';
    expect(isDirty(current, draft)).toBe(true);
  });

  it('勾选待办只翻转目标项', () => {
    const todos = [{ text: 'a', done: false }, { text: 'b', done: false }];
    expect(toggleTodo(todos, 1)).toEqual([{ text: 'a', done: false }, { text: 'b', done: true }]);
    expect(todos[1]!.done).toBe(false);
  });
});

describe('多选与批量动作', () => {
  const visibleIds = ['a', 'b', 'c', 'd', 'e'];

  it('shift 区间选择与现有选中集取并集,锚点缺省用当前行', () => {
    expect(selectRange([], visibleIds, undefined, 'c')).toEqual({ selected: ['c'], anchor: 'c' });
    expect(selectRange(['a'], visibleIds, 'a', 'c')).toEqual({ selected: ['a', 'b', 'c'], anchor: 'a' });
    // 跨已有选区的第二次 shift:并集去重,不丢先选的行。
    expect(selectRange(['a', 'b', 'c'], visibleIds, 'c', 'e')).toEqual({
      selected: ['a', 'b', 'c', 'd', 'e'],
      anchor: 'c',
    });
    // 行不在可见序里(筛选后)退化为单选。
    expect(selectRange(['a'], ['x', 'y'], 'a', 'x')).toEqual({ selected: ['a', 'x'], anchor: 'a' });
  });

  it('cmd/ctrl 间断选择:切换目标行且不影响其他行', () => {
    expect(toggleSelection(['a', 'b'], 'b')).toEqual(['a']);
    expect(toggleSelection(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleSelection([], 'a')).toEqual(['a']);
  });

  it('各状态页的投放区动作与语义色', () => {
    // 「发给 Panel Agent」走侧栏投放,不在工具栏动作区里。
    expect(noteBatchActions('active').map(action => action.key)).toEqual(['done', 'archived']);
    expect(noteBatchActions('done').map(action => action.key)).toEqual(['active']);
    expect(noteBatchActions('archived').map(action => action.key)).toEqual(['restore', 'remove']);
    expect(noteBatchActions('active').map(action => action.tone)).toEqual(['success', 'warning']);
    expect(noteBatchActions('archived').find(action => action.key === 'remove')?.tone).toBe('destructive');
  });
});
