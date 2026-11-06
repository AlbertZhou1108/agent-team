import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { QUERY_POLLING } from '@/features/queries';
import { usePanelStream } from '@/features/panel-agent/panel-stream-store';
import type { PanelStreamEvent } from '@/features/streams/panel-reducer';
import { api } from '@/shared/api/client';

/**
 * 工作台页的视图状态 / 查询 / 动作（从 HomeWorkbench.vue 纯搬迁）。
 *
 * 组件只保留模板与接线：本 composable 持有 /api/workbench 查询、三类待办合并
 * 与过滤、清理动作、执行活动 tab、进展摘要流订阅与生成动作，以及秒级时钟。
 * 查询 key / 轮询间隔 / 失效语义保持原样（轮询预算来自 QUERY_POLLING）。
 */

export type Activity = {
  id: string;
  name: string;
  groupName: string;
  created: string;
  ended?: string;
  queued?: number;
  state?: string;
  path: string;
};

export type Workbench = {
  pending: {
    id: string;
    kind: string;
    title: string;
    groupName: string;
    created: string;
    path: string;
  }[];
  waiting: {
    id: string;
    title: string;
    groupName: string;
    recipientName: string;
    recipientKind: string;
    created: string;
    path: string;
  }[];
  agentWaiting: {
    id: string;
    title: string;
    groupName: string;
    senderName: string;
    senderKind: string;
    recipientName: string;
    recipientKind: string;
    created: string;
    path: string;
  }[];
  running: Activity[];
  recent: Activity[];
  panelReady: boolean;
  summary: { id: string; text: string; created: string } | null;
  summaryRequest: { id: string; created: string } | null;
};

export type EntrySource = 'interaction' | 'user' | 'agent';
export type WorkbenchEntry = {
  id: string;
  source: EntrySource;
  title: string;
  groupName: string;
  created: string;
  path: string;
  recipientName?: string;
  senderName?: string;
};

