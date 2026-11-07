import { getCurrentScope, nextTick, onScopeDispose, ref, watch, type Ref } from 'vue';
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
  type ElementDragPayload,
} from '@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter';
import { combine } from '@atlaskit/pragmatic-drag-and-drop/utils/combine';
import { captureFlipRects, playFlip } from '@/shared/layout-flip';
import { prefersReducedMotion } from '@/shared/motion';
import { usePddBindings } from '@/shared/use-pdd-bindings';
import {
  gapIndexForSource,
  gapIndexForTarget,
  type SortPreview,
} from './sort-preview';

export const SORT_DRAG_TYPE = 'sortable-item-drags';

export interface SortableOptions {
  root: Ref<HTMLElement | null>;
  ids: () => string[];
  canDrag: (id: string) => boolean;
  canTarget: (id: string) => boolean;
  axis: () => 'x' | 'y';
  /** 可选的拖拽源选择器：命中项内部某一行作为拖拽源（拖拽影像只显示该行），投放目标仍是整项。 */
  dragElementSelector?: () => string | undefined;
  onReorder: (id: string, targetId: string, after: boolean) => void;
}

export interface Sortable {
  bindItem: (id: string, element: Element | null | undefined, previous?: Element | null) => void;
  bindGap: (element: Element | null | undefined, previous?: Element | null) => void;
  draggingIds: Ref<string[]>;
  preview: Ref<SortPreview | undefined>;
  dispose: () => void;
}

type TargetData = Record<string | symbol, unknown>;
type DropLocation = {
  input: { clientX: number; clientY: number };
  dropTargets: Array<{ element: Element; data: TargetData }>;
};

function isSortPayload(source: ElementDragPayload): boolean {
  return source.data.type === SORT_DRAG_TYPE && typeof source.data.id === 'string';
}

