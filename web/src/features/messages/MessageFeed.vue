<script setup lang="ts">
import { computed } from 'vue';
import { LoaderCircle, MessagesSquare } from '@lucide/vue';
import type { Member } from '@/shared/api/raw-types';
import type { MessageView } from '@/shared/models/view-types';
import AgentMessage from '@/components/ai-elements/AgentMessage.vue';
import MessageTrace from '@/components/ai-elements/MessageTrace.vue';
import { Button } from '@/components/ui/button';
import { pairLabel } from './adapters';

const props = defineProps<{
  messages: MessageView[];
  members: Member[];
  selectedPair: string;
  hosts?: Record<string, string>;
  loading?: boolean;
  hasNextPage?: boolean;
  fetchingNextPage?: boolean;
}>();

const emit = defineEmits<{
  'update:selectedPair': [value: string];
  loadMore: [];
}>();

const pairs = computed(() => {
  const values = new Map<string, string>();
  for (const message of props.messages) {
    if (message.kind !== 'system') values.set(message.pairKey, pairLabel(message.pairKey, props.members));
  }
  return [...values.entries()];
});

const filtered = computed(() => (
  props.selectedPair
    ? props.messages.filter(message => message.pairKey === props.selectedPair)
    : props.messages
));
</script>

<template>
  <section class="message-feed min-w-0">
    <div class="message-toolbar">
      <span class="eyebrow">MESSAGES</span>
      <select
        :value="selectedPair"
        class="field-select max-w-[220px]"
        aria-label="按双人对话过滤"
        @change="emit('update:selectedPair', ($event.target as HTMLSelectElement).value)"
      >
        <option value="">全部对话</option>
        <option v-for="[value, label] in pairs" :key="value" :value="value">{{ label }}</option>
      </select>
    </div>

    <div class="message-stream">
      <div v-for="message in filtered" :key="message.id" class="chat-message">
        <MessageTrace
          :message-id="message.id"
          :hosts="hosts ?? {}"
          :align-right="message.senderIsLead && message.kind !== 'system'"
        />
        <AgentMessage :message="message" />
      </div>
      <div v-if="!filtered.length && !loading" class="empty-state">
        <MessagesSquare :size="22" />
        <p>{{ selectedPair ? '这个双人会话还没有消息。' : '还没有群消息。成员会通过群工具在这里出现。' }}</p>
      </div>
      <div v-if="loading" class="empty-state">
        <LoaderCircle :size="20" class="animate-spin" />
        <p>正在读取群消息…</p>
      </div>
    </div>

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
  </section>
</template>
