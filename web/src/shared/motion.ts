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
 * 当前动效节奏系数(简洁=1;柔和=1.35;灵动=0.7),与 CSS 的 --motion-pace 同源。
 * JS 侧动画(WAAPI 等)用它缩放时长,保证与 CSS 动画节奏一致。
 */
export function motionPace(): number {
  if (typeof window === 'undefined' || typeof document === 'undefined') return 1;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(
    '--motion-pace',
  );
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * 契约基准时长(毫秒),与 globals.css 的 --motion-duration-* 一一对应。
 * 语义档位与 CSS 同义:fast 微反馈、normal 状态与进出、slow 大面积结构。
 * JS 不猜第四个数字 —— 需要动画时长就取这里的档位,再乘当前节奏。
 */
const MOTION_BASE_MS = { fast: 150, normal: 220, slow: 320 } as const;

export type MotionTier = keyof typeof MOTION_BASE_MS;

/** 语义时长的实际毫秒数(已乘节奏系数),供 WAAPI 等 JS 动画使用。 */
export function motionDurationMs(tier: MotionTier): number {
  return Math.round(MOTION_BASE_MS[tier] * motionPace());
}

/**
 * JS 侧缓动曲线:WAAPI 不能读 var(),这里镜像 --motion-ease-* 的取值,
 * 与 globals.css 同一组曲线,改契约时两边一起改。
 * 弹性/材质抑制只作用于 CSS 变量,JS 动画按进入曲线处理。
 */
export const MOTION_EASING = {
  out: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
  in: 'cubic-bezier(0.4, 0, 1, 1)',
  standard: 'cubic-bezier(0.2, 0, 0, 1)',
} as const;

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
