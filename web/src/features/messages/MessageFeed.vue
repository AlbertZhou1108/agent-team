<script setup lang="ts">
import { computed } from 'vue';
import { LoaderCircle, MessagesSquare } from '@lucide/vue';
import type { MessageView } from '@/shared/models/view-types';
import AgentMessage from '@/components/ai-elements/AgentMessage.vue';
import ConversationPanel from '@/components/ai-elements/ConversationPanel.vue';
import MessageTrace from '@/components/ai-elements/MessageTrace.vue';
import { Button } from '@/components/ui/button';

const props = defineProps<{
  messages: MessageView[];
  title?: string;
  selectedPair: string;
  hosts?: Record<string, string>;
  loading?: boolean;
  hasNextPage?: boolean;
  fetchingNextPage?: boolean;
}>();

const emit = defineEmits<{
  loadMore: [];
}>();

const filtered = computed(() => (
  props.selectedPair
    ? props.messages.filter(message => message.pairKey === props.selectedPair)
    : props.messages
));

const messageGroups = computed(() => {
  const groups: { id: string; notifications: boolean; messages: MessageView[] }[] = [];
  for (const message of filtered.value) {
    const previous = groups.at(-1);
    if (message.kind === 'system' && previous?.notifications) previous.messages.push(message);
    else groups.push({ id: message.id, notifications: message.kind === 'system', messages: [message] });
  }
  return groups;
});
const messageIds = computed(() => filtered.value.map(message => message.id));
</script>

<template>
  <ConversationPanel
    class="message-feed min-w-0"
    :ids="messageIds"
    :reset-key="selectedPair"
    aria-label="团队消息"
    viewport-class="message-viewport"
    stream-class="message-stream"
    content-class="message-content"
  >
    <template #header>
      <div class="message-toolbar">
        <h3 class="truncate text-sm font-medium">{{ title ?? '全部群消息' }}</h3>
      </div>
    </template>
      <div v-for="group in messageGroups" :key="group.id" class="chat-message">
        <details v-if="group.notifications && group.messages.length > 1" class="notification-stack">
          <summary>
            <span class="font-medium">系统通知 <span class="text-xs text-muted-foreground">{{ group.messages.length }} 条</span></span>
            <span class="notification-expand text-xs text-muted-foreground">展开</span>
            <span class="notification-collapse text-xs text-muted-foreground">收起</span>
          </summary>
          <div class="flex flex-col gap-2 p-3">
            <AgentMessage v-for="message in group.messages" :key="message.id" :message="message" />
          </div>
        </details>
        <template v-else>
          <MessageTrace
            :message-id="group.messages[0]!.id"
            :hosts="hosts ?? {}"
          />
          <AgentMessage :message="group.messages[0]!" />
        </template>
      </div>
      <div v-if="!filtered.length && !loading" class="empty-state">
        <MessagesSquare :size="22" />
        <p>{{ selectedPair ? '这个双人会话还没有消息。' : '还没有群消息。成员会通过群工具在这里出现。' }}</p>
      </div>
      <div v-if="loading" class="empty-state">
        <LoaderCircle :size="20" class="animate-spin" />
        <p>正在读取群消息…</p>
      </div>
    <template #footer>
      <Button
        v-if="hasNextPage"
        variant="outline"
        size="sm"
        class="mb-2 mt-2 w-full"
        :disabled="fetchingNextPage"
        @click="emit('loadMore')"
      >
        <LoaderCircle v-if="fetchingNextPage" :size="13" class="animate-spin" />
        {{ fetchingNextPage ? '正在加载' : '加载更多消息' }}
      </Button>
    </template>
  </ConversationPanel>
</template>
