<script setup lang="ts">
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { computed, inject, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { referenceContext, parseReferences } from '@/features/messages/references';
import { Bot, Quote, Copy, Ellipsis, Megaphone, MessageSquareText } from '@lucide/vue';
import MessageAttachments from './MessageAttachments.vue';
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
    /** 助手/系统正文默认按 Markdown 渲染；用户输入保持纯文本。 */
    markdown?: boolean;
  }>(),
  { compact: false, fanoutRecipients: undefined, markdown: true },
);
const references=inject(referenceContext,null);
const route=useRoute();
const router=useRouter();
const quoted=computed(()=>parseReferences(props.message.text));
function quote(){references?.add({id:props.message.id,seq:props.message.seq,sender:props.message.senderName,text:props.message.text});}
async function reveal(id:string){const {interaction: _interaction,...rest}=route.query;await router.replace({query:{...rest,message:id}});await nextTick();document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`)?.scrollIntoView({block:'center'});}
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
        <!-- 引用块:按钮自带 whitespace-nowrap/shrink-0,这里必须放开换行并允许收缩,
             否则长引用不换行,被气泡的 overflow-hidden 裁掉右边。 -->
        <div v-if="quoted.items.length" class="flex min-w-0 flex-col gap-1 pb-2">
          <Button
            v-for="item in quoted.items"
            :key="item.id"
            variant="outline"
            size="sm"
            class="h-auto w-full min-w-0 shrink justify-start whitespace-normal"
            @click="reveal(item.id)"
          >
            <span class="flex min-w-0 flex-col items-start gap-1">
              <span>{{ item.sender }} · #{{ item.seq }}</span>
              <span class="line-clamp-2 break-all text-left">{{ item.text }}</span>
            </span>
          </Button>
        </div>
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
                class="message-actions"
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
                <DropdownMenuItem v-if="references?.enabled.value && !pending" @select="quote"><Quote />引用消息</DropdownMenuItem>
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
          :text="quoted.text"
        >
          <MarkdownRenderer v-if="useMarkdown" :content="quoted.text" :defer="Boolean(pending)" />
        </ExpandableText>
        <LoadingDots v-else class="text-muted-foreground" />
        <MessageAttachments v-if="message.attachments?.length" :attachments="message.attachments" />
        <slot name="footer" :message="message" />
      </BubbleContent>
    </Bubble>
  </div>
</template>
