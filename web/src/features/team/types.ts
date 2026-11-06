import type { Component } from 'vue';
import { Activity, Bot, MessagesSquare, Wrench } from '@lucide/vue';

export type ContextPanel =
  | 'collaboration'
  | 'members'
  | 'sessions'
  | 'details'
  | 'tools';

/**
 * 右栏 tab 恒定五个：概览/成员/会话/详情/工具。「工具」是固定容器，页内二级切换
 * 当前显示哪个挂载在 right-tools 的工具——tab 数量不随工具增减。
 */
export const contextTabs: Array<{
  value: ContextPanel;
  label: string;
  icon: Component;
}> = [
  { value: 'collaboration', label: '概览', icon: Activity },
  { value: 'members', label: '成员', icon: Bot },
  { value: 'sessions', label: '会话', icon: MessagesSquare },
  { value: 'details', label: '详情', icon: Activity },
  { value: 'tools', label: '工具', icon: Wrench },
];
