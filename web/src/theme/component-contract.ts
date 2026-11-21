/** 参数键按维度拥有。组件仅消费语义变量,不读取预设 ID。 */
import { freezeConfiguration } from './configuration-data';
export const COMPONENT_DEFAULTS = freezeConfiguration({
  style: {
    '--component-nav-marker-width': '2px',
    // 图片浮层控件压印层:叠在任意亮度的图片之上,对比度不依赖主题,
    // 用黑白原语 + 透明度修饰符表达,不随明暗模式切换。
    '--component-image-scrim-fg': 'rgb(255 255 255)',
    '--component-image-scrim-bg': 'rgb(0 0 0)',
  },
  typography: {
    '--component-control-font-size': '0.875rem',
    '--component-nav-font-size': '0.875rem',
    '--component-title-font-size': '1rem',
    '--component-disclosure-font-size': '0.875rem',
    '--component-card-title-font-size': '1rem',
    '--component-card-compact-title-font-size': '0.875rem',
    '--component-micro-font-size': '0.625rem',
  },
  material: {
    // 物性键:圆角与按压幅度是材质的物理身份,随材质内化(玻璃圆润回弹、
    // 纸质哑光轻压),预设不得通过 style/behavior 差量改写。
    // 圆角是一套随材质的刻度:panel(面板/内容面)>card(面内嵌卡/消息卡)>
    // control(按钮/输入)>chip(徽章/菜单项/小件)。组件按语义取档,
    // 不写静态 Tailwind 档位;rounded-xs 保留给不随材质的微装饰(箭头等)。
    '--component-control-radius': 'var(--radius-md)',
    '--component-panel-radius': 'var(--radius-lg)',
    '--component-card-radius': '0.75rem',
    '--component-chip-radius': '0.375rem',
    '--component-button-press-scale': '0.98',
    '--component-selection-bg': 'var(--accent)',
    '--component-selection-fg': 'var(--accent-foreground)',
    '--component-selection-shadow': 'none',
    '--component-nav-current-border': 'transparent',
    '--component-tab-active-bg': 'light-dark(var(--background), color-mix(in oklch, var(--input) 30%, transparent))',
    '--component-tab-active-border': 'light-dark(transparent, var(--input))',
    '--component-tab-active-shadow': '0 1px 3px rgb(0 0 0 / 10%)',
    // segmented 默认就是连续分段:共享浅底槽 + 无边框 item + 选中实底。
    '--component-choice-track-bg': 'color-mix(in oklch, var(--foreground) 6%, transparent)',
    '--component-choice-bg': 'transparent',
    '--component-choice-shadow': 'none',
    '--component-choice-hover-bg': 'color-mix(in oklch, var(--foreground) 8%, transparent)',
    '--component-choice-selected-bg': 'var(--card)',
    '--component-choice-selected-fg': 'var(--foreground)',
    '--component-choice-border': 'transparent',
    '--component-choice-selected-border': 'transparent',
    '--component-choice-selected-shadow': '0 1px 2px rgb(0 0 0 / 8%)',
    '--component-nav-bg': 'transparent',
    '--component-nav-current-bg': 'var(--secondary)',
    '--component-nav-selected-bg': 'var(--accent)',
    '--component-nav-state-shadow': 'none',
    '--component-nav-marker-color': 'var(--primary)',
    '--component-surface-border': 'var(--border)',
    '--component-content-bg': 'var(--card)',
    '--component-content-image': 'none',
    '--component-content-shadow': 'none',
    '--component-panel-shadow': 'none',
    '--component-surface-texture': 'none',
    '--component-desk-bg': 'transparent',
    '--component-desk-image': 'none',
    '--component-environment-image': 'none',
    '--component-light-rim': 'var(--border)',
  },
  behavior: {
    // 动效语义层:组件只认「这是什么变化」,不认具体毫秒。
    // 三档面积——微反馈 / 状态与进出 / 大面积结构——映射到 --motion-duration-*;
    // 缓动按用途分:进入减速停稳,离场加速让位,双向 standard。
    '--component-feedback-duration': 'var(--motion-duration-fast)',
    '--component-disclosure-duration': 'var(--motion-duration-normal)',
    '--component-disclosure-easing': 'var(--motion-ease-standard)',
    '--component-content-duration': 'var(--motion-duration-normal)',
    '--component-content-easing': 'var(--motion-ease-out)',
    '--component-overlay-duration': 'var(--motion-duration-normal)',
    '--component-overlay-enter-easing': 'var(--motion-ease-out)',
    '--component-overlay-exit-easing': 'var(--motion-ease-in)',
    '--component-layout-duration': 'var(--motion-duration-slow)',
    '--component-layout-easing': 'var(--motion-ease-standard)',
  },
  layout: {
    '--component-choice-track-padding': '4px',
    '--component-choice-gap': '4px',
    '--component-control-height': '36px',
    '--component-nav-padding-y': '8px',
    '--component-nav-padding-x': '12px',
    '--component-panel-gap': '12px',
    '--component-sidebar-inset': '12px',
    '--component-card-padding': '24px',
    '--component-card-gap': '24px',
    '--component-card-compact-padding': '16px',
    '--component-card-compact-gap': '12px',
    '--component-disclosure-padding-y': '8px',
    '--component-disclosure-gap': '12px',
  },
} satisfies Record<string, Record<string, string>>);

export type ComponentDimension = keyof typeof COMPONENT_DEFAULTS;
export type DimensionTokens<D extends ComponentDimension> = Record<keyof typeof COMPONENT_DEFAULTS[D], string>;
export type ComponentMaterialTokens = Partial<DimensionTokens<'material'>>;
export type ComponentDimensionPatch = { [D in ComponentDimension]?: Partial<DimensionTokens<D>> };
