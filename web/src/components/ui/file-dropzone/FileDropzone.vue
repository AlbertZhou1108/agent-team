<script setup lang="ts">
import { computed, ref } from 'vue';
import type { HTMLAttributes } from 'vue';
import { Upload } from '@lucide/vue';
import { cn } from 'cn';

const props = withDefaults(
  defineProps<{
    /** 传给 file input 的 accept,如 '.json,application/json';拖拽不经此过滤,由调用方校验 */
    accept?: string;
    multiple?: boolean;
    disabled?: boolean;
    label?: string;
    hint?: string;
    class?: HTMLAttributes['class'];
  }>(),
  {
    accept: undefined,
    multiple: false,
    disabled: false,
    label: '点击或拖入文件',
    hint: undefined,
  },
);

const emit = defineEmits<{ files: [files: File[]] }>();

const input = ref<HTMLInputElement | null>(null);
// enter/leave 配对计数:进入子元素也会触发 leave,用深度而非布尔避免闪烁。
const dragDepth = ref(0);
const dragging = computed(() => dragDepth.value > 0);

function openPicker() {
  if (props.disabled) return;
  input.value?.click();
}

function emitFiles(list: FileList | null | undefined) {
  if (props.disabled || !list?.length) return;
  emit('files', props.multiple ? Array.from(list) : [list[0]!]);
}

function onDragEnter() {
  if (!props.disabled) dragDepth.value += 1;
}
function onDragLeave() {
  dragDepth.value = Math.max(0, dragDepth.value - 1);
}
function onDrop(event: DragEvent) {
  dragDepth.value = 0;
  emitFiles(event.dataTransfer?.files);
}
function onChange(event: Event) {
  const target = event.target as HTMLInputElement;
  emitFiles(target.files);
  // 重置选择:同一文件修改后可再次选择。
  target.value = '';
}
</script>

<template>
  <div
    data-slot="file-dropzone"
    :data-dragging="dragging || undefined"
    role="button"
    tabindex="0"
    :aria-disabled="props.disabled"
    :class="
      cn(
        'flex cursor-pointer flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border p-4 text-center transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        dragging ? 'border-primary bg-(--state-pressed)' : 'hover:bg-(--state-hover)',
        props.disabled && 'pointer-events-none opacity-50',
        props.class,
      )
    "
    @click="openPicker"
    @keydown.enter.prevent="openPicker"
    @keydown.space.prevent="openPicker"
    @dragenter.prevent="onDragEnter"
    @dragover.prevent
    @dragleave.prevent="onDragLeave"
    @drop.prevent="onDrop"
  >
    <Upload class="size-4 text-muted-foreground" />
    <span class="text-sm">{{ label }}</span>
    <span v-if="hint" class="text-xs text-muted-foreground">{{ hint }}</span>
    <input
      ref="input"
      type="file"
      class="hidden"
      :accept="props.accept"
      :multiple="props.multiple"
      :disabled="props.disabled"
      @change="onChange"
    >
  </div>
</template>
