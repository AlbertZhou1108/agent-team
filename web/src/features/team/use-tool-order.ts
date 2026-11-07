import { computed, type MaybeRefOrGetter, toValue } from 'vue';
import { toast } from 'vue-sonner';
import { usePreferencesStore } from '@/stores/preferences';
import { activeMounts, mountKey } from '@/tools';

/**
 * 右栏「工具」页：每个挂载一个可折叠区块，顺序与显隐都记在工具偏好里。
 * 拖拽落点由共享 useSortable 判定，这里只把新顺序写回偏好；置顶只改置顶层。
 */
export function useToolOrder(groupId: MaybeRefOrGetter<string | undefined>) {
  const preferences = usePreferencesStore();
  const toolsPanelMounts = computed(() =>
    toValue(groupId) ? activeMounts('right-tools', preferences.toolModules) : [],
  );

  function reorder(id: string, targetId: string, after: boolean) {
    if (id === targetId) return;
    const order = toolsPanelMounts.value
      .map(({ tool }) => mountKey(tool.id, 'right-tools'))
      .filter(key => key !== id);
    const index = order.indexOf(targetId);
    if (index < 0) return;
    order.splice(index + (after ? 1 : 0), 0, id);
    preferences.setToolOrder('right-tools', order);
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

  return {
    toolsPanelMounts,
    reorder,
    isPinned,
    togglePin,
    closeTool,
  };
}
