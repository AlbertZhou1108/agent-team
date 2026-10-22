<script setup lang="ts">
import { computed } from 'vue';
import { Bot } from '@lucide/vue';
import ExpandableText from './ExpandableText.vue';
import MarkdownRenderer from './MarkdownRenderer.vue';
import {
  Bubble,
  BubbleContent,
} from '@/components/ui/bubble';
import {
  Message,
  MessageAvatar,
  MessageContent,
} from '@/components/ui/message';

const props = withDefaults(defineProps<{
  role: 'user' | 'assistant' | 'system';
  content: string;
  lines?: number;
}>(), {
  lines: undefined,
});

const isUser = computed(() => props.role === 'user');
const collapsedLines = computed(() => props.lines ?? (isUser.value ? 8 : 10));
</script>

<template>
  <Message
    :align="isUser ? 'end' : 'start'"
    class="conversation-message"
  >
    <MessageAvatar
      v-if="!isUser"
      class="conversation-message-avatar"
    >
      <slot name="avatar">
        <Bot />
      </slot>
    </MessageAvatar>

    <MessageContent :class="isUser ? 'items-end' : 'items-start'">
      <Bubble
        v-if="isUser"
        align="end"
        variant="muted"
        class="max-w-[min(78%,760px)]"
      >
        <BubbleContent class="px-4 py-3">
          <ExpandableText :text="content" :lines="collapsedLines" />
        </BubbleContent>
      </Bubble>
      <div v-else class="conversation-message-body">
        <ExpandableText :text="content" :lines="collapsedLines">
          <MarkdownRenderer :content="content" />
        </ExpandableText>
      </div>

      <slot name="footer" />
    </MessageContent>
  </Message>
</template>
