import { computed, ref, type MaybeRefOrGetter, toValue } from 'vue';
import { toast } from 'vue-sonner';
import { usePreferencesStore } from '@/stores/preferences';
import { activeMounts, mountKey } from '@/tools';
import { dropSide, type DropSide } from '@/shared/drag-order';

/**
 * 右栏「工具」页：每个挂载一个可折叠区块，顺序与显隐都记在工具偏好里。
 * 拖拽排序使用与左栏一致的 before/after 落点判定，置顶只改置顶层。
 */
export function useToolOrder(groupId: MaybeRefOrGetter<string | undefined>) {
  const preferences = usePreferencesStore();
  const toolsPanelMounts = computed(() =>
    toValue(groupId) ? activeMounts('right-tools', preferences.toolModules) : [],
  );
  const dragging = ref<string>();
  const insertion = ref<{ id: string; side: DropSide }>();

  function startDrag(id: string, event: DragEvent) {
    dragging.value = id;
    event.dataTransfer?.setData('text/plain', id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }
  function clearDrag() {
    dragging.value = undefined;
    insertion.value = undefined;
  }
  function showInsertion(id: string, event: DragEvent) {
    if (dragging.value !== id) {
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      insertion.value = { id, side: dropSide(event, rect, 'y') };
    }
  }
  function leaveInsertion(event: DragEvent) {
    const element = event.currentTarget as HTMLElement;
    if (!element.contains(event.relatedTarget as Node | null))
      insertion.value = undefined;
  }
  function insertionSide(id: string) {
    return insertion.value?.id === id ? insertion.value.side : undefined;
  }
  function isPinned(toolId: string) {
    return (preferences.toolModules.pinned['right-tools'] ?? []).includes(
      mountKey(toolId, 'right-tools'),
    );
  }
  function togglePin(toolId: string) {
    preferences.setToolPinned(
      'right-tools',
      mountKey(toolId, 'right-tools'),
      !isPinned(toolId),
    );
  }
  /** 关闭只隐藏这一处挂载（不是禁用整个工具），设置里可恢复。 */
  function closeTool(toolId: string, toolName: string) {
    preferences.setMountHidden(toolId, 'right-tools', true);
    toast.success(`已关闭「${toolName}」，可在 设置 → 工具 重新打开`);
  }
  function reorderTools(targetId: string, event: DragEvent) {
    const source = dragging.value;
    clearDrag();
    if (!source || source === targetId) return;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const after = dropSide(event, rect, 'y') === 'after';
    const order = toolsPanelMounts.value
      .map(({ tool }) => mountKey(tool.id, 'right-tools'))
      .filter((key) => key !== source);
    const index = order.indexOf(targetId);
    if (index < 0) return;
    order.splice(index + (after ? 1 : 0), 0, source);
    preferences.setToolOrder('right-tools', order);
  }

  return {
    toolsPanelMounts,
    dragging,
    insertionSide,
    startDrag,
    clearDrag,
    showInsertion,
    leaveInsertion,
    reorderTools,
    isPinned,
    togglePin,
    closeTool,
  };
}
