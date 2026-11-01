/** 拖拽排序/移动的落点判定:指针落在目标项主轴的前半段(before)还是后半段(after)。 */

export type DropSide = 'before' | 'after';
export type DropAxis = 'x' | 'y';

type Pointer = { clientX: number; clientY: number };
type TargetRect = { left: number; top: number; width: number; height: number };

/**
 * 所有排序/移动场景共用同一判定:纵向列表看 Y,横向排列或网格看 X。
 * 与现有实现保持一致:指针恰好在中点时算 before(严格大于才 after)。
 */
export function dropSide(pointer: Pointer, rect: TargetRect, axis: DropAxis): DropSide {
  const position = axis === 'x' ? pointer.clientX : pointer.clientY;
  const middle = axis === 'x' ? rect.left + rect.width / 2 : rect.top + rect.height / 2;
  return position > middle ? 'after' : 'before';
}
