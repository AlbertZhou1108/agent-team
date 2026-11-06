<script setup lang="ts">
import { computed, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useInfiniteQuery } from '@tanstack/vue-query';
import { api } from '@/shared/api/client';
import { queryKeys } from '@/features/query-keys';
import { Bot, Settings2 } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import ConversationWorkspace from '@/features/messages/ConversationWorkspace.vue';
import type {
  Interaction,
  PanelAgent,
  TeamRequest,
  PanelMessage,
  PanelStream,
} from '@/shared/api/raw-types';
import PanelAgentComposer from './PanelAgentComposer.vue';
import TeamRequestCard from './TeamRequestCard.vue';
import { usePanelAgentStore } from '@/stores/panel-agent';
import { reuseMessageViews, toPanelMessageViews, toPanelStreamViews } from '@/features/messages/adapters';
import type { MessageView } from '@/shared/models/view-types';
import type { AvailableHost, PanelAgentForm, PanelTeam } from './types';
import type { ComposerAttachment } from '@/components/ai-elements/MessageComposer.vue';

const props = defineProps<{
  agent: PanelAgent;
  bootId?: string;
  messages: PanelMessage[];
  requests?: TeamRequest[];
  streaming?: PanelStream | null;
  teams: PanelTeam[];
  interactions?: Interaction[];
  sending: boolean;
  contextRunning: boolean;
  /** 服务端记录的回合开始时间,用于运行卡计时;缺失时不显示时长。 */
  runningSince?: string | null;
  stopping: boolean;
  actionError: string;
  hosts: AvailableHost[];
  catalogLoading: boolean;
  modelSaving: boolean;
  /** 输入框附件草稿与上传/移除回调,由 Panel 层持有。 */
  attachments?: ComposerAttachment[];
}>();
const draft = defineModel<string>('draft', { required: true });
const activeTeamId = defineModel<string>('activeTeamId', { required: true });
const form = defineModel<PanelAgentForm>('form', { required: true });
const emit = defineEmits<{
  send: [];
  stop: [];
  edit: [];
  updateModel: [form: PanelAgentForm];
  attach: [files: File[]];
  removeAttachment: [localId: string];
}>();

const globalContextKey = '__global__';
const state = usePanelAgentStore();
const route=useRoute();
watch(()=>route.query.history,value=>{state.historyVisible=value==='1';},{immediate:true});
const showHistory = computed({ get: () => state.historyVisible, set: value => { state.historyVisible = value; } });
const activeTeam = computed(() =>
  props.teams.find((team) => team.id === activeTeamId.value),
);
const records = useInfiniteQuery({
  queryKey: computed(() => queryKeys.panelRecords(props.bootId, showHistory.value)),
  initialPageParam: undefined as number | undefined,
  queryFn: ({ pageParam, signal }) => api.panelRecords(showHistory.value, pageParam, signal),
  getNextPageParam: page => page.nextBefore ?? undefined,
  enabled: computed(() => Boolean(props.bootId)),
  // 新消息由 panel SSE 流推送;历史页不再轮询重取全部已加载页。
  refetchOnWindowFocus: false,
});
const visibleMessages = computed(() => [...new Map([
  ...(records.data.value?.pages.flatMap(page => page.messages) ?? []),
  ...(!showHistory.value ? props.messages : []),
].map(row => [row.seq, row])).values()].sort((a,b) => a.seq-b.seq));
watch([()=>route.query.message,()=>route.query.interaction,visibleMessages,records.isPending,records.isFetchingNextPage],async()=>{
  const interaction=props.interactions?.find(item=>item.id===route.query.interaction);
  const id=interaction?.panel_message_id??route.query.message;
  if(typeof id!=='string'||records.isPending.value||records.isFetchingNextPage.value||visibleMessages.value.some(m=>m.id===id))return;
  if(records.hasNextPage.value)await records.fetchNextPage();
},{immediate:true});
// 视图对象按内容复用:2 秒轮询会让 conversation 每轮都是新数组,若每次都产出新对象,
// 历史消息的 props 比较永远判为变化,整表随流式输出一起重渲染。
let cachedViews: MessageView[] = [];
const visibleViews = computed(() => {
  cachedViews = reuseMessageViews(
    cachedViews,
    toPanelMessageViews(visibleMessages.value, props.agent.name),
  );
  return cachedViews;
});
// 流视图以取值函数交给消息流:每个 token 的重渲染只发生在流式组件内部,
// 本组件与已定稿消息都不参与。
const readPanelStreamViews = () =>
  showHistory.value ? [] : toPanelStreamViews([props.streaming], {
    agentName: props.agent.name,
    activeTeamId: activeTeamId.value || null,
    running: props.contextRunning,
    runningSince: props.runningSince ?? null,
  });
