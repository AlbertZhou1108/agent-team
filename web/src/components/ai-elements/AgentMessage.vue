<script setup lang="ts">
import { computed, inject, nextTick } from 'vue';
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertTriangle,
  Bot,
  Copy,
  Ellipsis,
  FileText,
  Megaphone,
  MessageSquareText,
  Quote,
} from '@lucide/vue';
import MessageAttachments from './MessageAttachments.vue';
import {
  filePreviewContext,
  splitPlainTextFileRefs,
} from '@/features/messages/file-refs';
import { parseReferences, referenceContext } from '@/features/messages/references';
import { tidyNoticeText } from '@/features/messages/system-notice';
import type { MessageView } from '@/shared/models/view-types';
import { useClipboard } from '@vueuse/core';
import { useRoute, useRouter } from 'vue-router';
import { cn } from '@/lib/utils';
import { identityColor, identityForeground } from '@/features/messages/identity';
import { formatAbsoluteTime, formatMessageTime } from '@/shared/message-time';
import { useNowMinute } from '@/shared/use-now-minute';
import ExpandableText from './ExpandableText.vue';
import LoadingDots from './LoadingDots.vue';
import MarkdownRenderer from './MarkdownRenderer.vue';

const props = withDefaults(
  defineProps<{
    message: MessageView;
    /** 同发送者连续消息的后续条:不重复头像与发件人名字,仅保留时间与正文。 */
    compact?: boolean;
    /** 该消息仍处于流式生成中:空正文时显示等待动画,且禁用引用。 */
    pending?: boolean;
    /** 群发合并条:同一次用户指令发往多位成员时,在标题列举全部接收者。 */
    fanoutRecipients?: string[];
    /** 助手/系统正文默认按 Markdown 渲染；用户输入保持纯文本。 */
    markdown?: boolean;
    /** 处于系统通知折叠堆栈内时按紧凑时间线行渲染，避免框套框。 */
    stacked?: boolean;
  }>(),
  { compact: false, fanoutRecipients: undefined, markdown: true, stacked: false },
);

const references = inject(referenceContext, null);
const filePreview = inject(filePreviewContext, null);
const route = useRoute();
const router = useRouter();
const quoted = computed(() => parseReferences(props.message.text));
// 历史投递失败通知里嵌着内部 UUID,展示时清掉;非 system 正文原样保留。
const bodyText = computed(() =>
  props.message.kind === 'system' ? tidyNoticeText(quoted.value.text) : quoted.value.text,
);
const plainFileSegments = computed(() =>
  !useMarkdown.value && filePreview ? splitPlainTextFileRefs(bodyText.value) : null,
);
const isFailureNotice = computed(
  () =>
    props.message.kind === 'system' &&
    /(?:没有送达|投递失败|发送失败|启动失败|异常|中断)/.test(bodyText.value),
);

function quote() {
  references?.add({
    id: props.message.id,
    seq: props.message.seq,
    sender: props.message.senderName,
    text: props.message.text,
  });
}

