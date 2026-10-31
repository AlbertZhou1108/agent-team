<script setup lang="ts">
import { computed, ref } from 'vue';
import { ChevronLeft, ChevronRight, Download, FileText, FileWarning, LoaderCircle } from '@lucide/vue';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { api } from '@/shared/api/client';
import type { MessageAttachment } from '@/shared/api/raw-types';
import { formatAttachmentSize, TEXT_PREVIEW_LIMIT } from '@/shared/attachment-types';

// 消息附件预览:图片点击进灯箱(同消息多图可左右切换),文本点击进内容预览,
// 缺失附件保留占位。下载动作统一收在预览弹层内,不依赖浏览器右键。
const props = defineProps<{
  attachments: MessageAttachment[];
}>();

const imageAttachments = computed(() =>
  props.attachments.filter(
    (attachment) => attachment.availability === 'available' && attachment.mediaType.startsWith('image/'),
  ),
);

// ===== 图片灯箱:index >= 0 表示打开 =====
const imageIndex = ref(-1);
const currentImage = computed(() => imageAttachments.value[imageIndex.value] ?? null);
function openImage(attachment: MessageAttachment) {
  const index = imageAttachments.value.findIndex((item) => item.id === attachment.id);
  if (index >= 0) imageIndex.value = index;
}
function closeImage() {
  imageIndex.value = -1;
}
const canPrevImage = computed(() => imageIndex.value > 0);
const canNextImage = computed(() => imageIndex.value >= 0 && imageIndex.value < imageAttachments.value.length - 1);
function stepImage(delta: -1 | 1) {
  if (delta === -1 && canPrevImage.value) imageIndex.value -= 1;
  if (delta === 1 && canNextImage.value) imageIndex.value += 1;
}

// ===== 文本预览:小文件拉取内容,大文件只提示下载 =====
const textPreview = ref<{
  attachment: MessageAttachment;
  state: 'loading' | 'ready' | 'truncated' | 'too-large' | 'error';
  content?: string;
  error?: string;
} | null>(null);
const textCache = new Map<string, string>();

function closeTextPreview() {
  textPreview.value = null;
}

