const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** 动效风格。reduced 是减少策略;其余三者是风格,只调节奏,不取消状态反馈。 */
export type MotionStyle = 'reduced' | 'simple' | 'soft' | 'lively';

/** 用户可选的动效偏好;'system' 跟随系统减少偏好(无偏好时为简洁)。 */
export type MotionPreference = 'system' | MotionStyle;

export function isMotionPreference(value: unknown): value is MotionPreference {
  return (
    value === 'system' ||
    value === 'reduced' ||
    value === 'simple' ||
    value === 'soft' ||
    value === 'lively'
  );
}

/** 纯解析:用户明确选择优先,只有 'system' 响应系统减少动态效果偏好。 */
export function resolveMotionStyle(
  preference: MotionPreference,
  systemReduced: boolean,
): MotionStyle {
  if (preference === 'system') return systemReduced ? 'reduced' : 'simple';
  return preference;
}

/** 系统是否要求减少动态效果。 */
export function systemReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia(REDUCED_MOTION_QUERY).matches
  );
}

/**
 * 共享的减少动态效果判断:唯一依据是外观收口写到 `<html data-motion>` 的解析结果,
 * 全局 CSS(html[data-motion='reduced'])与所有 JS 侧动效决策(平滑滚动、高度动画等)
 * 因此始终同源;属性尚未就绪的极端时序回落到系统媒体查询。
 */
export function prefersReducedMotion(): boolean {
  const resolved =
    typeof document !== 'undefined'
      ? document.documentElement.dataset.motion
      : undefined;
  if (resolved) return resolved === 'reduced';
  return systemReducedMotion();
}
