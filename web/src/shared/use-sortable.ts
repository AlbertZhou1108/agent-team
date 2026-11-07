import { getCurrentScope, nextTick, onScopeDispose, ref, watch, type Ref } from 'vue';
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
  type ElementDragPayload,
} from '@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter';
import { combine } from '@atlaskit/pragmatic-drag-and-drop/utils/combine';
import { dropSide } from '@/shared/drag-order';
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
  handleSelector?: () => string | undefined;
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
  let candidate: { targetId: string; after: boolean } | undefined;

  function heightOf(element: Element): number {
    return element.getBoundingClientRect().height;
  }

  function clearPreview() {
    candidate = undefined;
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

  function updatePreview(source: ElementDragPayload, location: DropLocation) {
    const id = String(source.data.id);
    const height = preview.value?.height ?? 0;
    const target = location.dropTargets[0];
    const data = target?.data;
    const targetId = data?.kind === 'sort-item' && typeof data.id === 'string' ? data.id : undefined;

    if (data?.kind === 'sort-gap') return; // 悬停空位：保留上一候选
    if (!target || !targetId || !options.canTarget(targetId) || targetId === id) {
      candidate = undefined;
      setPreview(sourcePreview(id, height));
      return;
    }
    const side = dropSide(location.input, target.element.getBoundingClientRect(), options.axis());
    candidate = { targetId, after: side === 'after' };
    setPreview({
      index: gapIndexForTarget(options.ids(), [id], targetId, side === 'after'),
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
      setPreview(sourcePreview(id, heightOf(source.element)));
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
      if (candidate) options.onReorder(String(source.data.id), candidate.targetId, candidate.after);
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
    bindings.bind(`sort-item:${id}`, element, el => {
      const handleSelector = options.handleSelector?.();
      return combine(
        draggable({
          element: el,
          canDrag: () => options.canDrag(id),
          dragHandle: handleSelector
            ? (el.querySelector(handleSelector) ?? undefined)
            : undefined,
          getInitialData: () => ({ type: SORT_DRAG_TYPE, id }),
        }),
        dropTargetForElements({
          element: el,
          canDrop: ({ source }) => isSortPayload(source)
            && source.data.id !== id
            && options.canTarget(id),
          getData: () => ({ kind: 'sort-item', id }),
          getDropEffect: () => 'move',
        }),
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
