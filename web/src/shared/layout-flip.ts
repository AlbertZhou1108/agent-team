import { motionDurationMs, MOTION_EASING, prefersReducedMotion } from './motion';

export type FlipRects = Map<string, DOMRect>;

const SELECTOR = '[data-flip-key]';
const ownAnimations = new WeakMap<HTMLElement, Animation>();

/** 在 DOM 更新前捕获所有带 data-flip-key 元素的位置。 */
export function captureFlipRects(root: HTMLElement | null | undefined): FlipRects {
  const rects: FlipRects = new Map();
  if (!root) return rects;
  for (const element of root.querySelectorAll<HTMLElement>(SELECTOR)) {
    const key = element.dataset.flipKey;
    if (key) rects.set(key, element.getBoundingClientRect());
  }
  return rects;
}

/**
 * 在 DOM 更新后播放位移：已有元素从旧位置反演回零，新元素淡入。
 * 只取消本模块上一次给该元素挂的动画，不碰 CSS 动画。
 */
export function playFlip(
  root: HTMLElement | null | undefined,
  before: FlipRects,
  moveScale = 1,
): void {
  if (!root || prefersReducedMotion()) return;
  const duration = motionDurationMs('fast');
  // 各场景按需缩让位时长；默认与出现动画同档，避免“统一调快”波及无关界面。
  const moveDuration = Math.round(duration * moveScale);
  for (const element of root.querySelectorAll<HTMLElement>(SELECTOR)) {
    const key = element.dataset.flipKey;
    if (!key) continue;
    ownAnimations.get(element)?.cancel();
    const previous = before.get(key);
    if (!previous) {
      ownAnimations.set(element, element.animate(
        [{ opacity: 0 }, { opacity: 1 }],
        { duration, easing: MOTION_EASING.out },
      ));
      continue;
    }
    const rect = element.getBoundingClientRect();
    const dx = previous.left - rect.left;
    const dy = previous.top - rect.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    ownAnimations.set(element, element.animate(
      [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
      { duration: moveDuration, easing: MOTION_EASING.standard },
    ));
  }
}
