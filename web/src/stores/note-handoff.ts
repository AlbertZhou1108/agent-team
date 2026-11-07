import { defineStore } from 'pinia';
import { ref } from 'vue';

/**
 * 侧栏 Panel Agent 投放 → 随心记工作区的交接桥。
 * 侧栏只投递所选笔记 id;提示词生成、草稿覆盖确认、跳转全部仍归
 * NotesWorkspace 的 handoff 链路,不在侧栏再造一套交互。拖拽源只有
 * 随心记列表,因此消费方(NotesWorkspace)必然挂载着。
 */
export const useNoteHandoffStore = defineStore('note-handoff', () => {
  const pending = ref<string[] | null>(null);
  // 笔记拖拽进行中:侧栏 Panel Agent 项据此提前亮出「可投放」姿态,
  // 不等用户悬停到它上面才给反馈。
  const dragActive = ref(false);

  function beginDrag() {
    dragActive.value = true;
  }

  function endDrag() {
    dragActive.value = false;
  }

  function request(ids: string[]) {
    if (ids.length) pending.value = ids;
  }

  function consume(): string[] | null {
    const ids = pending.value;
    pending.value = null;
    return ids;
  }

  return { pending, dragActive, beginDrag, endDrag, request, consume };
});
