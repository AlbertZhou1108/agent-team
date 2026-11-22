// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import NoteDetail from '@/features/notes/NoteDetail.vue';
import type { Note } from '@/shared/api/raw-types';

const note: Note = {
  id: 'n1', title: '同步方案', titleManual: true, body: '正文', todos: [], tags: [],
  pinnedAt: null, due: null, state: 'active', sourceTeamId: null, sourceTeamName: null,
  revision: 3, created: '2026-11-04T08:00:00.000Z', updated: '2026-11-04T08:00:00.000Z',
  completed: null, archived: null,
};

function mountDetail() {
  return mount(NoteDetail, {
    props: { note, panelReady: true, saving: false, error: '', conflict: false, teams: [], tags: [] },
  });
}

function action(wrapper: ReturnType<typeof mountDetail>, label: string) {
  const button = wrapper.findAll('button').find(item => item.text().trim() === label);
  if (!button) throw new Error(`missing action: ${label}`);
  return button;
}

describe('随心记详情未保存态流转', () => {
  it('存在未保存修改时仍可完成、归档、置顶与交给 Panel Agent', async () => {
    const wrapper = mountDetail();
    await wrapper.get('[aria-label="标题"]').setValue('同步方案（改）');
    expect(wrapper.emitted('draft-change')?.at(-1)?.[0]).toMatchObject({ title: '同步方案（改）' });

    for (const label of ['完成', '置顶', '归档', '交给 Panel Agent']) {
      expect(action(wrapper, label).attributes('disabled')).toBeUndefined();
    }

    await action(wrapper, '完成').trigger('click');
    await action(wrapper, '归档').trigger('click');
    await action(wrapper, '置顶').trigger('click');

    expect(wrapper.emitted('state')).toEqual([['done'], ['archived']]);
    expect(wrapper.emitted('pin')).toEqual([[true]]);
  });

  it('saving 期间保留动作禁用，避免重复提交', async () => {
    const wrapper = mountDetail();
    await wrapper.get('[aria-label="标题"]').setValue('改');

    await wrapper.setProps({ saving: true });

    for (const label of ['完成', '置顶', '归档', '交给 Panel Agent']) {
      expect(action(wrapper, label).attributes('disabled')).toBeDefined();
    }
  });
});
