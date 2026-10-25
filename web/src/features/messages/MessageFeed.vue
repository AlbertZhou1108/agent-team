<script setup lang="ts">
import { computed } from 'vue';
import PanelState from '@/components/panel/PanelState.vue';
import { LoaderCircle, MessagesSquare } from '@lucide/vue';
import type { MessageView } from '@/shared/models/view-types';
import AgentMessage from '@/components/ai-elements/AgentMessage.vue';
import ConversationPanel from '@/components/ai-elements/ConversationPanel.vue';
import MessageTrace from '@/components/ai-elements/MessageTrace.vue';
import ReasoningBlock from '@/components/ai-elements/ReasoningBlock.vue';
import { Badge } from '@/components/ui/badge';
import type { Interaction, TeamDirectiveReceipt, TeamStream } from '@/shared/api/raw-types';
import { directiveStatus } from './directive-status';
import { toStreamMessageViews } from './adapters';
import type { StreamView } from './adapters';
import { Button } from '@/components/ui/button';
import InteractionCard from './InteractionCard.vue';

const props = withDefaults(
  defineProps<{
    messages: MessageView[];
    streaming?: TeamStream[];
    /** 预转换的流视图;提供时优先于 streaming 的内部转换(Panel 等非 TeamStream 数据源使用)。 */
    streamViews?: StreamView[];
    directives?: TeamDirectiveReceipt[];
    interactions?: Interaction[];
    title?: string;
    selectedPair: string;
    controllerId?: string;
    hosts?: Record<string, string>;
    loading?: boolean;
    hasNextPage?: boolean;
    fetchingNextPage?: boolean;
    /** 连续 system 消息是否折叠为通知堆栈;Panel 的自动进度消息不折叠。 */
    groupSystemMessages?: boolean;
    /** 助手/系统正文按 Markdown 渲染。 */
    markdown?: boolean;
    ariaLabel?: string;
    resetKey?: string | number;
    viewportClass?: string;
    streamClass?: string;
    contentClass?: string;
  }>(),
  {
    streaming: () => [],
    streamViews: undefined,
    directives: () => [],
    interactions: () => [],
    title: undefined,
    controllerId: undefined,
    hosts: () => ({}),
    loading: false,
    hasNextPage: false,
    fetchingNextPage: false,
    groupSystemMessages: true,
    markdown: false,
    ariaLabel: '团队消息',
    resetKey: undefined,
    viewportClass: 'message-viewport',
    streamClass: 'message-stream',
    contentClass: 'message-content',
  },
);

const emit = defineEmits<{
  loadMore: [];
}>();

const filtered = computed(() =>
  props.selectedPair
    ? props.messages.filter((message) => message.pairKey === props.selectedPair)
    : props.messages,
);
const streamingViews = computed<StreamView[]>(() =>
  props.streamViews
    ?? toStreamMessageViews(
      props.messages,
      props.streaming ?? [],
      props.selectedPair,
      props.controllerId,
    ),
);
const streamingMessages = computed(() =>
  streamingViews.value.map(item => item.message),
);

const messageGroups = computed(() => {
  const groups: {
    id: string;
    notifications: boolean;
    messages: MessageView[];
  directives?: TeamDirectiveReceipt[];
  }[] = [];
  for (const message of filtered.value) {
    const previous = groups.at(-1);
    if (
      props.groupSystemMessages
      && message.kind === 'system'
      && previous?.notifications
    )
      previous.messages.push(message);
    else
      groups.push({
        id: message.id,
        notifications: props.groupSystemMessages && message.kind === 'system',
        messages: [message],
      });
  }
  return groups;
});
const receipts = computed(() => Object.fromEntries((props.directives ?? []).map(r => [r.messageId, r])));
const messageInteractions = computed(() => {
  const map: Record<string, Interaction[]> = {};
  for (const item of props.interactions ?? []) {
    if (!item.message_id) continue;
    (map[item.message_id] ??= []).push(item);
  }
  return map;
});
const messageIds = computed(() => [
  ...filtered.value.map((message) => message.id),
  ...streamingMessages.value.map((message) => message.id),
]);
</script>

