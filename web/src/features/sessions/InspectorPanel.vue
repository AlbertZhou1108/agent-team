<script setup lang="ts">
import { Disclosure } from '@/components/ui/disclosure';
import { computed, ref } from 'vue';
import { Activity, ArrowLeftRight, Braces, Gauge, LoaderCircle } from '@lucide/vue';
import type { SessionEndpoint } from '@/shared/api/raw-types';
import type { HistoryRow } from '@/shared/api/raw-types';
import type { TurnSummary } from '@/shared/api/raw-types';
import TraceTimeline from '@/components/ai-elements/TraceTimeline.vue';
import CodeBlock from '@/components/ai-elements/CodeBlock.vue';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ScrollRegion } from '@/components/ui/scroll-region';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import PanelState from '@/components/panel/PanelState.vue';
import TelemetryUsageView from '@/features/telemetry/TelemetryUsageView.vue';
import { useRawEventsQuery } from './use-raw-events';
import { useSentinelLoad } from '@/shared/use-sentinel-load';
import type { InspectorTab } from './types';

const props = defineProps<{
  groupId: string;
  endpoints: SessionEndpoint[];
  endpoint?: SessionEndpoint;
  members: Array<{ id: string; name: string; host?: string }>;
  actors?: Array<{ id: string; name: string; host?: string }>;
  /** 正序(旧→新)的回合摘要。 */
  turnSummaries: TurnSummary[];
  unaffiliatedEvents: HistoryRow[];
  tab: InspectorTab;
  loading?: boolean;
  hasNextPage?: boolean;
  fetchingNextPage?: boolean;
  controller?: { kind: 'member' | 'panel_agent' | 'external_agent'; id: string; name: string } | null;
}>();

const expandedRecords = ref(new Set<string>());
const rawOpen = ref(false);
function toggleRecord(key: string, open: boolean) {
  if (open) expandedRecords.value.add(key);
  else expandedRecords.value.delete(key);
}

// 原始事件平铺流是调试视图:折叠区展开才拉取,有界滚动区内触底自动追加,不设按钮。
const {
  rows: rawRows,
  isPending: rawPending,
  hasNextPage: rawHasNextPage,
  isFetchingNextPage: rawFetchingNextPage,
  fetchNextPage: rawFetchNextPage,
} = useRawEventsQuery(() => props.endpoint?.id, rawOpen);
const rawScrollHost = ref<HTMLElement | null>(null);
const rawScroll = computed<Element | null>(
  () => rawScrollHost.value?.querySelector('[data-slot="scroll-region"]') ?? null,
);
const rawSentinel = ref<HTMLElement | null>(null);
useSentinelLoad({
  sentinel: rawSentinel,
  root: rawScroll,
  hasMore: () => rawHasNextPage.value,
  loading: () => rawPending.value || rawFetchingNextPage.value,
  load: () => { void rawFetchNextPage(); },
});

const emit = defineEmits<{
  'update:tab': [value: InspectorTab];
  loadMore: [];
  close: [];
  chooseSession: [];
}>();

const tabs: Array<{
  value: InspectorTab;
  label: string;
  icon: typeof Activity;
}> = [
  { value: 'trace', label: '执行轨迹', icon: Activity },
  { value: 'usage', label: '用量', icon: Gauge },
];

const memberName = computed(() => {
  const id = props.endpoint?.member_id;
  return (
    props.members.find((member) => member.id === id)?.name ??
    props.actors?.find((actor) => actor.id === id)?.name ??
    id ??
    '宿主会话'
  );
});

const endpointHost = computed(
  () =>
    props.members.find((member) => member.id === props.endpoint?.member_id)
      ?.host ??
    props.actors?.find((actor) => actor.id === props.endpoint?.member_id)?.host,
);

const endpointIsPair = computed(() => {
  const context = props.endpoint?.context ?? '';
  return context === 'pair' || context.startsWith('pair:');
});

const endpointIsManagerPair = computed(() => {
  const endpoint = props.endpoint;
  if (!endpoint || !endpointIsPair.value) return false;
  if (props.controller?.kind !== 'panel_agent') return false;
  return endpoint.peer === props.controller.id;
});

const endpointIsCoordination = computed(() => {
  const context = props.endpoint?.context ?? '';
  return context === 'coordination' || context === 'panel-coordination';
});

const usageKind = computed<'manager-pair' | 'pair' | 'coordination' | null>(() => {
  if (endpointIsManagerPair.value) return 'manager-pair';
  if (endpointIsPair.value) {
    // 对端不是群成员(用户/Panel Agent 之外的私聊对端)没有双方遥测,交给空态说明。
    const peerIsMember = props.members.some((member) => member.id === props.endpoint?.peer);
    return peerIsMember ? 'pair' : null;
  }
  if (endpointIsCoordination.value) return 'coordination';
  return null;
});

function selectTab(value: string | number) {
  if (value === 'trace' || value === 'usage') emit('update:tab', value);
}

function eventName(value: string) {
  try {
    const event = JSON.parse(value);
    return event.method ?? event.type ?? 'event';
  } catch {
    return '无法解析的事件';
  }
}

function prettyEvent(value: string) {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}
</script>

