<script setup lang="ts">
import { computed } from 'vue';
import {
  Bot,
  Check,
  Copy,
  Megaphone,
  MessageSquareText,
} from '@lucide/vue';
import { useClipboard } from '@vueuse/core';
import type { MessageView } from '@/shared/models/view-types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import ExpandableText from './ExpandableText.vue';

const props = defineProps<{ message: MessageView }>();
const { copy, copied } = useClipboard({ copiedDuring: 1500, legacy: true });

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
  <div
    :class="cn(
      'message-row',
      message.kind === 'send'
        ? message.senderIsLead
          ? 'message-row-right'
          : 'message-row-left'
        : 'message-row-notice',
    )"
  >
    <span
      v-if="message.kind === 'send'"
      class="message-sender-avatar"
      aria-hidden="true"
    >
      {{ message.senderName.slice(0, 1) }}
    </span>
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
        <span v-if="message.kind !== 'send'" class="message-icon">
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
        <Button
          variant="ghost"
          size="icon-xs"
          class="message-copy"
          :aria-label="copied ? '已复制' : '复制消息'"
          :title="copied ? '已复制' : '复制消息'"
          @click="copy(message.text)"
        >
          <Check v-if="copied" :size="11" data-icon />
          <Copy v-else :size="11" data-icon />
        </Button>
      </div>
      <ExpandableText class="message-body" :text="message.text" />
      <p class="message-id">#{{ message.seq }} · {{ message.id }}</p>
    </article>
  </div>
</template>
