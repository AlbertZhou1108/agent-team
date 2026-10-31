/**
 * 团队标签色板:数据级颜色(用户为团队挑选的标签色,存于组织数据),
 * 属于"内容"而非界面样式 —— 允许使用色值字面量,治理检查对此文件豁免。
 */
export const TEAM_COLORS = [
  { label: '红色', value: '#ef4444' },
  { label: '橙色', value: '#f59e0b' },
  { label: '绿色', value: '#22c55e' },
  { label: '蓝色', value: '#3b82f6' },
  { label: '紫色', value: '#a855f7' },
] as const;