<template>
  <section class="flex min-h-0 flex-1 flex-col gap-5">
    <template v-if="!endpoint">
      <header class="flex flex-col gap-2">
        <h2 class="text-base font-semibold">团队详情</h2>
        <p class="text-xs text-muted-foreground">
          以下为团队级用量，选择会话查看明细。
        </p>
        <Button variant="outline" size="sm" class="w-fit" @click="emit('chooseSession')">浏览会话</Button>
      </header>
      <div class="min-h-0 flex-1 overflow-y-auto">
        <p class="text-xs text-muted-foreground">
          团队级概览已移至「工具」标签页;选择会话查看执行明细。
        </p>
      </div>
    </template>
    <template v-else>
      <header class="flex flex-col gap-2">
        <div class="flex items-center gap-2">
          <h2 class="shrink-0 text-base font-semibold">{{ memberName }}</h2>
          <!-- 会话标识直接跟在标题旁,过长省略,完整值放 title;不再占用一个折叠区。 -->
          <span
            class="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
            :title="endpoint.id"
          >{{ endpoint.id }}</span>
          <Badge v-if="endpointHost" variant="outline" class="shrink-0">{{
            endpointHost
          }}</Badge>
          <Button
            variant="ghost"
            size="icon-sm"
            class="shrink-0"
            aria-label="切换会话"
            title="切换会话"
            @click="emit('chooseSession')"
            ><ArrowLeftRight
          /></Button>
        </div>
      </header>
      <Tabs
        :model-value="tab"
        class="min-h-0 flex-1"
        @update:model-value="selectTab"
      >
        <TabsList class="w-full" aria-label="会话详情"
          ><TabsTrigger
            v-for="item in tabs"
            :key="item.value"
            :value="item.value"
            ><component :is="item.icon" />{{ item.label }}</TabsTrigger
          ></TabsList
        >
        <TabsContent :value="tab" class="pt-3">
          <PanelState v-if="loading && tab === 'trace'" loading title="正在读取回合" />
          <template v-else>
            <TraceTimeline
              v-if="tab === 'trace'"
              :turns="turnSummaries"
              :unaffiliated="unaffiliatedEvents"
              :endpoint-id="endpoint.id"
              :host="endpointHost"
              :has-next-page="hasNextPage"
              :fetching-next-page="fetchingNextPage"
              @load-more="emit('loadMore')"
            />
            <template v-else-if="tab === 'usage'">
              <TelemetryUsageView
                v-if="usageKind"
                :group-id="groupId"
                :kind="usageKind"
                :member-id="endpoint.member_id"
                :peer-id="endpoint.peer ?? undefined"
              />
              <PanelState
                v-else
                :icon="Gauge"
                title="该会话没有遥测视图"
                description="用量覆盖成员间双人会话、成员与主 Agent 的会话及统一调度。"
              />
            </template>
            <!-- 原始事件:同一事件流的裸 JSON 调试视图,默认收起,不与回合轨迹重复展示。
                 有界滚动 + 触底自动追加(哨兵观察滚动容器),分页是数据层能力,不出现按钮。 -->
            <template v-if="tab === 'trace'">
              <Separator class="my-2" />
              <Disclosure v-model:open="rawOpen">
                <template #summary>
                  <span class="min-w-0 flex-1 truncate">原始事件</span>
                  <!-- 展开前不显示计数:此时 0 只是"尚未加载",不是真实条数。 -->
                  <Badge v-if="rawRows.length" variant="outline">{{ rawRows.length }} 条</Badge>
                </template>
                <p class="text-xs text-muted-foreground">
                  宿主实际输出的事件流，可能包含宿主自身的截断。
                </p>
                <PanelState v-if="rawPending" loading title="正在读取原始事件" />
                <PanelState
                  v-else-if="!rawRows.length"
                  :icon="Braces"
                  title="暂无原始事件"
                />
                <div v-else ref="rawScrollHost" class="min-w-0">
                  <ScrollRegion
                    label="原始事件内容"
                    max-height="min(28rem,60vh)"
                    gap="0"
                  >
                    <Disclosure
                      v-for="row in rawRows"
                      :key="row.seq"
                      class="group"
                      data-record-row
                      @update:open="toggleRecord('event:' + row.seq, $event)"
                    >
                      <template #summary>
                        <span class="text-muted-foreground tabular-nums"
                          >#{{ row.seq }}</span
                        ><span class="min-w-0 flex-1 truncate font-mono">{{
                          eventName(row.event)
                        }}</span
                        ><time class="text-muted-foreground tabular-nums">{{
                          new Date(row.created).toLocaleTimeString('zh-CN')
                        }}</time>
                      </template>
                      <CodeBlock
                        v-if="expandedRecords.has('event:' + row.seq)"
                        :code="prettyEvent(row.event)"
                        max-height="16rem"
                      />
                    </Disclosure>
                    <div ref="rawSentinel" class="h-px" aria-hidden="true"></div>
                  </ScrollRegion>
                  <p
                    v-if="rawFetchingNextPage"
                    class="flex items-center gap-1 py-1 text-xs text-muted-foreground"
                  >
                    <LoaderCircle class="size-3 animate-spin" />正在加载更多事件…
                  </p>
                </div>
              </Disclosure>
            </template>
          </template>
        </TabsContent>
      </Tabs>
    </template>
  </section>
</template>
