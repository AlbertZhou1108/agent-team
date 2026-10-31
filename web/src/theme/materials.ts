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
}

/** 默认实色:所有角色走主题基线,不写任何表面变量。 */
const SOLID: MaterialCategory = {
  id: 'solid',
  label: '默认实色',
  roles: {},
  motion: { spring: 'allow', signature: 'none' },
};

/**
 * 玻璃:容器/导航用磨砂工艺(安静退后),会话操作区用液态工艺
 * (更透、更清、顶部高光 —— 职能需要强"可按/可输入"暗示)。
 * 运动签名:高光沿表面缓慢流动,回弹低阻尼。
 */
const GLASS: MaterialCategory = {
  id: 'glass',
  label: '玻璃',
  roles: {
    'nav-panel': {
      bg: 'color-mix(in oklch, var(--card) 74%, transparent)',
      blur: 'blur(18px) saturate(1.08)',
    },
    'context-panel': {
      bg: 'color-mix(in oklch, var(--card) 74%, transparent)',
      blur: 'blur(18px) saturate(1.08)',
    },
    action: {
      bg: 'color-mix(in oklch, var(--background) 55%, transparent)',
      image:
        'linear-gradient(180deg, color-mix(in oklch, var(--foreground) 7%, transparent), transparent 46%)',
      blur: 'blur(8px) saturate(1.25)',
    },
  },
  motion: { spring: 'allow', signature: 'liquid-flow' },
};

export const MATERIAL_CATEGORIES: Record<string, MaterialCategory> = {
  solid: SOLID,
  glass: GLASS,
};

export function getMaterialCategory(id: string): MaterialCategory {
  return MATERIAL_CATEGORIES[id] ?? SOLID;
}
