import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { QUERY_POLLING } from '@/features/queries';

/**
 * 未读索引：把工作台投影里的 unread 行按团队摊平，供侧栏红点与面板标题使用。
 * 与工作台页共用 ['workbench'] 这个 query key，同一时刻只会有一条在跑。
 */

type UnreadRow = {
  id: string;
  scope: 'group' | 'panel';
  scopeId: string;
  conversation: string;
  title: string;
  groupName: string;
  count: number;
  latest: string;
  latestSeq: number;
  path: string;
};

export function useUnreadIndex() {
  const query = useQuery({
    queryKey: ['workbench'],
    queryFn: async ({ signal }) => {
      const response = await fetch('/api/workbench', { signal });
      if (!response.ok) throw Error('工作台加载失败');
      return response.json() as Promise<{ unread: UnreadRow[]; unreadTotal: number }>;
    },
    refetchInterval: QUERY_POLLING.slow,
    refetchOnWindowFocus: false,
  });
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
