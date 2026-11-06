import { ref } from 'vue';
import { useUiStore } from '@/stores/ui';

/** 左右栏拖拽/键盘调整宽度 + 持久化；与页面布局解耦，便于单独测试。 */
export function useSidebarResize() {
  const ui = useUiStore();
  const resizing = ref(false);
  let drag:
    | { side: 'left' | 'right'; x: number; width: number }
    | undefined;

  function resizeWidth(side: 'left' | 'right', width: number) {
    const other =
      side === 'left'
        ? ui.contextCollapsed
          ? 60
          : ui.contextWidth
        : ui.sidebarCollapsed
          ? 76
          : ui.sidebarWidth;
    const max = Math.max(
      side === 'left' ? 180 : 280,
      window.innerWidth - other - 420,
    );
    if (side === 'left')
      ui.sidebarWidth = Math.round(Math.max(180, Math.min(400, max, width)));
    else ui.contextWidth = Math.round(Math.max(280, Math.min(680, max, width)));
  }
  function beginResize(event: PointerEvent, side: 'left' | 'right') {
    if (event.button !== 0) return;
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    drag = {
      side,
      x: event.clientX,
      width: side === 'left' ? ui.sidebarWidth : ui.contextWidth,
    };
    resizing.value = true;
    event.preventDefault();
  }
  function moveResize(event: PointerEvent) {
    if (!drag) return;
    resizeWidth(
      drag.side,
      drag.width + (event.clientX - drag.x) * (drag.side === 'left' ? 1 : -1),
    );
  }
  function endResize() {
    if (!drag) return;
    drag = undefined;
    resizing.value = false;
    ui.persist();
  }
  function keyboardResize(event: KeyboardEvent, side: 'left' | 'right') {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    resizeWidth(
      side,
      (side === 'left' ? ui.sidebarWidth : ui.contextWidth) +
        direction * (side === 'left' ? 16 : -16),
    );
    ui.persist();
  }

  return {
    resizing,
    beginResize,
    moveResize,
    endResize,
    keyboardResize,
  };
}