<template>
  <ConversationPanel
    class="message-feed min-w-0"
    :ids="messageIds"
    :reset-key="resetKey ?? selectedPair"
    :aria-label="ariaLabel"
    :viewport-class="viewportClass"
    :stream-class="streamClass"
    :content-class="contentClass"
  >
    <template v-if="$slots.header" #header>
      <slot name="header" />
    </template>
    <template v-else #header>
      <div class="message-toolbar justify-between">
        <h3 class="truncate text-sm font-medium">
          {{ title ?? '全部群消息' }}
        </h3>
        <span class="text-xs text-muted-foreground tabular-nums"
          >{{ filtered.length + streamingMessages.length }} 条消息</span
        >
      </div>
    </template>
    <div v-if="hasNextPage" class="flex justify-center py-2">
      <Button variant="outline" size="sm" :disabled="fetchingNextPage" @click="emit('loadMore')">
        <LoaderCircle v-if="fetchingNextPage" class="animate-spin" />
        {{ fetchingNextPage ? '正在加载' : '加载更早消息' }}
      </Button>
    </div>
    <div v-for="group in messageGroups" :key="group.id" class="chat-message">
      <details
        v-if="group.notifications && group.messages.length > 1"
        class="notification-stack"
      >
        <summary>
          <span class="font-medium"
            >系统通知
            <span class="text-xs text-muted-foreground"
              >{{ group.messages.length }} 条</span
            ></span
          >
          <span class="notification-expand text-xs text-muted-foreground"
            >展开</span
          >
          <span class="notification-collapse text-xs text-muted-foreground"
            >收起</span
          >
        </summary>
        <div class="flex flex-col gap-2 p-3">
          <AgentMessage
            v-for="message in group.messages"
            :key="message.id"
            :message="message"
          />
        </div>
      </details>
      <template v-else>
        <MessageTrace
          v-if="!group.messages[0]!.senderIsUser"
          :message-id="group.messages[0]!.id"
          :hosts="hosts ?? {}"
        />
        <AgentMessage :message="group.messages[0]!" :markdown="markdown">
          <template v-if="$slots.footer" #footer="{ message }">
            <slot name="footer" :message="message" />
          </template>
        </AgentMessage>
        <InteractionCard
          v-for="interaction in messageInteractions[group.messages[0]!.id] ?? []"
          :key="interaction.id"
          :interaction="interaction"
          class="mt-2"
        />
        <p v-if="receipts[group.id]" class="flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
          <Badge variant="outline">{{ directiveStatus(receipts[group.id]!) }}</Badge>
          <span v-if="receipts[group.id]!.error">{{ receipts[group.id]!.error }}</span>
        </p>
      </template>
    </div>
    <div
      v-for="{ message, pending, reasoning } in streamingViews"
      :key="message.id"
      class="chat-message"
      :data-message-id="message.id"
      aria-live="polite"
    >
      <ReasoningBlock
        :reasoning="reasoning"
        :running="pending && !message.text"
        class="mb-2"
      />
      <AgentMessage :message="message" :pending="pending" :markdown="markdown">
        <template v-if="$slots.footer" #footer="{ message: footerMessage }">
          <slot name="footer" :message="footerMessage" />
        </template>
      </AgentMessage>
    </div>
    <PanelState v-if="loading" loading title="正在读取群消息" description="正在同步这个团队的共享记录。" />
    <slot v-else-if="!filtered.length && !streamingMessages.length" name="empty">
      <PanelState :icon="MessagesSquare" title="暂无消息" :description="selectedPair ? '这个双人会话还没有消息。' : '成员开始交流后，消息会显示在这里。'" />
    </slot>

  </ConversationPanel>
</template>
