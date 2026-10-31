/**
 * 材质大类规格表:设计逻辑框架"材质 × 角色"矩阵的可执行形式。
 * 用户只选择大类;每个角色的基材/工艺/参数在此内化,由 applyMaterial
 * 写成 --surface-{role}-* CSS 变量供表面消费。新增大类 = 新增一行数据。
 */

/** 表面角色:一类具有相同材质处理方式的表面(见设计逻辑框架 §4)。 */
export const SURFACE_ROLES = [
  'nav-panel',
  'context-panel',
  'action',
  'input',
  'reading',
  'overlay',
  'media',
] as const;

export type SurfaceRole = (typeof SURFACE_ROLES)[number];

/** 单个角色的表面渲染:背景(可含工艺渐变)+ 可选的模糊/饱和/高光通道(缺省 = 主题基线,实色)。 */
export interface SurfaceFinish {
  bg?: string;
  image?: string;
  blur?: string;
}

export interface MaterialCategory {
  id: string;
  label: string;
  roles: Partial<Record<SurfaceRole, SurfaceFinish>>;
}

/** 默认实色:所有角色走主题基线,不写任何表面变量。 */
const SOLID: MaterialCategory = { id: 'solid', label: '默认实色', roles: {} };

/**
 * 玻璃:容器/导航用磨砂工艺(安静退后),会话操作区用液态工艺
 * (更透、更清、顶部高光 —— 职能需要强"可按/可输入"暗示)。
 * 运动签名(注释,待动效契约消费):高光沿表面缓慢流动,回弹低阻尼。
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
};

export const MATERIAL_CATEGORIES: Record<string, MaterialCategory> = {
  solid: SOLID,
  glass: GLASS,
};

export function getMaterialCategory(id: string): MaterialCategory {
  return MATERIAL_CATEGORIES[id] ?? SOLID;
}
