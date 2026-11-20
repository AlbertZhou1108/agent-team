import { useQuery } from '@tanstack/vue-query';
import { QUERY_POLLING } from '@/features/queries';

/**
 * 工作台投影的唯一 HTTP 入口。
 *
 * 工作台页与侧栏红点都要这份数据，两边必须共用同一个 query key 和同一个 fetcher：
 * 同一个 key 挂两个 queryFn 时，谁先挂载就用谁，行为会随挂载顺序变化 —— 这种 bug
 * 极难复现，所以在这里收成单写者。
 */

export const WORKBENCH_QUERY_KEY = ['workbench'] as const;

/** 未读行：一个会话一行。群消息与面板私聊各自一套编号。 */
export type UnreadRow = {
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

export type PendingEntry = {
  id: string;
  kind: string;
  interactionKind?: string;
  title: string;
  groupName: string;
  senderName?: string | null;
  conversation: string;
  created: string;
  path: string;
};

export type ActivityRun = {
  id: string;
  name: string;
  groupName: string;
  created: string;
  ended?: string;
  queued?: number;
  state?: string;
  detail?: string | null;
  path: string;
};

export type Workbench = {
  pending: PendingEntry[];
  unread: UnreadRow[];
  unreadTotal: number;
  running: ActivityRun[];
  recent: ActivityRun[];
  panelReady: boolean;
  summary: { id: string; text: string; created: string } | null;
  summaryRequest: { id: string; created: string } | null;
};

export async function fetchWorkbench({ signal }: { signal?: AbortSignal }) {
  const response = await fetch('/api/workbench', { signal });
  if (!response.ok) throw Error('工作台加载失败');
  return response.json() as Promise<Workbench>;
}

export function useWorkbenchQuery() {
  return useQuery({
    queryKey: WORKBENCH_QUERY_KEY,
    queryFn: fetchWorkbench,
    refetchInterval: QUERY_POLLING.slow,
    refetchOnWindowFocus: false,
  });
}
