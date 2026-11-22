<script setup lang="ts">
import { computed } from 'vue';
import { useClipboard } from '@vueuse/core';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { NoteBlock } from '@/components/ui/note-block';
import { directiveStatus } from './directive-status';
import { recipientLabel } from './recipient-label';
import { formatMessageTime } from '@/shared/message-time';
import { useNowMinute } from '@/shared/use-now-minute';
import type { TeamDirectiveReceipt } from '@/shared/api/raw-types';

const props = defineProps<{
  open: boolean;
  receipt: TeamDirectiveReceipt | null;
}>();

const emit = defineEmits<{ 'update:open': [value: boolean] }>();

const now = useNowMinute();
const state = computed(() => (props.receipt ? directiveStatus(props.receipt) : null));
// 时间与消息流共用同一套规则：当天时:分:秒，跨天补全年月日。
const time = computed(() =>
  props.receipt ? formatMessageTime(new Date(props.receipt.created), now.value) : '',
);

/** 为什么没送到（或为什么算异常），一句话说清楚，细节留给下面的原文。 */
const summary = computed(() => {
  const receipt = props.receipt;
  if (!receipt) return '';
  const target = `「${recipientLabel(receipt)}」`;
  if (receipt.status === 'delivered') return `消息已送达${target}，但这一回合执行时报错。`;
  if (receipt.status === 'unknown') return `发给${target}的消息状态读不出来，请核实是否已处理。`;
  return `发给${target}的消息没有送达。`;
});

const copyable = computed(() => Boolean(props.receipt?.error?.trim()));

// 报错原文一字不改地展示：用户看不懂可以整段拷走问 AI，压缩反而害事。
const detail = computed(() => {
  const error = props.receipt?.error?.trim();
  if (error) return error;
  return props.receipt?.status === 'unknown'
    ? '宿主状态读不出来，无法确认这条消息是否已处理。'
    : '宿主没有返回具体原因。';
});

const { copy, copied } = useClipboard({ copiedDuring: 1500, legacy: true });
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent
      class="flex max-h-[min(560px,85vh)] min-h-[240px] flex-col gap-6 p-6"
      :show-close-button="false"
    >
      <!-- 时间挨着标题，副标题只讲"发给谁、有没有送到"。 -->
      <DialogHeader class="shrink-0">
        <DialogTitle class="flex items-baseline gap-2">
          {{ state?.label }}
          <time
            v-if="time"
            :datetime="receipt?.created"
            class="text-xs font-normal text-muted-foreground tabular-nums"
            >{{ time }}</time
          >
        </DialogTitle>
        <DialogDescription>{{ summary }}</DialogDescription>
      </DialogHeader>
      <!-- flex-[1_1_auto]：内容短就贴合内容，撞到弹窗上限才收缩并出现滚动条，
           而不是 basis 0 把短内容压扁、或无限撑高把按钮推出视口。
           break-words 只在整行放不下时才硬断：日志按空格换行，URL 不会被拦腰截断。 -->
      <NoteBlock
        as="pre"
        class="m-0 min-h-0 flex-[1_1_auto] overflow-auto border border-border/60 bg-muted/50 p-3.5 font-mono text-2xs leading-relaxed whitespace-pre-wrap break-words"
        >{{ detail }}</NoteBlock
      >
      <!-- 只陈述事实:失败了系统不会自己再试一遍,别让用户干等。
           "该怎么办"留给用户拿走原文去问 AI——按错误类型猜下一步的规则覆盖不全,反而误导。 -->
      <p class="shrink-0 text-xs text-muted-foreground">系统不会自动重试。</p>
      <DialogFooter class="shrink-0">
        <Button variant="outline" size="sm" @click="emit('update:open', false)">关闭</Button>
        <Button v-if="copyable" size="sm" @click="copy(detail)">
          {{ copied ? '已复制' : '复制报错' }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
