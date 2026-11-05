import type { Component } from 'vue';
import { NotebookPen } from '@lucide/vue';
import NotesWorkspace from '@/features/notes/NotesWorkspace.vue';
import NotesQuickInput from '@/features/notes/NotesQuickInput.vue';
import TelemetryCoordinationView from '@/features/telemetry/TelemetryCoordinationView.vue';

/**
 * 工具模块契约 v2:面板里的一个功能就是一个工具,通过**挂载(mount)**声明
 * 自己在两个侧栏里以什么形态出现,用户决定装不装(禁用)、每个挂载显不显示。
 * 本文件同时是契约、内置注册表与解析层;阶段 2 引入外部安装包时再拆。
 *
 * 位置只有两个(左侧栏/右侧栏),细分四种槽位:
 * - left-nav     左导航入口(点击打开工具页面)
 * - left-widget  左栏内嵌内容(如状态监看图)
 * - right-tools  右栏固定的「工具」标签页:每个工具一个可折叠区块,堆叠展示
 * - right-details 右栏「详情」标签页里的卡片
 *
 * 工具只提供内容组件,入口的按钮/标签/折叠区块外壳由宿主渲染 —— 形态与内容解耦。
 *
 * 边界(有意收窄):只有「可选、自包含、禁用后核心无损」的功能才做成工具
 * ——禁用它,面板的核心工作(通过会话协调 Agent)毫发无损。会话流、输入区、
 * 团队管理、设置、Panel Agent、全局搜索是面板骨架,永不模块化;外部工具
 * (阶段 2)也只进这些槽位,不提供路由级扩展或消息流协议接入。
 *
 * 注意与 `src/tools.mjs`(Agent 可调用的 send/tasks_set 等工具)无关。
 */

export const TOOL_SLOTS = ['left-nav', 'left-widget', 'right-tools', 'right-details'] as const;
export type ToolSlot = (typeof TOOL_SLOTS)[number];
export type ToolScope = 'global' | 'team';

/** 设置页与提示里对槽位的统一称呼。 */
export const TOOL_SLOT_LABELS: Record<ToolSlot, string> = {
  'left-nav': '左导航入口',
  'left-widget': '左栏组件',
  'right-tools': '右栏工具页',
  'right-details': '详情卡片',
};

export interface ToolMount {
  slot: ToolSlot;
  /** 该挂载点渲染的内容组件,统一 props { groupId?: string }。 */
  component: Component;
  /** 仅 left-nav:点击导航到的路由名。 */
  routeName?: string;
}

export interface ToolDefinition {
  id: string;
  name: string;
  description?: string;
  /** global=不依赖团队;left-nav 挂载必须是 global;team 挂载接收 groupId。 */
  scope: ToolScope;
  /** 挂载声明,至少一个;同一槽位最多出现一次。 */
  mounts: ToolMount[];
  icon?: Component;
}

const coordinationTool: ToolDefinition = {
  id: 'builtin.coordination',
  name: '协调遥测',
  description: '主 Agent 协调会话的执行方、来源与批次概览。',
  scope: 'team',
  mounts: [
    // 详情卡片是默认形态;也可以在右栏工具页里打开 —— 两个位置独立开关。
    { slot: 'right-details', component: TelemetryCoordinationView },
    { slot: 'right-tools', component: TelemetryCoordinationView },
  ],
};

const notesTool: ToolDefinition = {
  id: 'builtin.notes',
  name: '随心记',
  description: '私人随手记,不进团队会话。',
  scope: 'global',
  mounts: [
    { slot: 'left-nav', component: NotesWorkspace, routeName: 'notes' },
    { slot: 'right-tools', component: NotesQuickInput },
  ],
  icon: NotebookPen,
};

/** 内置工具随应用发布、不可卸载,只有启用/禁用状态(照内置主题"不进库"先例)。 */
export const BUILTIN_TOOLS: readonly ToolDefinition[] = [coordinationTool, notesTool];

export function builtinTool(id: string): ToolDefinition | undefined {
  return BUILTIN_TOOLS.find(tool => tool.id === id);
}

/** 用户级工具状态:工具级禁用 + 挂载级隐藏 + 槽位内排序,键见下。 */
export interface ToolUserState {
  disabled: Record<string, boolean>;
  hidden: Record<string, boolean>;
  /** 每个槽位的挂载显示顺序,值是 `${工具id}:${槽位}` 键的有序列表;缺省按注册顺序。 */
  order: Record<string, string[]>;
}

export const mountKey = (toolId: string, slot: ToolSlot) => `${toolId}:${slot}`;

/** 挂载是否显示:工具未禁用且该挂载未被单独隐藏。 */
export function isMountVisible(
  tool: ToolDefinition,
  mount: ToolMount,
  prefs: { disabled?: Record<string, boolean>; hidden?: Record<string, boolean> },
): boolean {
  return !prefs.disabled?.[tool.id] && !prefs.hidden?.[mountKey(tool.id, mount.slot)];
}

export interface MountedTool {
  tool: ToolDefinition;
  mount: ToolMount;
}

/** 未被禁用的工具(整体级):挂载级显隐由 isMountVisible/activeMounts 负责。 */
export function enabledToolsOf(
  prefs: ToolUserState | { disabled?: Record<string, boolean>; hidden?: Record<string, boolean> },
): ToolDefinition[] {
  return BUILTIN_TOOLS.filter(tool => !prefs.disabled?.[tool.id]);
}

/** 某个槽位当前该显示的挂载:先按用户排序(order 里的键),未记录的按注册顺序跟在后面。 */
export function activeMounts(
  slot: ToolSlot,
  prefs: ToolUserState | { disabled?: Record<string, boolean>; hidden?: Record<string, boolean>; order?: Record<string, string[]> },
): MountedTool[] {
  const order = prefs.order?.[slot];
  const rank = (toolId: string) => {
    const index = order?.indexOf(mountKey(toolId, slot)) ?? -1;
    return index < 0 ? Number.POSITIVE_INFINITY : index;
  };
  return enabledToolsOf(prefs)
    .flatMap(tool => tool.mounts
      .filter(mount => mount.slot === slot && isMountVisible(tool, mount, prefs))
      .map(mount => ({ tool, mount })))
    .sort((a, b) => rank(a.tool.id) - rank(b.tool.id));
}

/** 左导航条目:left-nav 挂载生成,激活态由当前路由名判定。 */
export interface ToolNavEntry {
  id: string;
  routeName: string;
  label: string;
  icon?: Component;
  current: boolean;
}

export function navToolEntries(
  prefs: ToolUserState | { disabled?: Record<string, boolean>; hidden?: Record<string, boolean> },
  currentRouteName?: string,
): ToolNavEntry[] {
  return activeMounts('left-nav', prefs)
    .filter(({ mount }) => Boolean(mount.routeName))
    .map(({ tool, mount }) => ({
      id: tool.id,
      routeName: mount.routeName!,
      label: tool.name,
      icon: tool.icon,
      current: mount.routeName === currentRouteName,
    }));
}
