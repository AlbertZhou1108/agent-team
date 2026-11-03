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
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Empty, EmptyDescription } from '@/components/ui/empty';
import MarkdownRenderer from '@/components/ai-elements/MarkdownRenderer.vue';
import { LoaderCircle, RefreshCw } from '@lucide/vue';
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
const workbenchOpen = ref(true);
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
      <Card size="compact"
        ><CardHeader
          ><CardTitle
            >待处理
            <Badge variant="secondary">{{
              pending.length + waiting.length
            }}</Badge></CardTitle
          ></CardHeader
        ><CardContent>
          <Empty v-if="!pending.length && !waiting.length"
            ><EmptyDescription>{{
              query.isPending.value ? '正在加载…' : '暂无待处理事项'
            }}</EmptyDescription></Empty
          >
          <div v-else class="flex max-h-72 flex-col gap-2 overflow-y-auto">
            <Button
              v-for="item in pending"
              :key="item.id"
              as-child
              variant="ghost"
              class="h-auto justify-start"
              ><RouterLink :to="item.path"
                ><span class="flex min-w-0 flex-col gap-1"
                  ><span class="flex flex-wrap items-center gap-2"
                    ><Badge variant="outline">等待答复</Badge
                    ><span class="text-xs text-muted-foreground">{{
                      item.groupName
                    }}</span></span
                  ><span
                    class="line-clamp-2 whitespace-normal break-all text-left"
                    >{{ item.title }}</span
                  ></span
                ></RouterLink
              ></Button
            >
            <template v-if="waiting.length">
              <p class="pt-1 text-xs text-muted-foreground">等待 Agent 回复</p>
              <Button
                v-for="item in waiting"
                :key="item.id"
                as-child
                variant="ghost"
                class="h-auto justify-start"
                ><RouterLink :to="item.path"
                  ><span class="flex min-w-0 flex-col gap-1"
                    ><span class="flex flex-wrap items-center gap-2"
                      ><Badge variant="outline">等待回复</Badge
                      ><span class="text-xs text-muted-foreground"
                        >{{ item.groupName }} · {{ item.recipientName }}</span
                      ></span
                    ><span
                      class="line-clamp-2 whitespace-normal break-all text-left"
                      >{{ item.title }}</span
                    ><span class="text-xs text-muted-foreground"
                      >已等待 {{ elapsed(item.created) }}</span
                    ></span
                  ></RouterLink
                ></Button
              >
            </template>
          </div>
        </CardContent></Card
      >
          <Card size="compact">
            <Tabs v-model="activityTab" class="flex flex-col gap-(--card-gap)">
              <CardHeader class="flex flex-row flex-wrap items-center justify-between gap-3">
                <CardTitle>执行活动</CardTitle>
                <TabsList class="grid w-fit grid-cols-2">
                  <TabsTrigger value="running">运行活动</TabsTrigger>
                  <TabsTrigger value="recent">最近执行</TabsTrigger>
                </TabsList>
              </CardHeader>
              <CardContent class="flex min-w-0 flex-col gap-3">
                <TabsContent value="running" class="flex flex-col gap-3">
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
                <TabsContent value="recent" class="flex flex-col gap-1">
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
            </Tabs>
          </Card>
        </div>
    <Card size="compact">
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
      <CardContent class="flex min-w-0 flex-col gap-3">
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
            class="max-h-96 overflow-y-auto overscroll-contain"
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
