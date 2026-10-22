<script setup lang="ts">
import { computed } from 'vue';
import {
  Bot,
  LoaderCircle,
  Settings2,
} from '@lucide/vue';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import ConversationPanel from '@/components/ai-elements/ConversationPanel.vue';
import {
  Trace,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '@/components/ui/trace';
import type {
  PanelAgent,
  PanelMessage,
} from '@/shared/api/raw-types';
import PanelAgentComposer from './PanelAgentComposer.vue';
import PanelAgentMessage from './PanelAgentMessage.vue';
import { filterPanelMessagesForContext } from './message-context';
import type {
  AvailableHost,
  PanelAgentForm,
  PanelTeam,
} from './types';

const props = defineProps<{
  agent: PanelAgent;
  messages: PanelMessage[];
  teams: PanelTeam[];
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

const globalContext = '__global__';
const activeTeam = computed(() => (
  props.teams.find(team => team.id === activeTeamId.value)
));
const visibleMessages = computed(() => (
  filterPanelMessagesForContext(props.messages, activeTeamId.value)
));
const visibleMessageIds = computed(() => [
  ...visibleMessages.value.map(message => message.id),
  ...(props.contextRunning ? ['panel-agent-running'] : []),
]);
const selectedContext = computed({
  get: () => activeTeamId.value || globalContext,
  set: value => {
    activeTeamId.value = value === globalContext ? '' : value;
  },
});

const suggestions = [
  '帮我总结当前所有团队的运行状态',
  '有哪些团队正在等待我的确认？',
  '帮我创建一个新团队',
];
</script>

<template>
  <ConversationPanel
    class="panel agent-chat"
    :ids="visibleMessageIds"
    :reset-key="activeTeamId || globalContext"
    :readonly="false"
    aria-label="Panel Agent 私人会话"
    viewport-class="size-full min-h-0"
    stream-class="size-full overflow-y-auto scroll-fade-b scrollbar-thin scrollbar-gutter-stable overscroll-contain contain-content"
    content-class="flex min-h-full flex-col gap-5 px-4 py-5"
  >
    <template #header>
      <header class="agent-chat-header">
        <div class="agent-mark agent-mark-small"><Bot /></div>
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <h1 class="truncate text-base font-semibold">{{ agent.name }}</h1>
            <Badge>{{ agent.host }}</Badge>
            <Badge>{{ agent.model ?? '默认模型' }}</Badge>
            <Badge v-if="agent.reasoning_effort">{{ agent.reasoning_effort }}</Badge>
          </div>
          <p class="mt-1 text-[11px] text-muted-foreground">
            全局私人会话 · {{ activeTeam?.name ?? '未附加团队上下文' }}
          </p>
        </div>
        <Button variant="ghost" size="icon" title="Panel Agent 设置" @click="emit('edit')">
          <Settings2 />
        </Button>
      </header>
    </template>

    <template #context>
      <div class="agent-context-bar">
        <span>团队上下文</span>
        <Select v-model="selectedContext">
          <SelectTrigger size="sm" class="max-w-72 flex-1 bg-background">
            <SelectValue placeholder="选择团队上下文" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem :value="globalContext">全局</SelectItem>
            <SelectItem
              v-for="team in teams"
              :key="team.id"
              :value="team.id"
            >
              {{ team.name }} · {{ team.relation === 'main' ? '主 Agent' : '观察' }}
            </SelectItem>
          </SelectContent>
        </Select>
        <Badge
          v-if="activeTeam"
          :variant="activeTeam.relation === 'main' ? 'success' : 'default'"
        >
          {{ activeTeam.relation === 'main' ? '主 Agent' : '观察' }}
        </Badge>
      </div>
    </template>

    <Empty
      v-if="!visibleMessages.length"
      class="min-h-[360px] border-0"
    >
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

    <div
      v-for="message in visibleMessages"
      :key="message.id"
      :data-message-id="message.id"
    >
      <PanelAgentMessage :message="message" :teams="teams" />
    </div>

    <div
      v-if="contextRunning"
      data-message-id="panel-agent-running"
    >
      <Trace>
        <TraceLine status="running">
          <TraceIcon>
            <LoaderCircle class="animate-spin" />
          </TraceIcon>
          <TraceTitle>Panel Agent 正在处理</TraceTitle>
          <TraceDescription>{{ agent.model ?? agent.host }}</TraceDescription>
        </TraceLine>
      </Trace>
    </div>

    <template #composer>
      <div v-if="actionError" class="error-banner mx-4 mt-3" role="alert">
        {{ actionError }}
      </div>
      <PanelAgentComposer
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
  </ConversationPanel>
</template>
