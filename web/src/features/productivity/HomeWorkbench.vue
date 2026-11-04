<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { RouterLink } from 'vue-router';
import { frameBatch } from '@/features/messages/frame-batch';
import {
  reduceSummaryStream,
  type SummaryStreamState,
  type SummaryStreamEvent,
} from './summary-stream';
import { api } from '@/shared/api/client';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Disclosure } from '@/components/ui/disclosure';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import ConfirmDialog from '@/components/panel/ConfirmDialog.vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Empty, EmptyDescription } from '@/components/ui/empty';
import MarkdownRenderer from '@/components/ai-elements/MarkdownRenderer.vue';
import { LoaderCircle, RefreshCw } from '@lucide/vue';
import WorkbenchCleanButton from './WorkbenchCleanButton.vue';
type Activity = {
  id: string;
  name: string;
  groupName: string;
  created: string;
  ended?: string;
  queued?: number;
  state?: string;
  path: string;
};
type Workbench = {
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
const client = useQueryClient();
const query = useQuery({
  queryKey: ['workbench'],
  queryFn: async ({ signal }) => {
    const response = await fetch('/api/workbench', { signal });
    if (!response.ok) throw Error('工作台加载失败');
    return response.json() as Promise<Workbench>;
  },
  refetchInterval: 2000,
  refetchOnWindowFocus: false,
});
const data = computed(() => query.data.value);
const pending = computed(() =>
  (data.value?.pending ?? []).filter((item) => item.kind === 'interaction'),
);
const waiting = computed(() => data.value?.waiting ?? []);
const agentWaiting = computed(() => data.value?.agentWaiting ?? []);
type EntrySource = 'interaction' | 'user' | 'agent';
type WorkbenchEntry = {
  id: string;
  source: EntrySource;
  title: string;
  groupName: string;
  created: string;
  path: string;
  recipientName?: string;
  senderName?: string;
};
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
    await api.dismissWorkbench(items.map(item => ({ category: 'activity:recent' as const, id: item.id })));
    confirmCleanActivity.value = false;
    await query.refetch();
  } catch (error) {
    cleanActivityError.value = error instanceof Error ? error.message : '清理失败，请稍后重试';
  } finally { cleaningActivity.value = false; }
}
const activityTab = ref('running');
const generating = ref(false);
const error = ref('');
const live = ref<SummaryStreamState>({ stream: null, active: false });
let events: EventSource | null = null;
const streamEvents = frameBatch<SummaryStreamEvent>(
  (event) => {
    const previous = live.value;
    live.value = reduceSummaryStream(previous, event);
    if (
      live.value !== previous &&
      event.type === 'start' &&
      event.stream?.homeSummary
    )
      error.value = '';
    if (
      live.value !== previous &&
      event.stream?.homeSummary &&
      ['complete', 'error', 'cancelled'].includes(event.type)
    ) {
      if (event.type === 'error' || event.type === 'cancelled')
        error.value =
          event.type === 'cancelled'
            ? '摘要生成已中断，保留上次结果。'
            : '摘要生成失败，保留上次结果。';
      void query.refetch();
    }
  },
  requestAnimationFrame,
  cancelAnimationFrame,
);
function acceptStream(event: Event) {
  try {
    const payload = JSON.parse(
      (event as MessageEvent<string>).data,
    ) as SummaryStreamEvent;
    streamEvents.push(payload);
    if (payload.type !== 'delta' && payload.type !== 'reasoning-delta')
      streamEvents.flush();
  } catch {
    /* reconnect snapshots restore valid state */
  }
}
onMounted(() => {
  events = new EventSource('/api/panel-agent/events');
  events.addEventListener('panel-stream', acceptStream);
  events.onopen = () => {
    void query.refetch();
  };
});
onBeforeUnmount(() => {
  events?.close();
  streamEvents.dispose();
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
      live.value = { stream: null, active: false };
  },
);
const summarizing = computed(() => generating.value || live.value.active);
const summaryText = computed(
  () => live.value.stream?.text ?? (summarizing.value ? '' : data.value?.summary?.text ?? ''),
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
  live.value = { stream: null, active: false };
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
</script>
<template>
  <section class="flex min-w-0 flex-col gap-4" aria-labelledby="workbench-title">
    <Alert v-if="query.isError.value" variant="destructive"
      ><AlertDescription
        >工作台加载失败
        <Button variant="outline" size="sm" @click="query.refetch()"
          >重试</Button
        ></AlertDescription
      ></Alert
    >
    <Disclosure v-model:open="workbenchOpen" :heading-level="2">
      <template #summary><span id="workbench-title">工作台</span></template>
      <template v-if="$slots.actions" #actions><slot name="actions" /></template>
      <div class="flex min-w-0 flex-col gap-4">
        <div class="grid min-w-0 gap-4 lg:grid-cols-2">
      <Card size="compact" class="home-card min-w-0">
        <CardHeader class="flex flex-row flex-wrap items-center justify-between gap-3">
          <CardTitle
            >待处理
            <Badge variant="secondary">{{ entries.length }}</Badge></CardTitle
          >
          <div class="flex min-w-0 items-center gap-2">
            <Select v-model="filter">
              <SelectTrigger class="w-36" aria-label="选择待处理范围"
                ><span data-slot="select-value" class="min-w-0 truncate">{{
                  selectedLabel
                }}</span></SelectTrigger
              >
              <SelectContent>
                <SelectItem value="all">全部</SelectItem>
                <SelectItem value="interaction"
                  >待你处理</SelectItem
                >
                <SelectItem value="user"
                  >等待回复</SelectItem
                >
                <SelectItem value="agent"
                  >Agent 等待</SelectItem
                >
              </SelectContent>
            </Select>
            <WorkbenchCleanButton
              :disabled="!entries.length"
              :busy="cleaning"
              label="清理当前列表"
              description="从工作台隐藏当前列表（不删除消息）"
              @click="cleanError = ''; confirmClean = true"
            />
          </div>
        </CardHeader>
        <CardContent class="home-card-scroll flex min-h-0 flex-1 flex-col gap-3">
          <Empty v-if="!entries.length"
            ><EmptyDescription>{{ emptyText }}</EmptyDescription></Empty
          >
          <div v-else class="flex flex-col gap-2">
            <Button
              v-for="item in entries"
              :key="`${item.source}:${item.id}`"
              as-child
              variant="ghost"
              class="h-auto justify-start"
              ><RouterLink :to="item.path"
                ><span class="flex min-w-0 flex-col gap-1"
                  ><span class="flex flex-wrap items-center gap-2"
                    ><Badge variant="outline">{{ sourceLabel[item.source] }}</Badge
                    ><span class="text-xs text-muted-foreground"
                      >{{ item.groupName
                      }}<template v-if="item.source === 'agent'">
                        · {{ item.senderName }} → {{ item.recipientName }}</template
                      ><template v-else-if="item.source === 'user'">
                        · {{ item.recipientName }}</template
                      ></span
                    ></span
                  ><span
                    class="line-clamp-2 whitespace-normal break-all text-left"
                    >{{ item.title }}</span
                  ><span
                    v-if="item.source !== 'interaction'"
                    class="text-xs text-muted-foreground"
                    >已等待 {{ elapsed(item.created) }}</span
                  ></span
                ></RouterLink
              ></Button
            >
          </div>
        </CardContent>
        <ConfirmDialog
          :open="confirmClean"
          title="清理当前待处理项？"
          :description="cleanDescription"
          confirm-text="清理"
          destructive
          :busy="cleaning"
          :error="cleanError"
          @cancel="confirmClean = false"
          @confirm="cleanEntries"
        />
      </Card>
          <Card size="compact" class="home-card min-w-0">
            <Tabs v-model="activityTab" class="flex min-h-0 flex-1 flex-col gap-(--card-gap)">
              <CardHeader class="flex flex-row flex-wrap items-center justify-between gap-3">
                <CardTitle>执行活动</CardTitle>
                <div class="flex items-center gap-2"><TabsList class="grid w-fit grid-cols-2">
                  <TabsTrigger value="running">运行活动</TabsTrigger>
                  <TabsTrigger value="recent">最近执行</TabsTrigger>
                </TabsList><WorkbenchCleanButton v-if="activityTab === 'recent'" :disabled="!data?.recent.length" :busy="cleaningActivity" label="清理最近执行" description="从工作台隐藏最近执行（不删除执行记录）" @click="cleanActivityError = ''; confirmCleanActivity = true" /></div>
              </CardHeader>
              <CardContent class="home-card-scroll flex min-h-0 flex-1 flex-col gap-3">
                <TabsContent value="running" class="flex min-h-0 flex-1 flex-col gap-3">
                  <Empty v-if="!data?.running.length"
                    ><EmptyDescription>{{
                      query.isPending.value ? '正在加载…' : '暂无运行中的成员'
                    }}</EmptyDescription></Empty
                  >
                  <Button
                    v-for="run in data?.running ?? []"
                    :key="run.id"
                    as-child
                    variant="ghost"
                    class="h-auto justify-start"
                    ><RouterLink :to="run.path"
                      ><span class="flex w-full min-w-0 flex-col gap-1"
                        ><span class="truncate"
                          >{{ run.groupName }} · {{ run.name }}</span
                        ><span class="text-xs text-muted-foreground"
                          >已运行 {{ elapsed(run.created) }} · 排队
                          {{ run.queued ?? 0 }} 条</span
                        ></span
                      ></RouterLink
                    ></Button
                  >
                </TabsContent>
                <TabsContent value="recent" class="flex min-h-0 flex-1 flex-col gap-1">
                  <div class="flex max-h-64 flex-col gap-1 overflow-y-auto">
                    <Button
                      v-for="run in data?.recent ?? []"
                      :key="run.id"
                      as-child
                      variant="ghost"
                      class="h-auto justify-start"
                      ><RouterLink :to="run.path"
                        ><span class="flex min-w-0 flex-col gap-1"
                          ><span class="truncate"
                            >{{ run.groupName }} · {{ run.name }}</span
                          ><span class="text-xs text-muted-foreground"
                            >{{ statusLabels[run.state ?? ''] ?? run.state }} ·
                            {{
                              new Date(run.ended ?? run.created).toLocaleString()
                            }}</span
                          ></span
                        ></RouterLink
                      ></Button
                    >
                    <p
                      v-if="!data?.recent.length"
                      class="text-sm text-muted-foreground"
                    >
                      暂无数据
                    </p>
                  </div>
                </TabsContent>
              </CardContent>
            </Tabs><ConfirmDialog :open="confirmCleanActivity" title="清理最近执行？" :description="`将从工作台隐藏当前最近执行的 ${data?.recent.length ?? 0} 项；执行记录仍保留。`" confirm-text="清理" destructive :busy="cleaningActivity" :error="cleanActivityError" @cancel="confirmCleanActivity = false" @confirm="cleanRecentActivity" />
          </Card>
        </div>
    <Card size="compact" class="home-card min-w-0">
      <CardHeader class="flex flex-row items-center justify-between gap-3">
        <CardTitle>进展摘要</CardTitle>
        <div class="flex shrink-0 items-center gap-2">
          <Button
            v-if="data?.panelReady"
            variant="ghost"
            size="icon-sm"
            :disabled="summarizing || privateBusy"
            :aria-label="summarizing ? '正在刷新摘要' : '刷新摘要'"
            :title="privateBusy ? 'Panel Agent 正在运行' : '刷新摘要'"
            @click="summarize"
          >
            <LoaderCircle v-if="summarizing" class="animate-spin" /><RefreshCw
              v-else
            />
          </Button>
        </div>
      </CardHeader>
      <CardContent class="home-card-scroll flex min-h-0 flex-1 flex-col gap-3">
        <Alert v-if="error" variant="destructive"
          ><AlertDescription>{{ error }}</AlertDescription></Alert
        >
        <p
          v-if="summarizing"
          class="flex items-center gap-2 text-sm text-muted-foreground"
          role="status"
        >
          <LoaderCircle class="size-4 animate-spin" />{{ summaryPhase }}
        </p>
        <template v-if="summaryText"
          ><p
            v-if="!summarizing && !live.stream?.text && data?.summary"
            class="text-xs text-muted-foreground"
          >
            生成于 {{ new Date(data.summary.created).toLocaleString() }}
          </p>
          <div
            role="region"
            aria-label="进展摘要内容"
            tabindex="0"
          >
            <MarkdownRenderer
              :content="summaryText"
              :defer="live.active"
            /></div
        ></template>
        <p v-else-if="!summarizing" class="text-sm text-muted-foreground">
          {{
            summarizing || privateBusy
              ? '摘要生成后会显示在这里。'
              : '点击刷新图标，汇总全部团队的近期进展。'
          }}
        </p>
      </CardContent></Card
    >
      </div>
    </Disclosure>
  </section>
</template>
