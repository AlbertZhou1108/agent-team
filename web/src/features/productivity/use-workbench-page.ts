import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useQueryClient } from '@tanstack/vue-query';
import { usePanelStream } from '@/features/panel-agent/panel-stream-store';
import type { PanelStreamEvent } from '@/features/streams/panel-reducer';
import { api } from '@/shared/api/client';
import { useWorkbenchQuery, type Workbench } from './workbench-query';

/**
 * 工作台页的视图状态 / 查询 / 动作（从 HomeWorkbench.vue 纯搬迁）。
 *
 * 组件只保留模板与接线：本 composable 持有 /api/workbench 查询、三类待办合并
 * 与过滤、清理动作、执行活动 tab、进展摘要流订阅与生成动作，以及秒级时钟。
 * 查询本身在 workbench-query.ts：工作台与侧栏共用同一个 key 与 fetcher。
 */

/** 未读卡的一行：一个会话，同时挂未读条数与待处理卡数。 */
export type InboxRow = {
  key: string;
  title: string;
  groupName: string;
  path: string;
  unread: number;
  cards: number;
  cardTitle?: string;
  created: string;
};

/** 「没回音」的一行：等待回复的指令，或 Agent 之间的等待。 */
export type StaleEntry = {
  id: string;
  source: 'user' | 'agent';
  title: string;
  groupName: string;
  created: string;
  path: string;
  recipientName?: string;
  senderName?: string;
};

export function useWorkbenchPage() {
  const client = useQueryClient();
  const query = useWorkbenchQuery();
  const data = computed(() => query.data.value);
  const pending = computed(() =>
    (data.value?.pending ?? []).filter((item) => item.kind === 'interaction'),
  );
  const waiting = computed(() => data.value?.waiting ?? []);
  const agentWaiting = computed(() => data.value?.agentWaiting ?? []);
  // 未读卡：一个会话一行，把「未读条数」和「待处理卡数」并到同一行，
  // 这样徽标显示的数字（卡片数 + 未读条数）在列表里能逐行对上账。
  const inbox = computed<InboxRow[]>(() => {
    const rows = new Map<string, InboxRow>();
    for (const item of data.value?.unread ?? []) {
      rows.set(item.conversation, {
        key: item.conversation,
        title: item.title,
        groupName: item.groupName,
        path: item.path,
        unread: item.count,
        cards: 0,
        created: item.latest,
      });
    }
    for (const item of pending.value) {
      const row = rows.get(item.conversation);
      if (row) {
        row.cards += 1;
        row.cardTitle ??= item.title;
        if (item.created > row.created) row.created = item.created;
      } else {
        rows.set(item.conversation, {
          key: item.conversation,
          title: item.groupName,
          groupName: item.groupName,
          path: item.path,
          unread: 0,
          cards: 1,
          cardTitle: item.title,
          created: item.created,
        });
      }
    }
    return [...rows.values()].sort((a, b) => b.created.localeCompare(a.created));
  });
  const inboxTotal = computed(() => (data.value?.unreadTotal ?? 0) + pending.value.length);
  // 「没回音」不是未读：你发出去还没回复的指令、以及 Agent 之间的等待，
  // 都归到执行活动那一侧，只做审计，不点亮徽标。
  const stale = computed<StaleEntry[]>(() => [
    ...waiting.value.map((item) => ({ ...item, source: 'user' as const })),
    ...agentWaiting.value.map((item) => ({ ...item, source: 'agent' as const })),
  ]);
  const staleLabel: Record<StaleEntry['source'], string> = { user: '你的指令', agent: 'Agent 请求' };
  const emptyText = computed(() =>
    query.isPending.value ? '正在加载…' : '没有未读',
  );

  const confirmClean = ref(false);
  const cleaning = ref(false);
  const cleanError = ref('');
  const cleanDescription = computed(
    () => `将从工作台隐藏 ${pending.value.length} 张待处理卡片；未读消息不受影响，读过后会自动消失。`,
  );
  async function cleanEntries() {
    if (!pending.value.length || cleaning.value) return;
    cleaning.value = true;
    cleanError.value = '';
    try {
      await api.dismissWorkbench(
        pending.value.map((item) => ({ category: 'interaction' as const, id: item.id })),
      );
      confirmClean.value = false;
      await query.refetch();
    } catch (error) {
      cleanError.value = error instanceof Error ? error.message : '清理失败，请稍后重试';
    } finally {
      cleaning.value = false;
    }
  }

  const confirmCleanStale = ref(false);
  const cleaningStale = ref(false);
  const cleanStaleError = ref('');
  const cleanStaleDescription = computed(
    () => `将从工作台隐藏 ${stale.value.length} 项没回音的记录；消息记录不会删除。`,
  );
  async function cleanStale() {
    if (!stale.value.length || cleaningStale.value) return;
    cleaningStale.value = true;
    cleanStaleError.value = '';
    try {
      await api.dismissWorkbench(
        stale.value.map((item) => ({
          category: item.source === 'user' ? ('waiting:user' as const) : ('waiting:agent' as const),
          id: item.id,
        })),
      );
      confirmCleanStale.value = false;
      await query.refetch();
    } catch (error) {
      cleanStaleError.value = error instanceof Error ? error.message : '清理失败，请稍后重试';
    } finally {
      cleaningStale.value = false;
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
    query, data, pending, waiting, agentWaiting, inbox, inboxTotal, stale, staleLabel,
    emptyText, confirmClean, cleaning, cleanError, cleanDescription, cleanEntries,
    confirmCleanStale, cleaningStale, cleanStaleError, cleanStaleDescription, cleanStale,
    workbenchOpen, confirmCleanActivity,
    cleaningActivity, cleanActivityError, cleanRecentActivity, activityTab,
    generating, error, live, summarizing, summaryStale, summaryText,
    summaryPhase, elapsed, privateBusy, statusLabels, summarize,
  };
}
