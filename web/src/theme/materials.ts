import type { ComponentMaterialTokens } from './component-contract';
import { freezeConfiguration } from './configuration-data';

/**
 * 材质大类规格表:设计逻辑框架"材质 × 角色"矩阵的可执行形式。
 * 用户只选择大类;每个角色的基材/工艺/参数在此内化,由 applyMaterial
 * 写成 --surface-{role}-* CSS 变量供表面消费。新增大类 = 新增一行数据。
 */

/** 角色注册表:清单 + 每个角色的可供性需求(它向用户暗示什么交互)。 */
export const SURFACE_ROLE_REGISTRY = {
  'nav-panel': { affordance: '定位与导航(弱交互暗示)' },
  'context-panel': { affordance: '承载内容(中性)' },
  action: { affordance: '强可按/可输入暗示' },
  input: { affordance: '可输入、聚焦清晰' },
  reading: { affordance: '安静可读(零交互暗示)' },
  overlay: { affordance: '遮挡聚焦,边界明确' },
  media: { affordance: '内容承载,与主题无关' },
} as const;

export type SurfaceRole = keyof typeof SURFACE_ROLE_REGISTRY;

export const SURFACE_ROLES = Object.keys(SURFACE_ROLE_REGISTRY) as SurfaceRole[];

/** 单个角色的表面渲染:背景 + 可选的模糊/饱和处理(缺省 = 主题基线,实色)。 */
export interface SurfaceFinish {
  bg?: string;
  image?: string;
  blur?: string;
  refraction?: { strength: number; edge: number; blur: number };
}

/** 材质的运动签名:材质对动效词汇的物理约束与专属动效。 */
export interface MaterialMotion {
  /** 该材质是否允许弹性曲线(纸/水泥等物理上不成立 → suppress) */
  spring: 'allow' | 'suppress';
  /** 材质专属动效签名标识,供签名类动画消费(如玻璃的高光流动) */
  signature: 'none' | 'liquid-flow';
}

export interface MaterialCategory {
  id: string;
  label: string;
  roles: Partial<Record<SurfaceRole, SurfaceFinish>>;
  motion: MaterialMotion;
  components?: ComponentMaterialTokens;
  effect?: 'glass';
}

/** 默认实色:所有角色走主题基线,不写任何表面变量。 */
const SOLID: MaterialCategory = {
  id: 'solid',
  label: '默认实色',
  roles: {},
  motion: { spring: 'allow', signature: 'none' },
};

/**
 * 液态玻璃的 Web 近似:导航/上下文统一厚度,操作面更轻,浮层提高遮蔽。
 * 阅读与输入仍走组件基线,避免玻璃叠玻璃;静止时不播放装饰动画。
 * 曲面轮光与环境色由全局材质规则补充,不改变任何布局几何。
 */
