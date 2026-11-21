import { computed } from 'vue';
import { useWorkbenchQuery } from './workbench-query';

function groupIdFromPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const match = /^\/groups\/([^/?#]+)/.exec(path);
  if (!match?.[1] || match[1] === 'new') return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/**
 * 未读与活跃投影索引：把工作台投影里的 unread / running / recent 行按团队摊平，
 * 供侧栏红点、团队二级面板未读角标与活跃时间排序共用。
 *
 * 不自己发请求 —— 数据来自 workbench-query.ts 的同一个查询实例。
 * 同一个 query key 挂两个 fetcher 时，行为会随挂载顺序变化，所以这里只读。
 */
export function useUnreadIndex() {
  const query = useWorkbenchQuery();
  const panelByTeam = computed(() => {
    const counts = new Map<string, number>();
    for (const row of query.data.value?.unread ?? []) {
      if (row.scope !== 'panel') continue;
      counts.set(row.conversation.slice('panel:'.length), row.count);
    }
    return counts;
  });
  const panelTotal = computed(() =>
    [...panelByTeam.value.values()].reduce((sum, count) => sum + count, 0),
  );
  const groupByTeam = computed(() => {
    const counts = new Map<string, number>();
    for (const row of query.data.value?.unread ?? []) {
      if (row.scope !== 'group') continue;
      counts.set(row.scopeId, (counts.get(row.scopeId) ?? 0) + row.count);
    }
    return counts;
  });
  const activityByTeam = computed(() => {
    const timestamps = new Map<string, number>();
    const record = (groupId: string | undefined, iso: string | undefined) => {
      if (!groupId || !iso) return;
      const ms = Date.parse(iso);
      if (!Number.isFinite(ms)) return;
      if (ms > (timestamps.get(groupId) ?? 0)) timestamps.set(groupId, ms);
    };
    const data = query.data.value;
    if (!data) return timestamps;
    for (const row of data.unread ?? []) {
      if (row.scope === 'group') record(row.scopeId, row.latest);
    }
    for (const run of data.running ?? []) {
      record(groupIdFromPath(run.path), run.ended ?? run.created);
    }
    for (const run of data.recent ?? []) {
      record(groupIdFromPath(run.path), run.ended ?? run.created);
    }
    return timestamps;
  });
  return { panelByTeam, panelTotal, groupByTeam, activityByTeam };
}
