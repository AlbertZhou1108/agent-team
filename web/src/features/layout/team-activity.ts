import type { Group, Member } from '@/shared/api/raw-types';
import { TEAM_COLORS } from '@/shared/team-colors';

/** 计算团队用于排序与展示的最近活跃时间戳（毫秒）。优先取工作台活动/未读时间，回落创建时间。 */
export function teamActiveTimestamp(
  group: Group,
  activityByTeam?: ReadonlyMap<string, number>,
): number {
  const activity = activityByTeam?.get(group.id) ?? 0;
  const created = Date.parse(group.created);
  return Math.max(activity, Number.isFinite(created) ? created : 0);
}

/** 将时间戳格式化为团队卡片上的简洁相对活跃时间。 */
export function formatActiveTime(timestampMs: number, nowMs = Date.now()): string {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return '暂无活动';
  const diff = Math.max(0, nowMs - timestampMs);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return '刚刚活跃';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 2 * day) return '昨天';
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  const date = new Date(timestampMs);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

/** 团队头像底色：优先用户自定义色，否则按 id 稳定落到共享团队色板。 */
export function teamAvatarColor(groupId: string, customColor?: string): string {
  if (customColor) return customColor;
  let hash = 0;
  for (let i = 0; i < groupId.length; i += 1) {
    hash = (hash * 31 + groupId.charCodeAt(i)) | 0;
  }
  const index = Math.abs(hash) % TEAM_COLORS.length;
  return TEAM_COLORS[index]!.value;
}

/** 文件夹按名称排序（固定规则）。 */
export function sortFoldersByName<T extends { name: string }>(folders: readonly T[]): T[] {
  return [...folders].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

/** 组内团队按活跃时间降序排序（固定规则），同时间戳按名称与 id 稳定收敛。 */
export function sortTeamsByActivity(
  groups: readonly Group[],
  activityByTeam?: ReadonlyMap<string, number>,
): Group[] {
  return [...groups].sort((a, b) => {
    const diff = teamActiveTimestamp(b, activityByTeam) - teamActiveTimestamp(a, activityByTeam);
    if (diff !== 0) return diff;
    const byName = a.name.localeCompare(b.name, 'zh-CN');
    return byName !== 0 ? byName : a.id.localeCompare(b.id);
  });
}

/** 按团队名或非移除成员名进行本地大小写不敏感筛选。 */
export function filterTeamsByQuery(
  groups: readonly Group[],
  members: readonly Member[],
  query: string,
): Group[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...groups];
  const memberNamesByGroup = new Map<string, string[]>();
  for (const member of members) {
    if (member.removed) continue;
    const list = memberNamesByGroup.get(member.group_id);
    if (list) list.push(member.name.toLowerCase());
    else memberNamesByGroup.set(member.group_id, [member.name.toLowerCase()]);
  }
  return groups.filter((group) => {
    if (group.name.toLowerCase().includes(needle)) return true;
    const names = memberNamesByGroup.get(group.id);
    return names ? names.some(name => name.includes(needle)) : false;
  });
}

/** 最近访问快捷头像列表：按最近访问 ID 顺序匹配现存未归档团队，最多保留 limit 个（默认 9 个）。 */
export function recentTeams(
  groups: readonly Group[],
  recentIds: readonly string[],
  limit = 9,
): Group[] {
  if (!recentIds.length || limit <= 0) return [];
  const byId = new Map(groups.map(group => [group.id, group]));
  const result: Group[] = [];
  const seen = new Set<string>();
  for (const id of recentIds) {
    if (seen.has(id)) continue;
    const group = byId.get(id);
    if (!group) continue;
    seen.add(id);
    result.push(group);
    if (result.length >= limit) break;
  }
  return result;
}
