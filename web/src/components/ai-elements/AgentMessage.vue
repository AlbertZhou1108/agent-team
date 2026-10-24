<script setup lang="ts">
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { computed } from 'vue';
import { Bot, Copy, Ellipsis, Megaphone, MessageSquareText } from '@lucide/vue';
import { useClipboard } from '@vueuse/core';
import type { MessageView } from '@/shared/models/view-types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import ExpandableText from './ExpandableText.vue';
import LoadingDots from './LoadingDots.vue';

const props = defineProps<{ message: MessageView; pending?: boolean }>();
const { copy } = useClipboard({ copiedDuring: 1500, legacy: true });

const icon = computed(() => {
  if (props.message.kind === 'system') return Megaphone;
  if (props.message.kind === 'note') return MessageSquareText;
  return Bot;
});

const time = computed(() =>
  new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(props.message.createdAt)),
);
</script>

<template>
  <div
    :class="
      cn(
        'message-row',
        message.kind === 'send'
          ? message.senderIsUser
            ? 'message-row-right'
            : 'message-row-left'
          : 'message-row-notice',
      )
    "
  >
    <Avatar v-if="message.kind === 'send'" aria-hidden="true">
      <AvatarFallback>{{ message.senderName.slice(0, 1) }}</AvatarFallback>
    </Avatar>
    <Bubble
      :align="message.kind === 'send' && message.senderIsUser ? 'end' : 'start'"
      :variant="
        message.kind === 'system'
          ? 'outline'
          : message.kind === 'note'
            ? 'outline'
            : message.senderIsUser || message.senderIsLead
              ? 'secondary'
              : 'ghost'
      "
    >
      <BubbleContent>
        <div class="message-head">
          <span v-if="message.kind !== 'send'" class="message-icon">
            <component :is="icon" />
          </span>
          <p class="min-w-0 flex-1 truncate text-xs">
            <span class="message-sender font-medium">{{
              message.senderName
            }}</span>
            <span class="message-route text-muted-foreground"
              >→ {{ message.recipientName }}</span
            >
          </p>
          <Badge
            v-if="message.kind !== 'send'"
            :variant="message.kind === 'system' ? 'secondary' : 'outline'"
          >
            {{ message.kind === 'note' ? '留言' : '通知' }}
          </Badge>
          <time
            :datetime="message.createdAt"
            :title="new Date(message.createdAt).toLocaleString('zh-CN')"
            class="message-time text-xs text-muted-foreground tabular-nums"
            >{{ time }}</time
          >
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button
                variant="ghost"
                size="icon-xs"
                :aria-label="`消息 #${message.seq} 的操作`"
                ><Ellipsis
              /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>消息 #{{ message.seq }}</DropdownMenuLabel>
              <DropdownMenuLabel
                ><span
                  class="block max-w-64 break-all text-xs font-normal text-muted-foreground"
                  >{{ message.id }}</span
                ></DropdownMenuLabel
              >
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem @select="copy(message.text)"
                  ><Copy />复制内容</DropdownMenuItem
                >
                <DropdownMenuItem @select="copy(message.id)"
                  >复制消息 ID</DropdownMenuItem
                >
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <ExpandableText
          v-if="message.text || !props.pending"
          class="message-body text-sm leading-7"
          :text="message.text"
        />
        <LoadingDots v-else class="text-muted-foreground" />
      </BubbleContent>
    </Bubble>
  </div>
</template>