const suggestions = [
  '帮我整理这些资料',
  '帮我比较几个方案',
  '帮我创建一个新团队',
];
</script>

<template>
  <ConversationWorkspace
    :heading="agent.name"
    :title="showHistory ? '历史记录' : '私人消息'"
    :description="showHistory ? '此前启动的记录 · 只读' : '消息发送给私人助手'"
    :readonly="showHistory"
    :error="records.error.value?.message || actionError"
    :retryable="Boolean(records.error.value)"
    @retry="records.refetch()"
    :messages="visibleViews"
    :has-next-page="records.hasNextPage.value"
    :fetching-next-page="records.isFetchingNextPage.value"
    :loading="records.isPending.value && !visibleViews.length"
    @load-more="records.fetchNextPage()"
    :stream-source="readPanelStreamViews"
    :interactions="interactions ?? []"
    :group-system-messages="false"
    :traceable="false"
    :markdown="true"
    :hosts="{}"
    :group-names="Object.fromEntries(teams.map(team => [team.id, team.name]))"
    selected-pair=""
    :reset-key="showHistory ? 'history' : globalContextKey"
    :aria-label="'Panel Agent 私人会话'"
  >
    <template #leading><div class="agent-mark agent-mark-small"><Bot /></div></template>
    <template #actions>
        <Button as-child variant="outline" size="sm"><RouterLink to="/groups/new">创建团队</RouterLink></Button>
        <Button variant="ghost" size="sm" @click="showHistory = !showHistory">{{ showHistory ? '返回当前会话' : '历史记录' }}</Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Panel Agent 设置"
          title="Panel Agent 设置"
          @click="emit('edit')"
        >
          <Settings2 />
        </Button>
    </template>
    <template #context>
      <div v-if="!showHistory" class="flex flex-col gap-3 px-4">
        <TeamRequestCard v-for="request in (requests ?? []).filter(row => row.receipts.length && !visibleMessages.some(message => message.id === row.source_user_message_id))" :key="request.id" :request="request" :team-name="teams.find(team => team.id === request.group_id)?.name ?? '团队'" />
      </div>
    </template>

    <template #empty>
      <Empty class="min-h-[360px]">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Bot />
          </EmptyMedia>
          <EmptyTitle>
            {{ showHistory ? '暂无历史记录' : activeTeam ? '这个团队还没有会话' : '你想完成什么？' }}
          </EmptyTitle>
          <EmptyDescription v-if="!showHistory">
            {{
              activeTeam
                ? `当前切换到「${activeTeam.name}」，这里会显示与该团队的私人会话。`
                : '描述需求或添加资料；需要多人协作时，可以创建团队。'
            }}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent v-if="!showHistory && !activeTeam">
          <div class="flex flex-wrap justify-center gap-2">
            <Button
              v-for="suggestion in suggestions"
              :key="suggestion"
              variant="outline"
              size="sm"
              @click="draft = suggestion"
            >
              {{ suggestion }}
            </Button>
          </div>
        </EmptyContent>
      </Empty>
    </template>

    <template #footer="{ message }">
      <TeamRequestCard v-for="request in (requests ?? []).filter(row => row.source_user_message_id === message.id)" :key="request.id" :request="request" :team-name="teams.find(team => team.id === request.group_id)?.name ?? '团队'" />
    </template>

    <template #composer>
      <PanelAgentComposer v-if="!showHistory"
        v-model="draft"
        v-model:form="form"
        :agent="agent"
        :sending="sending"
        :stopping="stopping"
        :hosts="hosts"
        :catalog-loading="catalogLoading"
        :model-saving="modelSaving"
        :attachments="attachments"
        @attach="emit('attach', $event)"
        @remove-attachment="emit('removeAttachment', $event)"
        @submit="emit('send')"
        @stop="emit('stop')"
        @edit="emit('edit')"
        @update-model="emit('updateModel', $event)"
      />
    </template>
  </ConversationWorkspace>
</template>
