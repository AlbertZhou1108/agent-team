import type { BadgeVariants } from '@/components/ui/badge';
import type { PanelAccess } from './types';

export interface PanelAccessOption {
  value: PanelAccess;
  label: string;
  description: string;
  badgeVariant: BadgeVariants['variant'];
}

export const panelAccessOptions: readonly PanelAccessOption[] = [
  {
    value: 'read-only',
    label: '只读',
    description: '可读取，不能修改文件；命令在宿主只读沙箱内执行。',
    badgeVariant: 'outline',
  },
  {
    value: 'workspace-write',
    label: '工作区写入',
    description: '只能修改私人工作区内的文件。',
    badgeVariant: 'secondary',
  },
  {
    value: 'full-access',
    label: '完全权限',
    description: '关闭文件沙箱，可修改工作区外文件；不承诺网络隔离。',
    badgeVariant: 'default',
  },
];

export function panelAccessOption(
  access: PanelAccess | null | undefined,
): PanelAccessOption {
  return (
    panelAccessOptions.find((option) => option.value === access) ??
    panelAccessOptions[0]!
  );
}

export function panelWorkspaceBasename(
  workspace: string | null | undefined,
): string {
  if (!workspace) return '';
  const trimmed = workspace.replace(/[\\/]+$/, '');
  if (!trimmed) return workspace;
  return trimmed.split(/[\\/]/).filter(Boolean).at(-1) ?? workspace;
}
