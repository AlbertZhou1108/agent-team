/** 参数键按维度拥有。组件仅消费语义变量,不读取预设 ID。 */
import { freezeConfiguration } from './configuration-data';
export const COMPONENT_DEFAULTS = freezeConfiguration({
  style: {
    '--component-nav-marker-width': '2px',
  },
  typography: {
    '--component-control-font-size': '0.875rem',
    '--component-nav-font-size': '0.875rem',
    '--component-title-font-size': '1rem',
    '--component-disclosure-font-size': '0.875rem',
    '--component-card-title-font-size': '1rem',
    '--component-card-compact-title-font-size': '0.875rem',
  },
  material: {
    // 物性键:圆角与按压幅度是材质的物理身份,随材质内化(玻璃圆润回弹、
    // 纸质哑光轻压),预设不得通过 style/behavior 差量改写。
    '--component-control-radius': 'var(--radius-md)',
    '--component-panel-radius': 'var(--radius-lg)',
    '--component-button-press-scale': '0.98',
    '--component-selection-bg': 'var(--accent)',
    '--component-selection-fg': 'var(--accent-foreground)',
    '--component-selection-shadow': 'none',
    '--component-nav-current-border': 'transparent',
    '--component-tab-active-bg': 'light-dark(var(--background), color-mix(in oklch, var(--input) 30%, transparent))',
    '--component-tab-active-border': 'light-dark(transparent, var(--input))',
    '--component-tab-active-shadow': '0 1px 3px rgb(0 0 0 / 10%)',
    '--component-choice-track-bg': 'transparent',
    '--component-choice-bg': 'transparent',
    '--component-choice-shadow': '0 1px 2px rgb(0 0 0 / 5%)',
    '--component-choice-hover-bg': 'var(--accent)',
    '--component-choice-selected-bg': 'var(--accent)',
    '--component-choice-selected-fg': 'var(--accent-foreground)',
    '--component-choice-border': 'var(--input)',
    '--component-choice-selected-border': 'var(--input)',
    '--component-choice-selected-shadow': '0 1px 2px rgb(0 0 0 / 5%)',
    '--component-nav-bg': 'transparent',
    '--component-nav-current-bg': 'var(--secondary)',
    '--component-nav-selected-bg': 'var(--accent)',
    '--component-nav-state-shadow': 'none',
    '--component-nav-marker-color': 'var(--primary)',
    '--component-surface-border': 'var(--border)',
    '--component-content-bg': 'var(--card)',
    '--component-content-image': 'none',
    '--component-content-shadow': '0 1px 2px rgb(0 0 0 / 5%)',
    '--component-panel-shadow': 'none',
    '--component-surface-texture': 'none',
    '--component-desk-bg': 'transparent',
    '--component-desk-image': 'none',
    '--component-environment-image': 'none',
    '--component-light-image': 'none',
    '--component-light-edge': 'none',
    '--component-light-depth': 'none',
    '--component-light-rim': 'var(--border)',
    '--component-highlight-radius': '180px',
    '--component-highlight-color': 'rgb(255 255 255 / 65%)',
    '--component-highlight-rest': '0.12',
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
    '--component-choice-track-padding': '0px',
    '--component-choice-gap': '8px',
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
