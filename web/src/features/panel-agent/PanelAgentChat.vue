<script setup lang="ts">
import { Alert, AlertDescription } from '@/components/ui/alert';
import { computed } from 'vue';
import { Bot, LoaderCircle, Settings2 } from '@lucide/vue';
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
import ConversationPanel from '@/components/ai-elements/ConversationPanel.vue';
import ConversationFrame from '@/components/ai-elements/ConversationFrame.vue';
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
  PanelStream,
} from '@/shared/api/raw-types';
import { panelAccessOption, panelWorkspaceBasename } from './access';
import PanelAgentComposer from './PanelAgentComposer.vue';
import PanelAgentMessage from './PanelAgentMessage.vue';
import { filterPanelMessagesForContext } from './message-context';
import type { AvailableHost, PanelAgentForm, PanelTeam } from './types';

const props = defineProps<{
  agent: PanelAgent;
  messages: PanelMessage[];
  streaming?: PanelStream | null;
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

const globalContextKey = '__global__';
const activeTeam = computed(() =>
  props.teams.find((team) => team.id === activeTeamId.value),
);
const visibleMessages = computed(() =>
  filterPanelMessagesForContext(props.messages, activeTeamId.value),
);
const streamingMessage = computed<PanelMessage | null>(() => {
  const stream = props.streaming;
  if (
    !stream ||
    !stream.text ||
    stream.activeTeamId !== (activeTeamId.value || null)
  )
    return null;
  return {
    seq: -1,
    id: `stream:${stream.turnId}`,
    panel_agent_id: stream.agentId,
    context: 'private',
    role: 'assistant',
    text: stream.text,
    active_team_id: stream.activeTeamId,
    created: stream.created,
  };
});
const visibleMessageIds = computed(() => [
  ...visibleMessages.value.map((message) => message.id),
  ...(streamingMessage.value ? [streamingMessage.value.id] : []),
  ...(props.contextRunning && !streamingMessage.value
    ? ['panel-agent-running']
    : []),
]);
const currentAccess = computed(() => panelAccessOption(props.agent.access));
const workspaceName = computed(() =>
  panelWorkspaceBasename(props.agent.workspace),
);
const modelSummary = computed(() => {
  const effort = props.agent.reasoning_effort
    ? `（${props.agent.reasoning_effort}）`
    : '';
  const workspace = props.agent.workspace
    ? ` · 工作区 ${workspaceName.value}`
    : '';
  return `${props.agent.host} · ${props.agent.model ?? '默认模型'}${effort}${workspace}`;
});
const legacyAgent = computed(
  () => currentAccess.value.value === 'read-only' && !props.agent.workspace,
);
const suggestions = [
  '帮我总结当前所有团队的运行状态',
  '有哪些团队正在等待我的确认？',
  '帮我创建一个新团队',
];
</script>

<template>
  <ConversationFrame :readonly="false" class="agent-chat">
  <ConversationPanel
    :ids="visibleMessageIds"
    :reset-key="activeTeamId || globalContextKey"
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
            <Badge
              :variant="currentAccess.badgeVariant"
              :title="currentAccess.description"
              >{{ currentAccess.label }}</Badge
            >
          </div>
          <p
            class="mt-1 truncate text-muted-foreground"
            :title="agent.workspace ?? undefined"
          >
            全局私人会话 · {{ modelSummary }} ·
            {{ activeTeam?.name ?? '未附加团队上下文' }}
          </p>
          <p
            v-if="legacyAgent"
            class="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground"
          >
            <span>尚未设置私人工作区，私人回合将使用数据目录。</span>
            <Button variant="link" size="xs" @click="emit('edit')"
              >设置私人工作区</Button
            >
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          title="Panel Agent 设置"
          @click="emit('edit')"
        >
          <Settings2 />
        </Button>
      </header>
    </template>

    <Empty v-if="!visibleMessages.length" class="min-h-[360px]">
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
      v-if="streamingMessage"
      :key="streamingMessage.id"
      :data-message-id="streamingMessage.id"
      aria-live="polite"
    >
      <PanelAgentMessage :message="streamingMessage" :teams="teams" />
    </div>

    <div
      v-else-if="contextRunning"
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

  </ConversationPanel>
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
  </ConversationFrame>
</template>
