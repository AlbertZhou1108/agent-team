<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { createComposerActions } from './composer-actions';
import { ArrowUp, ChevronDown, ChevronUp, FileText, LoaderCircle, Paperclip, Square, X } from '@lucide/vue';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupTextarea,
} from '@/components/ui/input-group';
import { cn } from '@/lib/utils';
import { Surface } from '@/components/surface';
import { ATTACHMENT_ACCEPT } from '@/shared/attachment-types';
import { useUiStore } from '@/stores/ui';
export type ComposerAttachmentStatus = 'uploading' | 'ready' | 'failed';

export type ComposerAttachment = {
  localId: string;
  name: string;
  size: number;
  status: ComposerAttachmentStatus;
  error?: string;
};

const props = withDefaults(defineProps<{
  sending: boolean;
  disabled?: boolean;
  placeholder?: string;
  label?: string;
  /** 发送按钮在运行中转为停止按钮;不支持停止的宿主保持加载态。 */
  stoppable?: boolean;
  stopping?: boolean;
  /** 附件草稿列表;提供时展示回形针、拖入区域与附件条。 */
  attachments?: ComposerAttachment[];
}>(), {
  disabled: false,
  placeholder: '输入消息…',
  label: '消息',
  stoppable: false,
  stopping: false,
  attachments: undefined,
});
const draft = defineModel<string>({ required: true });
const ui = useUiStore();
const resizing = ref(false);
const textarea = ref<{ $el?: HTMLTextAreaElement } | null>(null);
const compactInput = ref<{ $el?: HTMLInputElement } | null>(null);
let resize: { startY: number; startHeight: number } | undefined;
const emit = defineEmits<{ submit: []; stop: []; attach: [files: File[]]; removeAttachment: [localId: string] }>();
const { submit, onKeydown } = createComposerActions(
  () => ({ draft: draft.value, sending: props.sending, disabled: props.disabled, hasAttachments: Boolean(props.attachments?.length) }),
  () => emit('submit'),
);

// 附件上传中或失败时禁止发送;移除失败文件后即可发送剩余内容。
const attachmentsBusy = computed(() => Boolean(props.attachments?.some(item => item.status !== 'ready')));
const canSubmit = computed(() => {
  if (attachmentsBusy.value) return false;
  const hasText = Boolean(draft.value.trim());
  const hasAttachments = Boolean(props.attachments?.length);
  return (hasText || hasAttachments) && !props.sending && !props.disabled;
});
const collapsedAttachmentCount = computed(() => props.attachments?.length ?? 0);
const canAttach = computed(() => Boolean(props.attachments));

function formatAttachmentSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

const fileInput = ref<HTMLInputElement | null>(null);
function pickFiles() {
  fileInput.value?.click();
}
function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = '';
  if (files.length) emit('attach', files);
}
let dragDepth = 0;
const dragging = ref(false);
function onDragEnter(event: DragEvent) {
  if (!props.attachments || event.dataTransfer?.types?.includes('Files') === false) return;
  dragDepth += 1;
  dragging.value = true;
}
function onDragLeave() {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dragging.value = false;
}
function onDragOver(event: DragEvent) {
  if (dragging.value) event.preventDefault();
}
function onDrop(event: DragEvent) {
  dragDepth = 0;
  dragging.value = false;
  if (!props.attachments) return;
  event.preventDefault();
  const files = Array.from(event.dataTransfer?.files ?? []);
  if (files.length) emit('attach', files);
}

// 折叠是两种输入形态的切换,不是只读预览:两种形态都能继续输入与发送。
const collapsed = computed({
  get: () => ui.composerCollapsed,
  set: (value: boolean) => {
    ui.composerCollapsed = value;
    ui.persist();
  },
});

// 禁用只限制发送,展开仍应允许:用户需要能查看自己写下的草稿。
async function expand() {
  collapsed.value = false;
  await nextTick();
  textarea.value?.$el?.focus();
}

async function collapse() {
  collapsed.value = true;
  await nextTick();
  compactInput.value?.$el?.focus();
}

function setComposerHeight(height: number) {
  ui.composerHeight = Math.round(Math.min(360, Math.max(72, height)));
}

function beginResize(event: PointerEvent) {
  if (event.button !== 0) return;
  const handle = event.currentTarget as HTMLElement;
  handle.setPointerCapture(event.pointerId);
  resize = { startY: event.clientY, startHeight: ui.composerHeight };
  resizing.value = true;
  event.preventDefault();
}

