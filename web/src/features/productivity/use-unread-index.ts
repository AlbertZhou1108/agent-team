import { computed } from 'vue';
import { useWorkbenchQuery } from './workbench-query';

/**
 * 未读索引：把工作台投影里的 unread 行按团队摊平，供侧栏红点与页面计数使用。
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
  return { panelByTeam, panelTotal };
}
