import type { Component } from 'vue';
import { Activity, Bot, Wrench } from '@lucide/vue';

export type ContextPanel =
  | 'collaboration'
  | 'members'
  | 'tools';

/**
 * 右栏 tab 精简为三个：概览 / 成员 / 工具。
 * 原「会话」与「详情」已迁至中间主区标签页（对话 / 轨迹 / 原始事件）。
 */
export const contextTabs: Array<{
  value: ContextPanel;
  label: string;
  icon: Component;
}> = [
  { value: 'collaboration', label: '概览', icon: Activity },
  { value: 'members', label: '成员', icon: Bot },
  { value: 'tools', label: '工具', icon: Wrench },
];
