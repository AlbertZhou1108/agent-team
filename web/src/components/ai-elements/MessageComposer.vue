<script setup lang="ts">
import { ref } from 'vue';
import { createComposerActions } from './composer-actions';
import { ArrowUp, LoaderCircle } from '@lucide/vue';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from '@/components/ui/input-group';
import { cn } from '@/lib/utils';
import { useUiStore } from '@/stores/ui';
const props = withDefaults(defineProps<{
  sending: boolean;
  disabled?: boolean;
  placeholder?: string;
  label?: string;
}>(), {
  disabled: false,
  placeholder: '输入消息…',
  label: '消息',
});
const draft = defineModel<string>({ required: true });
const ui = useUiStore();
const resizing = ref(false);
let resize: { startY: number; startHeight: number } | undefined;
const emit = defineEmits<{ submit: [] }>();
const { submit, onKeydown } = createComposerActions(
  () => ({ draft: draft.value, sending: props.sending, disabled: props.disabled }),
  () => emit('submit'),
);

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
  <form
    :class="cn('agent-ai-composer', resizing && 'is-resizing')"
    :style="{ '--agent-composer-height': `${ui.composerHeight}px` }"
    @submit.prevent="submit"
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
    <InputGroup>
      <InputGroupTextarea
        v-model="draft"
        rows="2"
        maxlength="48000"
        :placeholder="placeholder"
        :aria-label="label"
        :disabled="disabled"
        class="max-h-none min-h-20 flex-none field-sizing-fixed"
        :style="{ height: 'var(--agent-composer-height)' }"
        @keydown="onKeydown"
      />
      <InputGroupAddon align="block-end" class="flex-wrap">
        <slot name="controls" />
        <span class="ml-auto hidden text-muted-foreground sm:inline">
          Enter 发送 · Shift + Enter 换行
        </span>
        <slot name="actions" />
        <InputGroupButton
          type="submit"
          size="icon-sm"
          variant="default"
          :disabled="!draft.trim() || sending || disabled"
          :aria-label="sending ? '发送中' : '发送'"
        >
          <LoaderCircle v-if="sending" class="animate-spin" />
          <ArrowUp v-else />
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  </form>
</template>
