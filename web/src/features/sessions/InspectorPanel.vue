<script setup lang="ts">
import { Disclosure } from '@/components/ui/disclosure';
import PanelState from '@/components/panel/PanelState.vue';
import RecordPanel from '@/components/panel/RecordPanel.vue';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { computed, ref } from 'vue';
import { Activity, ArrowLeftRight, Braces, Database, Gauge, LoaderCircle } from '@lucide/vue';
import type {
  Member,
  ModelObservation,
  ModelState,
  SessionEndpoint,
} from '@/shared/api/raw-types';
import type { HistoryRow } from '@/shared/api/raw-types';
import type { TurnView } from '@/shared/models/view-types';
import TraceTimeline from '@/components/ai-elements/TraceTimeline.vue';
import CodeBlock from '@/components/ai-elements/CodeBlock.vue';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { InspectorTab } from './types';
import TelemetryConversationView from '@/features/telemetry/TelemetryConversationView.vue';
import TelemetryManagerConversationView from '@/features/telemetry/TelemetryManagerConversationView.vue';

const props = defineProps<{
  groupId: string;
  endpoints: SessionEndpoint[];
  endpoint?: SessionEndpoint;
  members: Member[];
  actors?: Array<{ id: string; name: string; host?: string }>;
  turns: TurnView[];
  historyRows: HistoryRow[];
  modelState?: ModelState | null;
  observations: ModelObservation[];
  tab: InspectorTab;
  loading?: boolean;
  hasNextPage?: boolean;
  fetchingNextPage?: boolean;
  controller?: { kind: 'member' | 'panel_agent'; id: string; name: string } | null;
}>();

const expandedRecords = ref(new Set<string>());
function toggleRecord(key: string, open: boolean) {
  if (open) expandedRecords.value.add(key);
  else expandedRecords.value.delete(key);
}

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
  { value: 'events', label: '原始事件', icon: Braces },
  { value: 'models', label: '模型', icon: Database },
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

function selectTab(value: string | number) {
  if (
    value === 'trace' ||
    value === 'events' ||
    value === 'models' ||
    value === 'usage'
  )
    emit('update:tab', value);
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
        <div class="flex items-center justify-between gap-2">
          <h2 class="text-base font-semibold">{{ memberName }}</h2>
          <div class="flex items-center gap-2">
            <Badge v-if="endpointHost" variant="outline">{{
              endpointHost
            }}</Badge
            ><Button
              variant="ghost"
              size="icon-sm"
              aria-label="切换会话"
              title="切换会话"
              @click="emit('chooseSession')"
              ><ArrowLeftRight
            /></Button>
          </div>
        </div>
        <Disclosure>
          <template #summary>会话标识</template>
          <p class="mt-2 break-all font-mono">{{ endpoint.id }}</p>
        </Disclosure>
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
          <PanelState v-if="loading && tab !== 'usage'" loading title="正在读取事件" />
          <template v-else>
            <TraceTimeline v-if="tab === 'trace'" :turns="turns" />
            <RecordPanel v-else-if="tab === 'events'" title="原始事件" :count="historyRows.length" description="宿主实际输出的事件流，可能包含宿主自身的截断。">
              <PanelState v-if="!historyRows.length" :icon="Braces" title="暂无原始事件" />
              <Disclosure v-for="row in historyRows" :key="row.seq" @update:open="toggleRecord('event:' + row.seq, $event)" class="group" data-record-row>
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
                <CodeBlock v-if="expandedRecords.has('event:' + row.seq)" :code="prettyEvent(row.event)" max-height="16rem" />
              </Disclosure>
            </RecordPanel>
            <div v-else-if="tab === 'models'" class="flex flex-col gap-6">
              <section class="flex flex-col gap-4">
                <h3 class="text-sm font-medium">当前观测</h3>
                <dl class="flex flex-col gap-4 text-sm">
                  <div class="flex flex-col gap-1">
                    <dt class="text-xs text-muted-foreground">模型</dt>
                    <dd class="break-all font-medium">
                      {{ modelState?.currentModel?.model ?? '尚未报告' }}
                    </dd>
                    <dd class="text-xs text-muted-foreground">
                      {{
                        modelState?.currentModel?.source ??
                        '等待宿主提供模型信息'
                      }}
                    </dd>
                  </div>
                  <div class="flex flex-col gap-1">
                    <dt class="text-xs text-muted-foreground">思考强度</dt>
                    <dd class="font-medium">
                      {{
                        modelState?.currentReasoningEffort?.reasoningEffort ??
                        '尚未报告'
                      }}
                    </dd>
                    <dd class="text-xs text-muted-foreground">
                      {{
                        modelState?.currentReasoningEffort?.source ??
                        '等待宿主提供强度信息'
                      }}
                    </dd>
                  </div>
                </dl>
              </section>
              <Separator />
              <RecordPanel title="观测记录" :count="observations.length">
                <PanelState v-if="!observations.length" :icon="Database" title="暂无模型观测" description="配置值与实际观测可能不同，以宿主报告为准。" />
                <Disclosure
                  v-for="observation in observations"
                  :key="observation.seq"
                  @update:open="toggleRecord('model:' + observation.seq, $event)"
                  data-record-row
                  class="group"
                >
                  <template #summary>
                    <span class="text-muted-foreground"
                      >#{{ observation.seq }}</span
                    ><span class="min-w-0 flex-1 break-words"
                      >{{
                        observation.model ??
                        observation.models?.join(', ') ??
                        '模型未知'
                      }}<span class="mt-1 block text-muted-foreground">{{
                        observation.phase
                      }}</span></span
                    >

                  </template>
                  <CodeBlock
                    v-if="expandedRecords.has('model:' + observation.seq)"
                    :code="JSON.stringify(observation, null, 2)"
                    max-height="12rem"
                  />
                </Disclosure>
              </RecordPanel>
            </div>
            <div v-else-if="tab === 'usage'" class="flex flex-col gap-4">
              <TelemetryManagerConversationView
                v-if="endpointIsManagerPair && endpoint"
                :group-id="groupId"
                :member-id="endpoint.member_id"
                :members="members"
              />
              <TelemetryConversationView
                v-else-if="endpointIsPair"
                :group-id="groupId"
                :members="members"
                :endpoints="endpoints"
                :selected-endpoint-id="endpoint?.id"
              />
              <TelemetryCoordinationView
                v-else-if="endpointIsCoordination"
                :group-id="groupId"
              />
              <PanelState
                v-else
                :icon="Gauge"
                title="该会话没有遥测视图"
                description="用量视图仅覆盖双人会话与主 Agent 协调会话。"
              />
            </div>
            <Button
              v-if="hasNextPage"
              variant="outline"
              size="sm"
              class="mt-4 w-full"
              :disabled="fetchingNextPage"
              @click="emit('loadMore')"
              ><LoaderCircle v-if="fetchingNextPage" class="animate-spin" />{{
                fetchingNextPage ? '正在加载' : '加载更多事件'
              }}</Button
            >
          </template>
        </TabsContent>
      </Tabs>
    </template>
  </section>
</template>
