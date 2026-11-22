import type { Component, ComputedRef, InjectionKey } from 'vue';
import type { Router } from 'vue-router';
import type { useUiStore } from '@/stores/ui';

/**
 * 插件契约 v3 类型定义（纯类型与常量，不导入任何业务组件，避免循环依赖）。
 *
 * 位置与槽位：
 * - left-nav     左导航入口（必须 global，触发路由或命令）
 * - team-tabs    团队顶栏标签页（对话 / 轨迹 / 原始事件 右侧分割线之后）
 * - right-tools  右栏固定的「工具」标签页（可折叠区块）
 */
export const PLUGIN_SLOTS = ['left-nav', 'team-tabs', 'right-tools'] as const;
export type PluginSlot = (typeof PLUGIN_SLOTS)[number];
export type PluginScope = 'global' | 'team';

/** 设置页与提示里对槽位的统一称呼。 */
export const PLUGIN_SLOT_LABELS: Record<PluginSlot, string> = {
  'left-nav': '左导航入口',
  'team-tabs': '团队顶栏标签',
  'right-tools': '右栏工具页',
};

export interface PluginContext {
  router: Router;
  ui: ReturnType<typeof useUiStore>;
}

export interface PluginRoute {
  name: string;
  path: string;
  component: Component;
}

export interface PluginHotkey {
  key: string;
  mod: true;
}

export interface PluginCommand {
  id: string;
  title: string;
  hotkey?: PluginHotkey;
  run: (ctx: PluginContext) => void;
  isActive?: (ctx: PluginContext) => boolean;
}

export type PluginMount =
  | { slot: 'left-nav'; route: string }
  | { slot: 'left-nav'; command: string }
  | {
      slot: 'team-tabs';
      component: Component;
      label?: string;
      /** 声明该标签页承载的跨区联动能力（如成员用量详情跳转），宿主按能力匹配而不写死插件 id。 */
      provides?: 'member-usage';
    }
  | { slot: 'right-tools'; component: Component };

export interface SearchEntry {
  id: string;
  label: string;
  path: string;
  keywords?: string;
  /** 条目归属插件 id，用于在插件禁用期间同步隐藏。 */
  pluginId?: string;
}

export interface SearchHit {
  id: string;
  label: string;
  description?: string;
  meta?: string;
  path: string;
}

export interface SearchProvider {
  id: string;
  heading: string;
  pluginId?: string;
  static?: SearchEntry[];
  query?: (term: string, signal: AbortSignal) => Promise<SearchHit[]>;
}

export interface PluginDefinition {
  id: string;
  name: string;
  description?: string;
  icon?: Component;
  scope: PluginScope;
  mounts: PluginMount[];
  routes?: PluginRoute[];
  commands?: PluginCommand[];
  overlays?: Component[];
  searchProviders?: SearchProvider[];
}

/** 用户级插件偏好：键名与 localStorage 中的 toolModules 结构保持兼容。 */
export interface PluginUserState {
  disabled?: Record<string, boolean>;
  hidden?: Record<string, boolean>;
  order?: Record<string, string[]>;
  pinned?: Record<string, string[]>;
}

export interface MountedPlugin {
  plugin: PluginDefinition;
  mount: PluginMount;
}

export interface PluginNavEntry {
  id: string;
  route?: string;
  command?: string;
  label: string;
  icon?: Component;
  current: boolean;
}

export interface ResolvedPluginRoute {
  plugin: PluginDefinition;
  route: PluginRoute;
  enabled: boolean;
}

export interface RegisteredPluginCommand {
  plugin: PluginDefinition;
  command: PluginCommand;
}

export interface RegisteredPluginOverlay {
  key: string;
  pluginId: string;
  component: Component;
}

export const CORE_ROUTE_NAMES = new Set([
  'panel-agent',
  'create-team',
  'group',
  'settings',
  'not-found',
]);

export const CORE_ROUTE_PATHS = new Set([
  '/',
  '/agent',
  '/groups/new',
  '/groups/:groupId?',
  '/settings',
]);

export interface PluginSearchContext {
  providers: ComputedRef<SearchProvider[]>;
  disabled: ComputedRef<Record<string, boolean>>;
  allStaticEntries: SearchEntry[];
}

export const PLUGIN_SEARCH_CONTEXT_KEY: InjectionKey<PluginSearchContext> =
  Symbol('plugin-search-context');