export function useSortable(options: SortableOptions): Sortable {
  const bindings = usePddBindings();
  const draggingIds = ref<string[]>([]);
  const preview = ref<SortPreview>();
  const itemElements = new Map<string, HTMLElement>();

  function heightOf(element: Element): number {
    return element.getBoundingClientRect().height;
  }

  function clearPreview() {
    preview.value = undefined;
    draggingIds.value = [];
  }

  /** 逐帧 pointermove 会反复走到这里；索引与高度未变时保持同一个对象，避免列表逐帧重渲染。 */
  function setPreview(next: SortPreview | undefined) {
    const current = preview.value;
    if (current?.index === next?.index && current?.height === next?.height) return;
    preview.value = next;
  }

  function sourcePreview(id: string, height: number): SortPreview {
    return { index: gapIndexForSource(options.ids(), [id]), height };
  }

  type Slot = {
    id: string;
    centerX: number;
    centerY: number;
    left: number;
    right: number;
    top: number;
    bottom: number;
  };

  /** 可投放项按列表顺序排列，附带中心点与矩形。 */
  function slots(): Slot[] {
    const dragged = new Set(draggingIds.value);
    const result: Slot[] = [];
    for (const id of options.ids()) {
      if (dragged.has(id) || !options.canTarget(id)) continue;
      const element = itemElements.get(id);
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      result.push({
        id,
        centerX: rect.left + rect.width / 2,
        centerY: rect.top + rect.height / 2,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
      });
    }
    return result;
  }

  /**
   * 指针落在第几个“槽位”：纵向列表按中心线计数；
   * 网格先按行分组，跨过的行整行计数，指针所在行按卡片中心 X 计数。
   * 空位正好落在指针与相邻卡片中心之间，计数稳定，不会因为空位移动而抖动。
   */
  function slotIndex(input: { clientX: number; clientY: number }, list: Slot[]): number {
    if (options.axis() === 'y') {
      let index = 0;
      for (const slot of list) {
        if (input.clientY > slot.centerY) index += 1;
      }
      return index;
    }

    const rows: Slot[][] = [];
    for (const slot of list) {
      const row = rows.find(items => Math.abs(items[0]!.centerY - slot.centerY) < 2);
      if (row) row.push(slot);
      else rows.push([slot]);
    }

    let index = 0;
    for (const row of rows) {
      row.sort((a, b) => a.centerX - b.centerX);
      if (input.clientY > row[0]!.centerY) {
        index += row.length;
        continue;
      }
      for (const slot of row) {
        if (input.clientX > slot.centerX) index += 1;
      }
      break;
    }
    return index;
  }

  function targetAt(input: { clientX: number; clientY: number }): { id: string; after: boolean } | undefined {
    const list = slots();
    if (!list.length) return undefined;

    // 网格：指针落在某张卡片矩形内时，直接“占用它的位置”——目标卡向源位置让，
    // 不需要再瞄准左半/右半。插入方向由源与目标在列表里的先后决定。
    if (options.axis() === 'x') {
      const draggedId = draggingIds.value[0];
      const inside = list.find(slot =>
        input.clientX >= slot.left
        && input.clientX <= slot.right
        && input.clientY >= slot.top
        && input.clientY <= slot.bottom,
      );
      if (inside && draggedId) {
        const ids = options.ids();
        const sourceIndex = ids.indexOf(draggedId);
        const targetIndex = ids.indexOf(inside.id);
        return { id: inside.id, after: sourceIndex >= 0 && targetIndex >= 0 && sourceIndex < targetIndex };
      }
    }

    const index = Math.min(Math.max(slotIndex(input, list), 0), list.length);
    if (index <= 0) return { id: list[0]!.id, after: false };
    if (index >= list.length) return { id: list[list.length - 1]!.id, after: true };
    return { id: list[index]!.id, after: false };
  }

  function updatePreview(source: ElementDragPayload, location: DropLocation) {
    const id = String(source.data.id);
    const height = preview.value?.height ?? 0;
    const target = targetAt(location.input);
    if (!target) {
      setPreview(sourcePreview(id, height));
      return;
    }
    setPreview({
      index: gapIndexForTarget(options.ids(), [id], target.id, target.after),
      height,
    });
  }

  const stopMonitor = monitorForElements({
    canMonitor: ({ source }) => isSortPayload(source),
    onDragStart: ({ source }) => {
      if (!isSortPayload(source)) return;
      const id = String(source.data.id);
      if (!options.ids().includes(id)) return;
      draggingIds.value = [id];
      setPreview(sourcePreview(id, heightOf(itemElements.get(id) ?? source.element)));
    },
    onDrag: ({ source, location }) => {
      if (isSortPayload(source)) updatePreview(source, location.current);
    },
    onDropTargetChange: ({ source, location }) => {
      if (isSortPayload(source)) updatePreview(source, location.current);
    },
    onDrop: ({ source, location }) => {
      if (!isSortPayload(source) || location.current.dropTargets.length === 0) {
        clearPreview();
        return;
      }
      // 以松手瞬间的指针位置为准，避免最后一次让位后的旧候选。
      const target = targetAt(location.current.input);
      if (target) options.onReorder(String(source.data.id), target.id, target.after);
      clearPreview();
    },
  });

  let flipToken = 0;
  let lastKey = '';
  watch(
    preview,
    async () => {
      const value = preview.value;
      const key = value ? `${value.index}:${value.height}` : '';
      if (key === lastKey) return;
      lastKey = key;
      if (prefersReducedMotion()) return;
      const token = ++flipToken;
      const before = captureFlipRects(options.root.value);
      await nextTick();
      if (token !== flipToken) return;
      playFlip(options.root.value, before);
    },
    { flush: 'pre' },
  );

  const bindItem: Sortable['bindItem'] = (id, element, previous) => {
    if (element instanceof HTMLElement) itemElements.set(id, element);
    else itemElements.delete(id);
    bindings.bind(`sort-item:${id}`, element, el => {
      const selector = options.dragElementSelector?.();
      const dragElement = selector
        ? el.querySelector<HTMLElement>(selector)
        : el;
      const dropTarget = dropTargetForElements({
        element: el,
        canDrop: ({ source }) => isSortPayload(source)
          && source.data.id !== id
          && options.canTarget(id),
        getData: () => ({ kind: 'sort-item', id }),
        getDropEffect: () => 'move',
      });
      if (!dragElement) return dropTarget;
      return combine(
        draggable({
          element: dragElement,
          canDrag: () => options.canDrag(id),
          getInitialData: () => ({ type: SORT_DRAG_TYPE, id }),
        }),
        dropTarget,
      );
    }, previous);
  };

  const bindGap: Sortable['bindGap'] = (element, previous) => {
    bindings.bind('sort-gap', element, el => dropTargetForElements({
      element: el,
      canDrop: ({ source }) => isSortPayload(source),
      getData: () => ({ kind: 'sort-gap' }),
      getDropEffect: () => 'move',
    }), previous);
  };

  function dispose() {
    stopMonitor();
    bindings.dispose();
    clearPreview();
  }

  if (getCurrentScope()) onScopeDispose(dispose);

  return { bindItem, bindGap, draggingIds, preview, dispose };
}