export function useWorkbenchPage() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['workbench'],
    queryFn: async ({ signal }) => {
      const response = await fetch('/api/workbench', { signal });
      if (!response.ok) throw Error('工作台加载失败');
      return response.json() as Promise<Workbench>;
    },
    refetchInterval: QUERY_POLLING.slow,
    refetchOnWindowFocus: false,
  });
  const data = computed(() => query.data.value);
  const pending = computed(() =>
    (data.value?.pending ?? []).filter((item) => item.kind === 'interaction'),
  );
  const waiting = computed(() => data.value?.waiting ?? []);
  const agentWaiting = computed(() => data.value?.agentWaiting ?? []);
  const filter = ref<'all' | EntrySource>('all');
  const total = computed(
    () => pending.value.length + waiting.value.length + agentWaiting.value.length,
  );
  const entries = computed<WorkbenchEntry[]>(() => {
    const all: WorkbenchEntry[] = [
      ...pending.value.map((item) => ({ ...item, source: 'interaction' as const })),
      ...waiting.value.map((item) => ({ ...item, source: 'user' as const })),
      ...agentWaiting.value.map((item) => ({ ...item, source: 'agent' as const })),
    ];
    return filter.value === 'all'
      ? all
      : all.filter((item) => item.source === filter.value);
  });
  const emptyText = computed(() => {
    if (query.isPending.value) return '正在加载…';
    if (filter.value === 'interaction') return '暂无待你处理的互动卡';
    if (filter.value === 'user') return '暂无等待 Agent 回复的指令';
    if (filter.value === 'agent') return '暂无 Agent 之间的等待';
    return '暂无待处理事项';
  });
  const selectedLabel = computed(() => {
    if (filter.value === 'all') return '全部';
    if (filter.value === 'interaction') return '待你处理';
    if (filter.value === 'user') return '等待回复';
    return 'Agent 等待';
  });
  const sourceLabel: Record<EntrySource, string> = {
    interaction: '等待答复',
    user: '你的指令',
    agent: 'Agent 请求',
  };

  const confirmClean = ref(false);
  const cleaning = ref(false);
  const cleanError = ref('');
  const cleanDescription = computed(() => {
    const scope =
      filter.value === 'all'
        ? '当前列表'
        : filter.value === 'interaction'
          ? '待你处理'
          : filter.value === 'user'
            ? '等待回复'
            : 'Agent 等待';
    const count = entries.value.length;
    const interactionHint = entries.value.some((item) => item.source === 'interaction')
      ? '\n互动卡仍保持待处理，可在团队会话中继续处理。'
      : '';
    return `将从工作台隐藏${scope}的 ${count} 项；消息记录不会删除。${interactionHint}`;
  });
  async function cleanEntries() {
    if (!entries.value.length || cleaning.value) return;
    cleaning.value = true;
    cleanError.value = '';
    try {
      await api.dismissWorkbench(
        entries.value.map((item) => ({
          category:
            item.source === 'interaction'
              ? 'interaction'
              : item.source === 'user'
                ? 'waiting:user'
                : 'waiting:agent',
          id: item.id,
        })),
      );
      confirmClean.value = false;
      await query.refetch();
    } catch (error) {
      cleanError.value = error instanceof Error ? error.message : '清理失败，请稍后重试';
    } finally {
      cleaning.value = false;
    }
  }

  const workbenchOpen = ref(true);
  const confirmCleanActivity = ref(false);
  const cleaningActivity = ref(false);
  const cleanActivityError = ref('');
  async function cleanRecentActivity() {
    const items = data.value?.recent ?? [];
    if (!items.length || cleaningActivity.value) return;
    cleaningActivity.value = true;
    cleanActivityError.value = '';
    try {
      await api.dismissWorkbench(items.map((item) => ({ category: 'activity:recent' as const, id: item.id })));
      confirmCleanActivity.value = false;
      await query.refetch();
    } catch (error) {
      cleanActivityError.value = error instanceof Error ? error.message : '清理失败，请稍后重试';
    } finally {
      cleaningActivity.value = false;
    }
  }

  const activityTab = ref('running');
  const generating = ref(false);
  const error = ref('');
  // 摘要流不再是本组件自己的连接：PanelAgentPanel 与工作台共用 panel-stream-store
  // 的单例 EventSource，live 只读统一 reducer 结算后的摘要状态。
  const panelStream = usePanelStream();
  const live = computed(() => panelStream.state.value.summary);
  let releasePanelStream: () => void = () => {};
  let stopPanelEvents: () => void = () => {};
  let stopPanelOpen: () => void = () => {};
  const onPanelEvent = (event: PanelStreamEvent) => {
    if (event.type === 'start' && event.stream?.homeSummary) error.value = '';
    if (
      !event.stream?.homeSummary ||
      !['complete', 'error', 'cancelled'].includes(event.type)
    )
      return;
    if (event.type === 'error' || event.type === 'cancelled')
      error.value =
        event.type === 'cancelled'
          ? '摘要生成已中断，保留上次结果。'
          : '摘要生成失败，保留上次结果。';
    void query.refetch();
  };
  onMounted(() => {
    releasePanelStream = panelStream.retain();
    stopPanelOpen = panelStream.subscribeOpen(() => {
      void query.refetch();
    });
    stopPanelEvents = panelStream.subscribe(onPanelEvent);
  });
  onBeforeUnmount(() => {
    stopPanelEvents();
    stopPanelOpen();
    releasePanelStream();
  });
  watch(
    [() => data.value?.summary, () => live.value.active],
    ([summary]) => {
      if (
        summary &&
        live.value.stream &&
        !live.value.active &&
        summary.created >= live.value.stream.created
      )
        panelStream.resetSummary();
    },
  );
  const summarizing = computed(() => generating.value || live.value.active);
  // 摘要是主控生成的快照:超过一天提示可能过期(刷新会发起真实模型回合,不做自动刷新)。
  const summaryStale = computed(() => {
    const created = data.value?.summary?.created;
    if (!created) return false;
    return Date.now() - new Date(created).getTime() > 24 * 3600_000;
  });
  const summaryText = computed(
    () => live.value.stream?.text ?? (summarizing.value ? '' : (data.value?.summary?.text ?? '')),
  );
  const summaryPhase = computed(
    () =>
      ({
        accepted: '正在读取团队进展…',
        thinking: '正在整理摘要…',
        tool: '正在读取团队信息…',
        writing: '正在生成摘要…',
      })[live.value.stream?.runPhase ?? 'accepted'],
  );

  const now = ref(Date.now());
  const clock = setInterval(() => {
    now.value = Date.now();
  }, 1000);
  onBeforeUnmount(() => clearInterval(clock));
  function elapsed(created: string) {
    const seconds = Math.max(
      0,
      Math.floor((now.value - Date.parse(created)) / 1000),
    );
    return seconds < 60
      ? `${seconds} 秒`
      : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  }
  const privateBusy = computed(() =>
    data.value?.running.some((run) => run.path === '/agent'),
  );
  const statusLabels: Record<string, string> = {
    completed: '已完成',
    failed: '失败',
    cancelled: '已中断',
    unknown: '待核实',
    stopped: '已停止',
    error: '失败',
  };
  async function summarize() {
    if (summarizing.value || privateBusy.value) return;
    panelStream.resetSummary();
    generating.value = true;
    error.value = '';
    try {
      await api.panelMessage(
        `[主页进展摘要]\n请只读查看所有未归档团队的近期消息，汇总最近完成的工作、已有结果、尚未解决的问题和下一步建议。不要派发任务或修改配置。每项结论附原消息链接，团队消息使用 /groups/团队ID?message=消息ID。没有证据的内容不要推断。直接输出适合在主页阅读的简短 Markdown 摘要。`,
        null,
        { clientMessageId: crypto.randomUUID() },
      );
      await client.invalidateQueries({ queryKey: ['panel-agent'] });
    } catch (cause) {
      if (!live.value.active)
        error.value = cause instanceof Error ? cause.message : '摘要生成失败';
    } finally {
      generating.value = false;
      void query.refetch();
    }
  }

  return {
    query, data, pending, waiting, agentWaiting, filter, total, entries,
    emptyText, selectedLabel, sourceLabel, confirmClean, cleaning, cleanError,
    cleanDescription, cleanEntries, workbenchOpen, confirmCleanActivity,
    cleaningActivity, cleanActivityError, cleanRecentActivity, activityTab,
    generating, error, live, summarizing, summaryStale, summaryText,
    summaryPhase, elapsed, privateBusy, statusLabels, summarize,
  };
}
