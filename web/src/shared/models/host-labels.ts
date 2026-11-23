import type { Host } from './view-types';

export type HostKind = 'codex' | 'claude' | 'dsh' | 'zcode';

export const HOST_KINDS: HostKind[] = ['codex', 'claude', 'dsh', 'zcode'];

/** 宿主基础品牌名（用于拼装桌面应用标题，如「DeepSeek Harness 桌面应用」）。 */
export const HOST_LABELS: Record<HostKind, string> = {
  codex: 'Codex',
  claude: 'Claude',
  dsh: 'DeepSeek Harness',
  zcode: 'ZCode',
};

/** 用户可见的官方宿主名称映射；内部 ID、CLI 参数与数据库值保持不变。 */
const DISPLAY_LABELS: Record<string, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
  dsh: 'DeepSeek Harness',
  zcode: 'ZCode',
  workbuddy: 'WorkBuddy',
  'codex-desktop': 'Codex 桌面应用',
  'claude-desktop': 'Claude 桌面应用',
  'dsh-desktop': 'DeepSeek Harness 桌面应用',
  'zcode-desktop': 'ZCode 桌面应用',
};

/** 用户可见的宿主官方名称；未知值原样返回，避免界面出现空白。 */
export function hostDisplayLabel(host?: string | null): string {
  if (!host) return '未选择';
  return DISPLAY_LABELS[host] ?? host;
}

/** 将桌面宿主别名（*-desktop）归一到基宿主协议标识，供轨迹解析器分派。 */
export function normalizeTraceHost(host?: string | null): Host {
  if (!host) return 'unknown';
  const base = host.endsWith('-desktop') ? host.slice(0, -'-desktop'.length) : host;
  if (base === 'codex' || base === 'claude' || base === 'dsh' || base === 'zcode') return base;
  return 'unknown';
}
