import paperGrainUrl from './textures/paper-grain.svg?url&no-inline';
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
  shadow?: string;
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
 * 阅读与输入仍走组件基线,避免玻璃叠玻璃;表面不播放装饰动画,唯环境
 * 光斑在根画布上缓慢漂移(时长经 pace 缩放,减少档压平),见 globals.css。
 * 曲面轮光与环境色由全局材质规则补充,不改变任何布局几何。
 */
const GLASS: MaterialCategory = {
  id: 'glass',
  label: '玻璃',
  effect: 'glass',
  components: {
    // 玻璃物性:圆润的裁切与低阻尼回弹按压是玻璃物理身份的一部分。
    '--component-control-radius': 'var(--radius-lg)',
    '--component-button-press-scale': '0.97',
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

// 独立 SVG 资源保持滤镜片段引用可靠,低频浆料与短纤维分层取样。
const PAPER_GRAIN = `url("${paperGrainUrl}")`;

/** 哑光纸面:深浅色共用同一张中性灰纸纹(细颗粒 + 中频纸齿),厚度交给边缘与截面阴影。 */
const PAPER: MaterialCategory = {
  id: 'paper', label: '纸质',
  components: {
    '--component-control-radius': '4px',
    '--component-panel-radius': '7px',
    '--component-button-press-scale': '1',
    '--component-nav-current-bg': 'color-mix(in oklch, var(--primary) 9%, var(--card))',
    '--component-nav-selected-bg': 'color-mix(in oklch, var(--primary) 13%, var(--card))',
    '--component-nav-state-shadow': 'var(--component-selection-shadow)',
    '--component-content-bg': 'var(--card)',
    '--component-content-image': PAPER_GRAIN,
    // 卡片与页面表面同为 --card 色,细纸边必须消费契约默认的主题边框色才立得住:
    // 不覆写 --component-surface-border,也不再用低比例混色把它压进纸面。
    // 可见边线只由 border 承担:内容面与面板都不叠加上缘内侧高光线(那会读成第二条边),
    // 内缘只保留下缘的薄截面与接触阴影;浮层保留 DESIGN.md 允许的第二层纸边。
    '--component-content-shadow': 'inset 0 -1px 0 color-mix(in oklch, var(--foreground) 11%, transparent), 0 2px 3px -1px color-mix(in oklch, var(--foreground) 12%, transparent), 3px 6px 12px -3px color-mix(in oklch, var(--foreground) 7%, transparent)',
    '--component-panel-shadow': 'inset 0 -1px 0 color-mix(in oklch, var(--foreground) 14%, transparent), 0 2px 4px -1px color-mix(in oklch, var(--foreground) 12%, transparent), 4px 8px 20px -4px color-mix(in oklch, var(--foreground) 9%, transparent)',
    '--component-surface-texture': PAPER_GRAIN,
    '--component-desk-bg': 'color-mix(in oklch, var(--muted) 32%, var(--background))',
    '--component-desk-image': 'none',
    '--component-selection-bg': 'color-mix(in oklch, var(--primary) 22%, var(--card))',
    '--component-selection-fg': 'var(--foreground)',
    '--component-selection-shadow': '0 1px 2px color-mix(in oklch, var(--foreground) 8%, transparent)',
    '--component-tab-active-bg': 'var(--component-selection-bg)',
    '--component-tab-active-border': 'var(--border)',
    '--component-tab-active-shadow': 'var(--component-selection-shadow)',
    '--component-choice-selected-bg': 'var(--component-selection-bg)',
    '--component-choice-selected-fg': 'var(--foreground)',
    '--component-choice-selected-shadow': 'var(--component-selection-shadow)',
  },
  roles: {
    'nav-panel': { bg: 'var(--card)', image: 'var(--component-surface-texture)', shadow: 'var(--component-panel-shadow)' },
    'context-panel': { bg: 'var(--card)', image: 'var(--component-surface-texture)', shadow: 'var(--component-panel-shadow)' },
    action: { bg: 'var(--card)', shadow: '0 1px 2px color-mix(in oklch, var(--foreground) 6%, transparent)' },
    input: { bg: 'color-mix(in oklch, var(--background) 20%, var(--card))', shadow: 'inset 0 1px 2px color-mix(in oklch, var(--foreground) 5%, transparent), 0 1px 0 color-mix(in oklch, var(--card) 80%, transparent)' },
    reading: { bg: 'var(--card)', image: 'none' },
    overlay: { bg: 'var(--popover)', image: 'var(--component-surface-texture)', shadow: 'inset 0 1px 0 light-dark(rgb(255 255 255 / 90%), rgb(255 255 255 / 9%)), 0 1px 0 color-mix(in oklch, var(--card) 65%, var(--foreground)), 0 3px 0 color-mix(in oklch, var(--card) 90%, var(--background)), 0 4px 0 color-mix(in oklch, var(--card) 75%, var(--foreground)), 2px 6px 4px color-mix(in oklch, var(--foreground) 16%, transparent), 10px 22px 40px color-mix(in oklch, var(--foreground) 16%, transparent)' },
  },
  motion: { spring: 'suppress', signature: 'none' },
};

/**
 * 活力实色:柔和实色层次、大圆角、扁平化。层次只靠明度/色相差与极少数
 * 必要边界表达,普通内容面不带阴影;浮层保留一层极轻分离以保证遮挡可读。
 * 圆角与按压幅度是材质物性,归属本表,预设不越权改写。
 */
const VIVID: MaterialCategory = {
  id: 'vivid', label: '活力',
  components: {
    '--component-control-radius': '14px',
    '--component-panel-radius': '22px',
    '--component-button-press-scale': '0.98',
    '--component-selection-bg': 'var(--accent)',
    '--component-selection-fg': 'var(--accent-foreground)',
    '--component-selection-shadow': 'none',
    '--component-tab-active-bg': 'var(--component-selection-bg)',
    '--component-tab-active-border': 'transparent',
    '--component-tab-active-shadow': 'none',
    '--component-choice-track-bg': 'var(--muted)',
    '--component-choice-bg': 'transparent',
    '--component-choice-shadow': 'none',
    '--component-choice-hover-bg': 'color-mix(in oklch, var(--primary) 10%, var(--background))',
    '--component-choice-selected-bg': 'var(--component-selection-bg)',
    '--component-choice-selected-fg': 'var(--component-selection-fg)',
    '--component-choice-border': 'transparent',
    '--component-choice-selected-border': 'transparent',
    '--component-choice-selected-shadow': 'none',
    '--component-nav-bg': 'transparent',
    '--component-nav-current-bg': 'var(--accent)',
    '--component-nav-selected-bg': 'var(--accent)',
    '--component-nav-state-shadow': 'none',
    '--component-surface-border': 'color-mix(in oklch, var(--border) 72%, transparent)',
    '--component-content-bg': 'var(--card)',
    '--component-content-image': 'none',
    '--component-content-shadow': 'none',
    '--component-panel-shadow': 'none',
    '--component-desk-bg': 'var(--background)',
    '--component-desk-image': 'none',
  },
  roles: {
    'nav-panel': { bg: 'var(--card)' },
    'context-panel': { bg: 'var(--card)' },
    action: { bg: 'var(--card)' },
    input: { bg: 'color-mix(in oklch, var(--background) 55%, var(--card))' },
    overlay: { bg: 'var(--popover)', shadow: '0 8px 24px color-mix(in oklch, var(--foreground) 12%, transparent)' },
  },
  motion: { spring: 'allow', signature: 'none' },
};

export const MATERIAL_CATEGORIES = freezeConfiguration({
  solid: SOLID,
  glass: GLASS,
  paper: PAPER,
  vivid: VIVID,
} satisfies Record<string, MaterialCategory>);

export type MaterialId = keyof typeof MATERIAL_CATEGORIES;

export function getMaterialCategory(id: string): MaterialCategory {
  return Object.hasOwn(MATERIAL_CATEGORIES, id) ? MATERIAL_CATEGORIES[id as MaterialId] : SOLID;
}
