import type { Component } from 'vue';
import { NotebookPen } from '@lucide/vue';
import NotesWorkspace from '@/features/notes/NotesWorkspace.vue';
import TelemetryCoordinationView from '@/features/telemetry/TelemetryCoordinationView.vue';

/**
 * 工具模块契约:面板里的一个功能就是一个工具,声明自己能挂在哪里,
 * 用户决定装不装(禁用)、挂在哪。本文件同时是契约、内置注册表与解析层 ——
 * 第一阶段只有内置工具,收在一个文件里;阶段 2 引入外部安装包时再拆。
 *
 * 边界(有意收窄):只有「可选、自包含、往槽位里加内容」的功能才做成工具
 * ——禁用它,面板的核心工作(通过会话协调 Agent)毫发无损。会话流、输入区、
 * 团队管理、设置、Panel Agent、全局搜索是面板骨架,永不模块化;外部工具
 * (阶段 2)也只进这三个槽位,不提供路由级扩展或消息流协议接入。
 *
 * 注意与 `src/tools.mjs`(Agent 可调用的 send/tasks_set 等工具)无关。
 */

export const TOOL_SURFACES = ['nav', 'right-tab', 'details-card'] as const;
export type ToolSurface = (typeof TOOL_SURFACES)[number];
export type ToolScope = 'global' | 'team';

/** 设置页与提示里对挂载点的统一称呼。 */
export const TOOL_SURFACE_LABELS: Record<ToolSurface, string> = {
  nav: '左导航',
  'right-tab': '右栏标签',
  'details-card': '详情卡片',
};

export interface ToolManifest {
  id: string;
  name: string;
  description?: string;
  /** global=不依赖团队(左导航);team=需要 groupId,只在团队工作区渲染。 */
  scope: ToolScope;
  /** 支持的挂载点,至少一个。 */
  surfaces: ToolSurface[];
  /** 默认挂载点,必须在 surfaces 里;也是"恢复默认"的锚。 */
  defaultSurface: ToolSurface;
}

export interface ToolDefinition extends ToolManifest {
  /** 统一接收 { groupId?: string },数据自取(vue-query 同 key 自动共享缓存)。 */
  component: Component;
  /** 工具自己的图标(导航条目/设置页用)。 */
  icon?: Component;
  /** nav 工具对应的路由名:激活态判定与跳转都用它。 */
  routeName?: string;
}

const coordinationTool: ToolDefinition = {
  id: 'builtin.coordination',
  name: '协调遥测',
  description: '主 Agent 协调会话的执行方、来源与批次概览。',
  scope: 'team',
  surfaces: ['details-card', 'right-tab'],
  defaultSurface: 'details-card',
  component: TelemetryCoordinationView,
};

const notesTool: ToolDefinition = {
  id: 'builtin.notes',
  name: '随心记',
  description: '私人随手记,不进团队会话。',
  scope: 'global',
  surfaces: ['nav'],
  defaultSurface: 'nav',
  component: NotesWorkspace,
  icon: NotebookPen,
  routeName: 'notes',
};

/** 内置工具随应用发布、不可卸载,只有启用/禁用状态(照内置主题"不进库"先例)。 */
export const BUILTIN_TOOLS: readonly ToolDefinition[] = [coordinationTool, notesTool];

export function builtinTool(id: string): ToolDefinition | undefined {
  return BUILTIN_TOOLS.find(tool => tool.id === id);
}

/** 过滤掉被禁用的工具。禁用只影响渲染,数据与配置保留,可随时恢复。 */
export function enabledTools(disabled: Record<string, boolean> = {}): ToolDefinition[] {
  return BUILTIN_TOOLS.filter(tool => !disabled[tool.id]);
}

/** 用户的位置覆盖只在工具声明过的挂载点里生效,否则回落默认。 */
export function resolveSurface(tool: ToolDefinition, override?: string): ToolSurface {
  if (override && tool.surfaces.includes(override as ToolSurface)) {
    return override as ToolSurface;
  }
  return tool.defaultSurface;
}

/** 某个挂载点上该出现的工具:启用 + 生效位置匹配,消费点只有这一种问法。 */
export function toolsForSurface(
  surface: ToolSurface,
  prefs: { disabled?: Record<string, boolean>; surfaces?: Record<string, string> },
): ToolDefinition[] {
  return enabledTools(prefs.disabled)
    .filter(tool => resolveSurface(tool, prefs.surfaces?.[tool.id]) === surface);
}

/** 左导航条目:global 工具生效位置为 nav 时出现,激活态由当前路由名判定。 */
export interface ToolNavEntry {
  id: string;
  routeName: string;
  label: string;
  icon?: Component;
  current: boolean;
}

export function navToolEntries(
  prefs: { disabled?: Record<string, boolean>; surfaces?: Record<string, string> },
  currentRouteName?: string,
): ToolNavEntry[] {
  return toolsForSurface('nav', prefs)
    .filter(tool => tool.routeName)
    .map(tool => ({
      id: tool.id,
      routeName: tool.routeName!,
      label: tool.name,
      icon: tool.icon,
      current: tool.routeName === currentRouteName,
    }));
}
