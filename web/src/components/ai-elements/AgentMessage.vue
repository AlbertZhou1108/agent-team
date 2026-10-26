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
import { identityColor } from '@/features/messages/identity';
import ExpandableText from './ExpandableText.vue';
import LoadingDots from './LoadingDots.vue';
import MarkdownRenderer from './MarkdownRenderer.vue';

const props = withDefaults(
  defineProps<{
    message: MessageView;
    pending?: boolean;
    /** 同发送者连续消息的后续条:隐藏头像与身份行,只保留正文与时间。 */
    compact?: boolean;
    /** 群发指令展示:正文渲染一次,头部改为完整接收者列表。 */
    fanoutRecipients?: string[];
    /** 助手/系统正文按 Markdown 渲染(用户消息始终纯文本);团队消息流默认关闭。 */
    markdown?: boolean;
  }>(),
  { compact: false, fanoutRecipients: undefined, markdown: false },
);
const { copy } = useClipboard({ copiedDuring: 1500, legacy: true });

// 构造 Intl.DateTimeFormat 的成本远高于格式化本身;消息行大列表要反复渲染,提到模块级复用。
const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const useMarkdown = computed(() => props.markdown && !(props.message.kind === 'send' && props.message.senderIsUser));

// 身份色以显示名为 key(群内唯一),让并发发言的成员一眼可辨。
const identity = computed(() => identityColor(props.message.senderName));

const icon = computed(() => {
  if (props.message.kind === 'system') return Megaphone;
  if (props.message.kind === 'note') return MessageSquareText;
  return Bot;
});

const timestamp = computed(() => new Date(props.message.createdAt));
const time = computed(() => timeFormatter.format(timestamp.value));
const timeTitle = computed(() => timestamp.value.toLocaleString('zh-CN'));
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
    <Avatar v-if="message.kind === 'send' && !compact" aria-hidden="true">
      <AvatarFallback
        :style="{ backgroundColor: identity, color: 'white' }"
      >{{ message.senderName.slice(0, 1) }}</AvatarFallback>
    </Avatar>
    <div
      v-else-if="message.kind === 'send'"
      class="message-avatar-gap"
      aria-hidden="true"
    />
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
        <div :class="cn('message-head', compact && 'message-head-compact')">
          <span v-if="message.kind !== 'send'" class="message-icon">
            <component :is="icon" />
          </span>
          <p v-if="!compact" class="min-w-0 flex-1 truncate text-xs">
            <span
              class="message-sender font-medium"
              :style="{ color: identity }"
            >{{
              message.senderName
            }}</span>
            <span class="message-route text-muted-foreground">
              →
              {{
                fanoutRecipients?.length
                  ? `${fanoutRecipients.join('、')}（${fanoutRecipients.length} 位成员）`
                  : message.recipientName
              }}</span
            >
          </p>
          <p v-else class="min-w-0 flex-1" aria-hidden="true" />
          <Badge
            v-if="message.kind !== 'send'"
            :variant="message.kind === 'system' ? 'secondary' : 'outline'"
          >
            {{ message.kind === 'note' ? '留言' : '通知' }}
          </Badge>
          <time
            :datetime="message.createdAt"
            :title="timeTitle"
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
        >
          <MarkdownRenderer v-if="useMarkdown" :content="message.text" :defer="Boolean(pending)" />
        </ExpandableText>
        <LoadingDots v-else class="text-muted-foreground" />
        <slot name="footer" :message="message" />
      </BubbleContent>
    </Bubble>
  </div>
</template>
