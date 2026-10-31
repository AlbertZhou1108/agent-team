const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * 共享的减少动态效果判断。
 * 全局 CSS 媒体查询(globals.css)与所有 JS 侧动效决策(平滑滚动、高度动画等)
 * 统一以这里为唯一依据,避免各自 matchMedia 产生不同结果。
 */
export function prefersReducedMotion(): boolean {
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}