const GLASS: MaterialCategory = {
  id: 'glass',
  label: '玻璃',
  effect: 'glass',
  components: {
    '--component-selection-bg': 'light-dark(color-mix(in oklch, var(--card) 90%, transparent), color-mix(in oklch, var(--foreground) 10%, transparent))',
    '--component-selection-fg': 'var(--foreground)',
    '--component-selection-shadow': 'inset 0 1px 0 light-dark(rgb(255 255 255 / 60%), rgb(255 255 255 / 12%)), 0 2px 6px rgb(0 0 0 / 7%)',
    '--component-tab-active-bg': 'var(--component-selection-bg)',
    '--component-tab-active-border': 'transparent',
    '--component-tab-active-shadow': 'var(--component-selection-shadow)',
    '--component-choice-track-bg': 'color-mix(in oklch, var(--foreground) 6%, transparent)',
    '--component-choice-bg': 'transparent',
    '--component-choice-shadow': 'none',
    '--component-choice-hover-bg': 'color-mix(in oklch, var(--foreground) 6%, transparent)',
    '--component-choice-selected-bg': 'var(--component-selection-bg)',
    '--component-choice-selected-fg': 'var(--component-selection-fg)',
    '--component-choice-border': 'transparent',
    '--component-choice-selected-border': 'transparent',
    '--component-choice-selected-shadow': 'var(--component-selection-shadow)',
    '--component-nav-current-bg': 'var(--component-selection-bg)',
    '--component-nav-selected-bg': 'var(--component-selection-bg)',
    '--component-nav-state-shadow': 'var(--component-selection-shadow)',
    '--component-content-bg': 'color-mix(in oklch, var(--card) 92%, transparent)',
    '--component-environment-image': 'radial-gradient(ellipse at 0% 0%, color-mix(in oklch, var(--info) 22%, transparent), transparent 52%), radial-gradient(ellipse at 100% 18%, color-mix(in oklch, var(--primary) 16%, transparent), transparent 55%), radial-gradient(ellipse at 80% 100%, color-mix(in oklch, var(--success) 12%, transparent), transparent 48%)',
    '--component-light-image': 'radial-gradient(ellipse at var(--glass-x, 25%) var(--glass-y, 0%), rgb(255 255 255 / 4%), transparent 65%), linear-gradient(160deg, rgb(255 255 255 / 2%), transparent 38%, rgb(0 0 0 / 2%))',
    '--component-light-rim': 'color-mix(in oklch, var(--border) 48%, transparent)',
    '--component-light-edge': 'inset 0 1px 0 rgb(255 255 255 / 7%), inset 0 -1px 0 rgb(0 0 0 / 8%)',
    '--component-light-depth': '0 8px 28px rgb(0 0 0 / 9%), 0 2px 5px rgb(0 0 0 / 4%)',
  },
  roles: {
    'nav-panel': {
      bg: 'color-mix(in oklch, var(--card) 54%, transparent)',
      blur: 'blur(24px) saturate(1.45)',
      refraction: { strength: 18, edge: 24, blur: 1.5 },
    },
    'context-panel': {
      bg: 'color-mix(in oklch, var(--card) 54%, transparent)',
      blur: 'blur(24px) saturate(1.45)',
      refraction: { strength: 18, edge: 24, blur: 1.5 },
    },
    action: {
      bg: 'color-mix(in oklch, var(--card) 46%, transparent)',
      image: 'var(--glass-light)',
      blur: 'blur(20px) saturate(1.5)',
      refraction: { strength: 20, edge: 26, blur: 3 },
    },
    input: {
      bg: 'color-mix(in oklch, var(--card) 82%, transparent)',
      refraction: { strength: 10, edge: 12, blur: 0.8 },
    },
    overlay: {
      bg: 'color-mix(in oklch, var(--popover) 84%, transparent)',
      blur: 'blur(28px) saturate(1.3)',
      refraction: { strength: 14, edge: 20, blur: 3 },
    },
  },
  motion: { spring: 'allow', signature: 'none' },
};

/** 第二种设计由同一参数协议表达,不需要组件内的 paper 分支。 */
const PAPER: MaterialCategory = {
  id: 'paper', label: '纸质',
  components: {
    '--component-nav-current-bg': 'color-mix(in oklch, var(--foreground) 7%, var(--card))',
    '--component-nav-selected-bg': 'color-mix(in oklch, var(--primary) 12%, var(--card))',
    '--component-nav-state-shadow': 'inset 0 0 0 1px var(--border)',
    '--component-content-bg': 'var(--card)',
    '--component-content-image': 'var(--component-surface-texture)',
    '--component-content-shadow': '0 2px 0 color-mix(in oklch, var(--foreground) 7%, transparent)',
    '--component-panel-shadow': '0 2px 6px rgb(0 0 0 / 6%)',
    '--component-surface-texture': 'repeating-linear-gradient(0deg, color-mix(in oklch, var(--foreground) 1.5%, transparent) 0px, transparent 1px, transparent 4px)',
  },
  roles: Object.fromEntries(['nav-panel', 'context-panel', 'action', 'input', 'reading', 'overlay'].map(role => [role, {
    bg: 'var(--card)', image: 'var(--component-surface-texture)',
  }])),
  motion: { spring: 'suppress', signature: 'none' },
};

export const MATERIAL_CATEGORIES = freezeConfiguration({
  solid: SOLID,
  glass: GLASS,
  paper: PAPER,
} satisfies Record<string, MaterialCategory>);

export type MaterialId = keyof typeof MATERIAL_CATEGORIES;

export function getMaterialCategory(id: string): MaterialCategory {
  return Object.hasOwn(MATERIAL_CATEGORIES, id) ? MATERIAL_CATEGORIES[id as MaterialId] : SOLID;
}