function moveResize(event: PointerEvent) {
  if (!resize) return;
  setComposerHeight(resize.startHeight + resize.startY - event.clientY);
}

function endResize() {
  if (!resize) return;
  resize = undefined;
  resizing.value = false;
  ui.persist();
}

function keyboardResize(event: KeyboardEvent) {
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
  event.preventDefault();
  setComposerHeight(ui.composerHeight + (event.key === 'ArrowUp' ? 16 : -16));
  ui.persist();
}
</script>

<template>
  <!-- 折叠态是仍可输入的简洁行:单行输入、发送、展开切换,不展示模型与权限等次要控件。 -->
  <form
    v-if="collapsed"
    class="agent-composer-compact"
    @submit.prevent="submit"
    @dragenter="onDragEnter"
    @dragleave="onDragLeave"
    @dragover="onDragOver"
    @drop="onDrop"
  >
    <!-- 折叠态仍显示附件数量;点它展开完整输入区管理附件。 -->
    <button
      v-if="collapsedAttachmentCount"
      type="button"
      class="mb-1 flex items-center gap-1 rounded-md border border-dashed px-2 py-0.5 text-xs text-muted-foreground outline-none hover:bg-(--state-hover) focus-visible:ring-2 focus-visible:ring-ring/50"
      aria-label="展开输入区管理附件"
      @click="expand"
    >
      <Paperclip class="size-3" />
      <span class="tabular-nums">{{ collapsedAttachmentCount }} 个附件</span>
    </button>
    <InputGroup>
      <InputGroupInput
        ref="compactInput"
        v-model="draft"
        maxlength="48000"
        :placeholder="placeholder"
        :aria-label="label"
        :disabled="disabled"
        @keydown="onKeydown"
      />
      <InputGroupAddon align="inline-end" class="gap-1">
        <InputGroupButton
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="展开输入区"
          title="展开输入区"
          @click="expand"
        >
          <ChevronUp />
        </InputGroupButton>
        <!-- 运行中的发送按钮即停止入口,不再并列第二个停止按钮。 -->
        <InputGroupButton
          v-if="sending && stoppable"
          type="button"
          size="icon-sm"
          variant="secondary"
          :disabled="stopping"
          :aria-label="stopping ? '正在停止' : '停止'"
          :title="stopping ? '正在停止' : '停止'"
          @click="emit('stop')"
        >
          <LoaderCircle v-if="stopping" class="animate-spin" />
          <Square v-else class="fill-current" />
        </InputGroupButton>
        <InputGroupButton
          v-else
          type="submit"
          size="icon-sm"
          variant="default"
          :disabled="!canSubmit"
          :aria-label="sending ? '发送中' : '发送'"
        >
          <LoaderCircle v-if="sending" class="animate-spin" />
          <ArrowUp v-else />
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
    <input
      v-if="canAttach"
      ref="fileInput"
      type="file"
      class="hidden"
      multiple
      :accept="ATTACHMENT_ACCEPT"
      :aria-label="'选择附件文件'"
      @change="onFileChange"
    />
  </form>
  <Surface v-else role="action" as="form"
    :class="cn('agent-ai-composer', resizing && 'is-resizing', dragging && 'is-dragging')"
    :style="{ '--agent-composer-height': `${ui.composerHeight}px` }"
    @submit.prevent="submit"
    @dragenter="onDragEnter"
    @dragleave="onDragLeave"
    @dragover="onDragOver"
    @drop="onDrop"
  >
      <div
        class="agent-composer-resize-handle"
        role="separator"
        tabindex="0"
        aria-label="调整输入区高度"
        aria-orientation="horizontal"
        :aria-valuemin="72"
        :aria-valuemax="360"
        :aria-valuenow="ui.composerHeight"
        @pointerdown="beginResize"
        @pointermove="moveResize"
        @pointerup="endResize"
        @pointercancel="endResize"
        @lostpointercapture="endResize"
        @keydown="keyboardResize"
      />
      <!-- 附件条:每个文件显示名称、大小、上传状态与移除;键盘可操作。 -->
      <div
        v-if="attachments?.length"
        class="flex flex-wrap gap-2 pb-2"
        role="list"
        :aria-label="'待发送附件'"
      >
        <div
          v-for="attachment in attachments"
          :key="attachment.localId"
          role="listitem"
          class="flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-xs"
          :class="attachment.status === 'failed' ? 'border-destructive/50 text-destructive' : ''"
        >
          <LoaderCircle v-if="attachment.status === 'uploading'" class="size-3.5 shrink-0 animate-spin text-muted-foreground" />
          <FileText v-else class="size-3.5 shrink-0 text-muted-foreground" />
          <span class="min-w-0 max-w-48 truncate" :title="attachment.name">{{ attachment.name }}</span>
          <span class="shrink-0 text-muted-foreground">{{ formatAttachmentSize(attachment.size) }}</span>
          <span
            v-if="attachment.status === 'uploading'"
            class="shrink-0 text-muted-foreground"
          >上传中…</span>
          <span
            v-else-if="attachment.status === 'failed'"
            class="shrink-0"
            :title="attachment.error"
          >上传失败</span>
          <button
            type="button"
            class="shrink-0 rounded-sm p-0.5 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
            :aria-label="`移除附件 ${attachment.name}`"
            :title="`移除附件 ${attachment.name}`"
            @click="emit('removeAttachment', attachment.localId)"
          >
            <X class="size-3.5" />
          </button>
        </div>
      </div>
      <InputGroup>
        <InputGroupTextarea
          ref="textarea"
          v-model="draft"
          rows="2"
          maxlength="48000"
          :placeholder="dragging ? '松开以添加附件' : placeholder"
          :aria-label="label"
          :disabled="disabled"
          class="max-h-none min-h-20 flex-none field-sizing-fixed"
          :style="{ height: 'var(--agent-composer-height)' }"
          @keydown="onKeydown"
        />
        <!-- 控件始终一行:窄列下由模型名截断让位,避免按钮被挤到第二行。 -->
        <InputGroupAddon align="block-end" class="flex-nowrap">
          <slot name="controls" />
          <div class="ml-auto flex flex-none items-center gap-2">
            <InputGroupButton
              v-if="canAttach"
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="添加附件"
              title="添加附件(文本文件或 PNG/JPEG 图片)"
              @click="pickFiles"
            >
              <Paperclip />
            </InputGroupButton>
            <InputGroupButton
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="收起输入区"
              title="收起输入区"
              @click="collapse"
            >
              <ChevronDown />
            </InputGroupButton>
            <!-- 运行中的发送按钮即停止入口,与折叠态保持同一位置和语义。 -->
            <InputGroupButton
              v-if="sending && stoppable"
              type="button"
              size="icon-sm"
              variant="secondary"
              :disabled="stopping"
              :aria-label="stopping ? '正在停止' : '停止'"
              :title="stopping ? '正在停止' : '停止'"
              @click="emit('stop')"
            >
              <LoaderCircle v-if="stopping" class="animate-spin" />
              <Square v-else class="fill-current" />
            </InputGroupButton>
            <InputGroupButton
              v-else
              type="submit"
              size="icon-sm"
              variant="default"
              :disabled="!canSubmit"
              :aria-label="sending ? '发送中' : '发送'"
            >
              <LoaderCircle v-if="sending" class="animate-spin" />
              <ArrowUp v-else />
            </InputGroupButton>
          </div>
        </InputGroupAddon>
      </InputGroup>
      <input
        v-if="canAttach"
        ref="fileInput"
        type="file"
        class="hidden"
        multiple
        :accept="ATTACHMENT_ACCEPT"
        :aria-label="'选择附件文件'"
        @change="onFileChange"
      />
    </Surface>
</template>

<style scoped>
/* 简洁输入区:单行输入 + 操作。与展开态共用输入组件的视觉,只是高度收敛;
   内边距对齐展开态(.agent-ai-composer 的 10/14/12),避免在 px-0 的帧容器里贴边。 */
.agent-composer-compact {
  padding: 0 16px 12px;
}

.agent-composer-compact :deep([data-slot="input-group"]) {
  height: 44px;
}

.agent-ai-composer.is-dragging :deep([data-slot="input-group"]) {
  outline: 2px dashed var(--color-ring, currentColor);
  outline-offset: 2px;
}

.agent-composer-compact :deep([data-slot="input-group-control"]) {
  height: 44px;
  padding-block: 0;
  font-size: 0.875rem;
}
</style>
