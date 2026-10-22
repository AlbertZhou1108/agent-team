<script setup lang="ts">
import { computed } from 'vue';
import { Bot, Megaphone, MessageSquareText } from '@lucide/vue';
import type { MessageView } from '@/shared/models/view-types';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import ExpandableText from './ExpandableText.vue';

const props = defineProps<{ message: MessageView }>();

const icon = computed(() => {
  if (props.message.kind === 'system') return Megaphone;
  if (props.message.kind === 'note') return MessageSquareText;
  return Bot;
});

const time = computed(() => new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
}).format(new Date(props.message.createdAt)));
</script>

<template>
  <article
    :class="cn(
      'message-card',
      `message-${message.kind}`,
      message.kind !== 'send'
        ? 'message-notice'
        : message.senderIsLead
          ? 'message-right'
          : 'message-left',
    )"
  >
    <div class="message-head">
      <span class="message-icon">
        <component :is="icon" :size="14" />
      </span>
      <p class="min-w-0 flex-1 truncate text-xs">
        <span class="message-sender">{{ message.senderName }}</span>
        <span class="message-route">→ {{ message.recipientName }}</span>
      </p>
      <Badge
        v-if="message.kind !== 'send'"
        :variant="message.kind === 'system' ? 'danger' : 'warning'"
      >
        {{ message.kind === 'note' ? '留言' : '通知' }}
      </Badge>
      <time class="message-time">{{ time }}</time>
    </div>
    <ExpandableText class="message-body" :text="message.text" />
    <p class="message-id">#{{ message.seq }} · {{ message.id }}</p>
  </article>
</template>
