<script setup lang="ts">
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { computed, inject, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { referenceContext, parseReferences } from '@/features/messages/references';
import { tidyNoticeText } from '@/features/messages/system-notice';
import { formatAbsoluteTime, formatMessageTime } from '@/shared/message-time';
import { useNowMinute } from '@/shared/use-now-minute';
import { Bot, Quote, Copy, Ellipsis, FileText, Megaphone, MessageSquareText } from '@lucide/vue';
import MessageAttachments from './MessageAttachments.vue';
import { extractFilePathRefs, filePreviewContext, fileRefBasename } from '@/features/messages/file-refs';
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
import { identityColor, identityForeground } from '@/features/messages/identity';
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
const filePreview=inject(filePreviewContext,null);
const route=useRoute();
const router=useRouter();
const quoted=computed(()=>parseReferences(props.message.text));
// 历史投递失败通知里嵌着内部 UUID,展示时清掉;非 system 正文原样保留。
const bodyText=computed(()=>props.message.kind==='system'?tidyNoticeText(quoted.value.text):quoted.value.text);
const fileRefs=computed(()=>props.message.kind==='system'?[]:extractFilePathRefs(bodyText.value));
function quote(){references?.add({id:props.message.id,seq:props.message.seq,sender:props.message.senderName,text:props.message.text});}
async function reveal(id:string){const {interaction: _interaction,...rest}=route.query;await router.replace({query:{...rest,message:id}});await nextTick();document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`)?.scrollIntoView({block:'center'});}
const { copy } = useClipboard({ copiedDuring: 1500, legacy: true });

// 全站共享一个分钟级时钟:页面常开跨过午夜时,昨天的消息不能还标成今天。
const now = useNowMinute();

const useMarkdown = computed(() => props.markdown && !(props.message.kind === 'send' && props.message.senderIsUser));

// 身份色以显示名为 key(群内唯一),让并发发言的成员一眼可辨。
const identity = computed(() => identityColor(props.message.senderName));
const identityFg = identityForeground();

const icon = computed(() => {
  if (props.message.kind === 'system') return Megaphone;
  if (props.message.kind === 'note') return MessageSquareText;
  return Bot;
});

const timestamp = computed(() => new Date(props.message.createdAt));
const time = computed(() => formatMessageTime(timestamp.value, now.value));
const timeTitle = computed(() => formatAbsoluteTime(timestamp.value));
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
        :style="{ backgroundColor: identity, color: identityFg }"
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
          <!-- 头部动作区:执行轨迹入口这类跟随消息的开关挂在这里,位于 ⋯ 菜单之前。 -->
          <slot name="header-actions" :message="message" />
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
          :text="bodyText"
          :lines="message.kind === 'system' ? 2 : 6"
        >
          <MarkdownRenderer v-if="useMarkdown" :content="bodyText" :defer="Boolean(pending)" />
        </ExpandableText>
        <LoadingDots v-else class="text-muted-foreground" />
        <MessageAttachments v-if="message.attachments?.length" :attachments="message.attachments" />
        <div
          v-if="fileRefs.length"
          class="mt-2 flex flex-wrap items-center gap-1.5"
          data-testid="message-file-refs"
        >
          <div
            v-for="refPath in fileRefs"
            :key="refPath"
            class="inline-flex max-w-full items-center gap-1 rounded-(--component-chip-radius) border border-border bg-muted/40 px-2 py-0.5 text-xs"
          >
            <FileText class="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
            <button
              v-if="filePreview"
              type="button"
              class="min-w-0 truncate font-mono text-xs text-foreground hover:underline"
              :title="`预览 ${refPath}`"
              @click="filePreview.open(refPath)"
            >
              {{ fileRefBasename(refPath) }}
            </button>
            <span v-else class="min-w-0 truncate font-mono text-xs text-foreground" :title="refPath">
              {{ fileRefBasename(refPath) }}
            </span>
            <button
              type="button"
              class="inline-flex shrink-0 items-center text-muted-foreground transition-colors hover:text-foreground"
              :aria-label="`复制文件路径 ${refPath}`"
              :title="`复制路径：${refPath}`"
              @click="copy(refPath)"
            >
              <Copy class="size-3" />
            </button>
          </div>
        </div>
        <slot name="footer" :message="message" />
      </BubbleContent>
    </Bubble>
  </div>
</template>
