<script setup lang="ts">
import { Alert, AlertDescription } from '@/components/ui/alert';
import { computed } from 'vue';
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
import { Badge } from '@/components/ui/badge';
import ConversationFrame from '@/components/ai-elements/ConversationFrame.vue';
import MessageFeed from '@/features/messages/MessageFeed.vue';
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
import { filterPanelMessagesForContext } from './message-context';
import { toPanelMessageViews, toPanelStreamViews } from '@/features/messages/adapters';
import type { AvailableHost, PanelAgentForm, PanelTeam } from './types';

const props = defineProps<{
  agent: PanelAgent;
  messages: PanelMessage[];
  requests?: TeamRequest[];
  streaming?: PanelStream | null;
  teams: PanelTeam[];
  interactions?: Interaction[];
  sending: boolean;
  contextRunning: boolean;
  stopping: boolean;
  actionError: string;
  hosts: AvailableHost[];
  catalogLoading: boolean;
  modelSaving: boolean;
}>();
const draft = defineModel<string>('draft', { required: true });
const activeTeamId = defineModel<string>('activeTeamId', { required: true });
const form = defineModel<PanelAgentForm>('form', { required: true });
const emit = defineEmits<{
  send: [];
  stop: [];
  edit: [];
  updateModel: [form: PanelAgentForm];
}>();

const globalContextKey = '__global__';
const state = usePanelAgentStore();
const showHistory = computed({ get: () => state.historyVisible, set: value => { state.historyVisible = value; } });
const activeTeam = computed(() =>
  props.teams.find((team) => team.id === activeTeamId.value),
);
const visibleMessages = computed(() =>
  showHistory.value ? props.messages.filter(message => message.active_team_id != null) : filterPanelMessagesForContext(props.messages, ''),
);
const visibleViews = computed(() =>
  toPanelMessageViews(visibleMessages.value, props.agent.name),
);
const panelStreamViews = computed(() =>
  showHistory.value ? [] : toPanelStreamViews([props.streaming], {
    agentName: props.agent.name,
    activeTeamId: activeTeamId.value || null,
    running: props.contextRunning,
  }),
);
const suggestions = [
  '帮我总结当前所有团队的运行状态',
  '有哪些团队正在等待我的确认？',
  '帮我创建一个新团队',
];
</script>

<template>
  <ConversationFrame :readonly="false" class="agent-chat">
  <MessageFeed
    :messages="visibleViews"
    :stream-views="panelStreamViews"
    :interactions="interactions ?? []"
    :group-system-messages="false"
    :markdown="true"
    :hosts="{}"
    selected-pair=""
    :reset-key="activeTeamId || globalContextKey"
    :aria-label="'Panel Agent 私人会话'"
    viewport-class="size-full min-h-0"
    stream-class="size-full overflow-y-auto scroll-fade-b scrollbar-thin scrollbar-gutter-stable overscroll-contain contain-content"
    content-class="flex min-h-full flex-col gap-5 px-4 py-5"
  >
    <template #header>
      <header class="agent-chat-header">
        <div class="agent-mark agent-mark-small"><Bot /></div>
        <div class="min-w-0 flex-1">
          <h1 class="truncate text-base font-semibold">{{ agent.name }}</h1>
          <span class="text-xs text-muted-foreground">{{ showHistory ? '历史团队私聊 · 只读' : '全局私人会话' }}</span>
        </div>
        <Button variant="ghost" size="sm" @click="showHistory = !showHistory">{{ showHistory ? '返回全局' : '历史团队私聊' }}</Button>
        <Button
          variant="ghost"
          size="icon"
          title="Panel Agent 设置"
          @click="emit('edit')"
        >
          <Settings2 />
        </Button>
      </header>
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
            {{ activeTeam ? '这个团队还没有会话' : '从一个目标开始' }}
          </EmptyTitle>
          <EmptyDescription>
            {{
              activeTeam
                ? `当前切换到「${activeTeam.name}」，这里会显示与该团队的私人会话。`
                : '可以询问团队状态、解释阻塞，或者让我准备一个新团队。'
            }}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent v-if="!activeTeam">
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
      <Badge
        v-if="message.kind === 'system'"
        variant="default"
        class="mt-1 w-fit"
        >自动进度</Badge
      >
    </template>
  </MessageFeed>
    <template #composer>
      <Alert
        variant="destructive"
        v-if="actionError"
        class="error-banner mx-4 mt-3"
        role="alert"
        ><AlertDescription class="flex items-center gap-2">
          {{ actionError }}
        </AlertDescription></Alert
      >
      <PanelAgentComposer v-if="!showHistory"
        v-model="draft"
        v-model:form="form"
        :agent="agent"
        :sending="sending"
        :stopping="stopping"
        :hosts="hosts"
        :catalog-loading="catalogLoading"
        :model-saving="modelSaving"
        @submit="emit('send')"
        @stop="emit('stop')"
        @edit="emit('edit')"
        @update-model="emit('updateModel', $event)"
      />
    </template>
  </ConversationFrame>
</template>