async function reveal(id: string) {
  const { interaction: _interaction, ...rest } = route.query;
  await router.replace({ query: { ...rest, message: id } });
  await nextTick();
  document
    .querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`)
    ?.scrollIntoView({ block: 'center' });
}

const { copy } = useClipboard({ copiedDuring: 1500, legacy: true });

// 全站共享一个分钟级时钟:页面常开跨过午夜时,昨天的消息不能还标成今天。
const now = useNowMinute();

const useMarkdown = computed(
  () => props.markdown && !(props.message.kind === 'send' && props.message.senderIsUser),
);

// 身份色以显示名为 key(群内唯一),让并发发言的成员一眼可辨。
const identity = computed(() => identityColor(props.message.senderName));
const identityFg = identityForeground();

const icon = computed(() => {
  if (props.message.kind === 'system') return isFailureNotice.value ? AlertTriangle : Megaphone;
  if (props.message.kind === 'note') return MessageSquareText;
  return Bot;
});

const timestamp = computed(() => new Date(props.message.createdAt));
const time = computed(() => formatMessageTime(timestamp.value, now.value));
const timeTitle = computed(() => formatAbsoluteTime(timestamp.value));
</script>

<template>
  <!-- 系统通知：轻量时间线事件条（无大描边卡片、无重复“通知”徽章），避免与对话气泡抢视觉层级。 -->
  <div
    v-if="message.kind === 'system'"
    class="message-item system-notice-item"
    data-testid="system-notice"
    :data-tone="isFailureNotice ? 'danger' : 'neutral'"
  >
    <div v-if="stacked" class="system-notice-row">
      <component :is="icon" class="system-notice-icon" aria-hidden="true" />
      <time
        :datetime="message.createdAt"
        :title="timeTitle"
        class="system-notice-time tabular-nums"
      >{{ time }}</time>
      <span class="system-notice-sep" aria-hidden="true">·</span>
      <span class="system-notice-text">{{ bodyText }}</span>
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button
            variant="ghost"
            size="icon-xs"
            class="message-actions shrink-0"
            :aria-label="`消息 #${message.seq} 的操作`"
          ><Ellipsis /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>消息 #{{ message.seq }}</DropdownMenuLabel>
          <DropdownMenuLabel
            ><span class="block max-w-64 break-all text-xs font-normal text-muted-foreground">{{
              message.id
            }}</span></DropdownMenuLabel
          >
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem @select="copy(message.text)"><Copy />复制内容</DropdownMenuItem>
            <DropdownMenuItem @select="copy(message.id)">复制消息 ID</DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>

    <div v-else class="system-notice-line">
      <span class="system-notice-hairline" aria-hidden="true" />
      <div class="system-notice-pill" :data-tone="isFailureNotice ? 'danger' : 'neutral'">
        <component :is="icon" class="system-notice-icon" aria-hidden="true" />
        <span class="system-notice-text">{{ bodyText }}</span>
        <span class="system-notice-sep" aria-hidden="true">·</span>
        <time
          :datetime="message.createdAt"
          :title="timeTitle"
          class="system-notice-time tabular-nums"
        >{{ time }}</time>
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button
              variant="ghost"
              size="icon-xs"
              class="message-actions system-notice-menu"
              :aria-label="`消息 #${message.seq} 的操作`"
            ><Ellipsis /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>消息 #{{ message.seq }}</DropdownMenuLabel>
            <DropdownMenuLabel
              ><span class="block max-w-64 break-all text-xs font-normal text-muted-foreground">{{
                message.id
              }}</span></DropdownMenuLabel
            >
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem @select="copy(message.text)"><Copy />复制内容</DropdownMenuItem>
              <DropdownMenuItem @select="copy(message.id)">复制消息 ID</DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <span class="system-notice-hairline" aria-hidden="true" />
    </div>

    <div v-if="$slots.below" class="mt-1 flex justify-start">
      <slot name="below" :message="message" />
    </div>
    <slot name="footer" :message="message" />
  </div>

  <!-- 普通对话 / 留言：上方可选折叠轨迹，中间气泡，下方动作栏（悬停显现，位于投递回执左侧）。 -->
  <div v-else class="message-item">
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
        <AvatarFallback :style="{ backgroundColor: identity, color: identityFg }">{{
          message.senderName.slice(0, 1)
        }}</AvatarFallback>
      </Avatar>
      <div
        v-else-if="message.kind === 'send'"
        class="message-avatar-gap"
        aria-hidden="true"
      />
      <div
        :class="
          cn(
            'message-body-col',
            message.kind === 'send' && message.senderIsUser && 'message-body-col--end',
          )
        "
      >
        <slot name="above" :message="message" />
        <Bubble
          :align="message.kind === 'send' && message.senderIsUser ? 'end' : 'start'"
          :variant="
            message.kind === 'note'
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
                <span class="message-sender font-medium" :style="{ color: identity }">{{
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
              <Badge v-if="message.kind !== 'send'" variant="outline">留言</Badge>
              <time
                :datetime="message.createdAt"
                :title="timeTitle"
                class="message-time text-xs text-muted-foreground tabular-nums"
                >{{ time }}</time
              >
            </div>
            <ExpandableText
              v-if="message.text || !props.pending"
              class="message-body text-sm leading-7"
              :text="bodyText"
              :lines="6"
            >
              <MarkdownRenderer v-if="useMarkdown" :content="bodyText" :defer="Boolean(pending)" />
              <span v-else-if="plainFileSegments" class="whitespace-pre-wrap wrap-anywhere">
                <template v-for="(segment, index) in plainFileSegments" :key="index">
                  <button
                    v-if="segment.type === 'file'"
                    type="button"
                    class="inline-file-chip"
                    :data-file-ref="segment.path"
                    :title="`预览 ${segment.path}`"
                    @click="filePreview?.open(segment.path)"
                  >
                    <FileText class="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span>{{ segment.label }}</span>
                  </button>
                  <template v-else>{{ segment.text }}</template>
                </template>
              </span>
            </ExpandableText>
            <LoadingDots v-else class="text-muted-foreground" />
            <MessageAttachments v-if="message.attachments?.length" :attachments="message.attachments" />
            <slot name="footer" :message="message" />
          </BubbleContent>
        </Bubble>
        <div
          :class="
            cn(
              'message-below',
              message.kind === 'send' && message.senderIsUser && 'message-below--end',
            )
          "
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
            <DropdownMenuContent :align="message.kind === 'send' && message.senderIsUser ? 'end' : 'start'">
              <DropdownMenuLabel>消息 #{{ message.seq }}</DropdownMenuLabel>
              <DropdownMenuLabel
                ><span
                  class="block max-w-64 break-all text-xs font-normal text-muted-foreground"
                  >{{ message.id }}</span
                ></DropdownMenuLabel
              >
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem v-if="references?.enabled.value && !pending" @select="quote"
                  ><Quote />引用消息</DropdownMenuItem
                >
                <DropdownMenuItem @select="copy(message.text)"
                  ><Copy />复制内容</DropdownMenuItem
                >
                <DropdownMenuItem @select="copy(message.id)"
                  >复制消息 ID</DropdownMenuItem
                >
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <slot name="below" :message="message" />
        </div>
      </div>
    </div>
  </div>
</template>