async function openText(attachment: MessageAttachment) {
  if (attachment.size > TEXT_PREVIEW_LIMIT) {
    textPreview.value = { attachment, state: 'too-large' };
    return;
  }
  const cached = textCache.get(attachment.id);
  if (cached !== undefined) {
    textPreview.value = { attachment, state: cached.length > TEXT_PREVIEW_LIMIT ? 'truncated' : 'ready', content: cached };
    return;
  }
  textPreview.value = { attachment, state: 'loading' };
  try {
    const response = await fetch(api.attachmentUrl(attachment.id), { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`读取失败(${response.status})`);
    const content = await response.text();
    textCache.set(attachment.id, content);
    if (textPreview.value?.attachment.id !== attachment.id) return; // 期间被关闭或切换
    textPreview.value = {
      attachment,
      state: content.length > TEXT_PREVIEW_LIMIT ? 'truncated' : 'ready',
      content,
    };
  } catch (cause) {
    if (textPreview.value?.attachment.id !== attachment.id) return;
    textPreview.value = {
      attachment,
      state: 'error',
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

function downloadAttachment(attachment: MessageAttachment | null) {
  if (!attachment) return;
  const anchor = document.createElement('a');
  anchor.href = api.attachmentUrl(attachment.id);
  anchor.download = attachment.name;
  anchor.click();
}

const truncatedContent = computed(() => {
  const content = textPreview.value?.content ?? '';
  return content.length > TEXT_PREVIEW_LIMIT ? content.slice(0, TEXT_PREVIEW_LIMIT) : content;
});
</script>

<template>
  <div v-if="attachments.length" class="mt-2 flex flex-wrap gap-2">
    <template v-for="attachment in attachments" :key="attachment.id">
      <button
        v-if="attachment.availability === 'available' && attachment.mediaType.startsWith('image/')"
        type="button"
        class="block max-w-full overflow-hidden rounded-md border outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        :aria-label="`查看图片附件 ${attachment.name}`"
        :title="`${attachment.name}（点击查看大图）`"
        @click="openImage(attachment)"
      >
        <img
          :src="api.attachmentUrl(attachment.id)"
          :alt="attachment.name"
          class="max-h-64 max-w-full object-contain"
          loading="lazy"
        />
      </button>
      <button
        v-else-if="attachment.availability === 'available'"
        type="button"
        class="flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-xs outline-none hover:bg-(--state-hover) focus-visible:ring-2 focus-visible:ring-ring/50"
        :aria-label="`预览文本附件 ${attachment.name}`"
        :title="`${attachment.name}（${formatAttachmentSize(attachment.size)}，点击预览）`"
        @click="openText(attachment)"
      >
        <FileText class="size-4 shrink-0 text-muted-foreground" />
        <span class="min-w-0 max-w-48 truncate">{{ attachment.name }}</span>
        <span class="shrink-0 text-muted-foreground">{{ formatAttachmentSize(attachment.size) }}</span>
      </button>
      <span
        v-else
        class="flex items-center gap-1.5 rounded-md border border-dashed px-2 py-1.5 text-xs text-muted-foreground"
        :title="`附件 ${attachment.name} 的文件已缺失`"
      >
        <FileWarning class="size-4 shrink-0" />
        <span class="min-w-0 max-w-48 truncate">{{ attachment.name }}</span>
        <span>附件缺失</span>
      </span>
    </template>
  </div>

  <!-- 图片灯箱:透明 Dialog 承载原图,多图左右切换,下载入口收在下方工具条。 -->
  <Dialog
    :open="currentImage !== null"
    @update:open="
      (value) => {
        if (!value) closeImage();
      }
    "
  >
    <DialogContent
      v-if="currentImage"
      class="max-w-none w-auto border-none bg-transparent p-0 shadow-none sm:max-w-[92vw]"
      :show-close-button="false"
      @keydown.left.prevent="stepImage(-1)"
      @keydown.right.prevent="stepImage(1)"
    >
      <DialogTitle class="sr-only">{{ currentImage.name }}</DialogTitle>
      <img
        :src="api.attachmentUrl(currentImage.id)"
        :alt="currentImage.name"
        class="max-h-[82vh] max-w-[92vw] rounded-md object-contain"
      />
      <div class="mt-2 flex items-center justify-center gap-2 text-xs text-white/85">
        <Button
          v-if="imageAttachments.length > 1"
          variant="outline"
          size="icon-xs"
          class="border-white/30 bg-black/40 text-white hover:bg-black/60"
          :disabled="!canPrevImage"
          aria-label="上一张图片"
          @click="stepImage(-1)"
        >
          <ChevronLeft />
        </Button>
        <span class="max-w-64 truncate" :title="currentImage.name">{{ currentImage.name }}</span>
        <span class="text-white/60">{{ formatAttachmentSize(currentImage.size) }}</span>
        <span v-if="imageAttachments.length > 1" class="text-white/60 tabular-nums">
          {{ imageIndex + 1 }} / {{ imageAttachments.length }}
        </span>
        <Button
          variant="outline"
          size="icon-xs"
          class="border-white/30 bg-black/40 text-white hover:bg-black/60"
          :aria-label="`下载 ${currentImage.name}`"
          :title="`下载 ${currentImage.name}`"
          @click="downloadAttachment(currentImage)"
        >
          <Download />
        </Button>
        <Button
          v-if="imageAttachments.length > 1"
          variant="outline"
          size="icon-xs"
          class="border-white/30 bg-black/40 text-white hover:bg-black/60"
          :disabled="!canNextImage"
          aria-label="下一张图片"
          @click="stepImage(1)"
        >
          <ChevronRight />
        </Button>
      </div>
    </DialogContent>
  </Dialog>

  <!-- 文本预览:小文件直接看内容,超大文件给下载入口。 -->
  <Dialog
    :open="textPreview !== null"
    @update:open="
      (value) => {
        if (!value) closeTextPreview();
      }
    "
  >
    <DialogContent v-if="textPreview" class="max-w-3xl">
      <!-- 下载按钮右对齐,pr-10 与右上角自带的关闭 × 保持距离;标题过长省略。 -->
      <div class="flex min-w-0 items-center justify-between gap-2 pr-10">
        <DialogTitle class="min-w-0 truncate text-sm font-semibold">{{ textPreview.attachment.name }}</DialogTitle>
        <Button
          variant="ghost"
          size="icon-sm"
          class="shrink-0 text-muted-foreground hover:text-foreground"
          :aria-label="`下载 ${textPreview.attachment.name}`"
          :title="`下载 ${textPreview.attachment.name}`"
          @click="downloadAttachment(textPreview.attachment)"
        >
          <Download />
        </Button>
      </div>
      <p class="text-xs text-muted-foreground">
        {{ formatAttachmentSize(textPreview.attachment.size) }}
        <template v-if="textPreview.state === 'too-large'"> · 超过预览上限，请下载查看</template>
        <template v-else-if="textPreview.state === 'truncated'"> · 内容已截断，下载查看全文</template>
      </p>
      <div
        v-if="textPreview.state === 'loading'"
        class="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground"
      >
        <LoaderCircle class="size-4 animate-spin" />
        正在读取内容…
      </div>
      <p v-else-if="textPreview.state === 'error'" class="py-6 text-sm text-destructive" role="alert">
        {{ textPreview.error ?? '内容读取失败' }}
      </p>
      <pre
        v-else-if="textPreview.state === 'ready' || textPreview.state === 'truncated'"
        class="scrollbar-thin max-h-[60vh] overflow-y-auto wrap-anywhere rounded-md border bg-muted/40 p-3 font-mono text-xs leading-5 whitespace-pre-wrap"
      >{{ truncatedContent }}</pre>
      <p v-else class="py-6 text-sm text-muted-foreground">
        文件超过 {{ Math.round(TEXT_PREVIEW_LIMIT / 1024) }} KB，不在对话内预览；点上方"下载"查看全文。
      </p>
    </DialogContent>
  </Dialog>
</template>
