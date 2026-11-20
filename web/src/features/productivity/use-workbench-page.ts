import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { BadgeVariants } from '@/components/ui/badge';
import { usePanelStream } from '@/features/panel-agent/panel-stream-store';
import type { PanelStreamEvent } from '@/features/streams/panel-reducer';
import { api } from '@/shared/api/client';
import {
  useWorkbenchQuery,
  type ActivityRun,
  type PendingEntry,
  type UnreadRow,
} from './workbench-query';

/**
 * 工作台页的视图状态 / 查询 / 动作。
 *
 * 组件只保留模板与接线：本 composable 持有 /api/workbench 查询、未读双 Tab
 * （待处理 / 未读消息）、执行活动双 Tab（运行活动 / 最近执行）、清理动作、
 * 进展摘要流订阅与生成动作，以及秒级时钟。
 */

export type BadgeMeta = {
  label: string;
  variant: NonNullable<BadgeVariants['variant']>;
};

export function useWorkbenchPage() {
  const query = useWorkbenchQuery();
  const data = computed(() => query.data.value);

  const inboxTab = ref<'pending' | 'unread'>('pending');
  const activityTab = ref<'running' | 'recent'>('running');

  const pending = computed<PendingEntry[]>(() =>
    (data.value?.pending ?? []).filter((item) => item.kind === 'interaction'),
  );
  const unread = computed<UnreadRow[]>(() => data.value?.unread ?? []);
  const unreadTotal = computed(() => data.value?.unreadTotal ?? 0);
  const running = computed<ActivityRun[]>(() => data.value?.running ?? []);
  const recent = computed<ActivityRun[]>(() => data.value?.recent ?? []);

  const emptyPendingText = computed(() =>
    query.isPending.value ? '正在加载…' : '暂无待处理卡片',
  );
  const emptyUnreadText = computed(() =>
    query.isPending.value ? '正在加载…' : '没有未读消息',
  );
  const emptyRunningText = computed(() =>
    query.isPending.value ? '正在加载…' : '暂无运行中的成员',
  );
  const emptyRecentText = computed(() =>
    query.isPending.value ? '正在加载…' : '暂无最近执行记录',
  );

  const confirmClean = ref(false);
  const cleaning = ref(false);
  const cleanError = ref('');
  const cleanPendingDisabled = computed(
    () => inboxTab.value !== 'pending' || !pending.value.length,
  );
  const cleanDescription = computed(
    () =>
      `将从工作台隐藏 ${pending.value.length} 张待处理卡片；未读消息不受影响，读过后会自动消失。`,
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

  const workbenchOpen = ref(true);
  const confirmCleanActivity = ref(false);
  const cleaningActivity = ref(false);
  const cleanActivityError = ref('');
  const cleanActivityDisabled = computed(
    () => activityTab.value !== 'recent' || !recent.value.length,
  );
  async function cleanRecentActivity() {
    const items = recent.value;
    if (!items.length || cleaningActivity.value) return;
    cleaningActivity.value = true;
    cleanActivityError.value = '';
    try {
      await api.dismissWorkbench(
        items.map((item) => ({ category: 'activity:recent' as const, id: item.id })),
      );
      confirmCleanActivity.value = false;
      await query.refetch();
    } catch (error) {
      cleanActivityError.value =
        error instanceof Error ? error.message : '清理失败，请稍后重试';
    } finally {
      cleaningActivity.value = false;
    }
  }

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
    () =>
      live.value.stream?.text ?? (summarizing.value ? '' : (data.value?.summary?.text ?? '')),
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

  function formatSeconds(totalSeconds: number) {
    const seconds = Math.max(0, Math.floor(totalSeconds));
    if (seconds < 60) return `${seconds} 秒`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours} 小时 ${minutes} 分`;
  }

  function elapsed(created: string) {
    return formatSeconds((now.value - Date.parse(created)) / 1000);
  }

  function durationText(created: string, ended?: string) {
    const start = Date.parse(created);
    const end = ended ? Date.parse(ended) : Number.NaN;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '';
    return `耗时 ${formatSeconds((end - start) / 1000)}`;
  }

  function relativeTime(iso: string) {
    const time = Date.parse(iso);
    if (!Number.isFinite(time)) return '';
    const diffSeconds = Math.max(0, Math.floor((now.value - time) / 1000));
    if (diffSeconds < 60) return '刚刚';
    const minutes = Math.floor(diffSeconds / 60);
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时前`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days} 天前`;
    const date = new Date(time);
    return `${date.getMonth() + 1}/${date.getDate()}`;
  }

  function shortTime(iso?: string) {
    if (!iso) return '';
    const time = Date.parse(iso);
    if (!Number.isFinite(time)) return '';
    const date = new Date(time);
    const current = new Date(now.value);
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    const sameDay =
      date.getFullYear() === current.getFullYear() &&
      date.getMonth() === current.getMonth() &&
      date.getDate() === current.getDate();
    return sameDay ? `${hh}:${mm}` : `${date.getMonth() + 1}/${date.getDate()} ${hh}:${mm}`;
  }

  function interactionMeta(kind?: string): BadgeMeta {
    if (kind === 'choice') return { label: '待选择', variant: 'info' };
    if (kind === 'input' || kind === 'flow') return { label: '待填写', variant: 'info' };
    return { label: '待确认', variant: 'warning' };
  }

  const statusLabels: Record<string, string> = {
    completed: '已完成',
    failed: '失败',
    cancelled: '已中断',
    unknown: '待核实',
    stopped: '已停止',
    error: '失败',
  };

  function statusMeta(state?: string): BadgeMeta {
    const key = state ?? '';
    if (key === 'failed' || key === 'error') {
      return { label: statusLabels[key] ?? '失败', variant: 'destructive' };
    }
    if (key === 'unknown') {
      return { label: statusLabels.unknown, variant: 'warning' };
    }
    if (key === 'completed') {
      return { label: statusLabels.completed, variant: 'success' };
    }
    return { label: statusLabels[key] ?? (key || '未知'), variant: 'secondary' };
  }

  function pendingSource(item: PendingEntry) {
    if (item.senderName && item.senderName !== item.groupName) {
      return `${item.groupName} · ${item.senderName}`;
    }
    return item.groupName;
  }

  function unreadTitle(row: UnreadRow) {
    if (row.scope === 'panel' && row.groupName && row.groupName !== 'Panel Agent') {
      return `Panel Agent（${row.groupName}）`;
    }
    return row.groupName;
  }

  function recentMeta(run: ActivityRun) {
    const parts: string[] = [];
    const duration = durationText(run.created, run.ended);
    if (duration) parts.push(duration);
    const detail = run.detail?.trim();
    if (detail) parts.push(detail);
    return parts.join(' · ');
  }

  async function summarize() {
    if (summarizing.value) return;
    panelStream.resetSummary();
    generating.value = true;
    error.value = '';
    try {
      await api.summarizeWorkbench();
    } catch (cause) {
      if (!live.value.active)
        error.value = cause instanceof Error ? cause.message : '摘要生成失败';
    } finally {
      generating.value = false;
      void query.refetch();
    }
  }

  return {
    query,
    data,
    inboxTab,
    activityTab,
    pending,
    unread,
    unreadTotal,
    running,
    recent,
    emptyPendingText,
    emptyUnreadText,
    emptyRunningText,
    emptyRecentText,
    confirmClean,
    cleaning,
    cleanError,
    cleanPendingDisabled,
    cleanDescription,
    cleanEntries,
    workbenchOpen,
    confirmCleanActivity,
    cleaningActivity,
    cleanActivityError,
    cleanActivityDisabled,
    cleanRecentActivity,
    generating,
    error,
    live,
    summarizing,
    summaryStale,
    summaryText,
    summaryPhase,
    elapsed,
    durationText,
    relativeTime,
    shortTime,
    interactionMeta,
    statusLabels,
    statusMeta,
    pendingSource,
    unreadTitle,
    recentMeta,
    summarize,
  };
}
