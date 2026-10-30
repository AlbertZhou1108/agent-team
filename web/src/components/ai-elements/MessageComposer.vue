<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { createComposerActions } from './composer-actions';
import { ArrowUp, ChevronDown, ChevronUp, LoaderCircle } from '@lucide/vue';
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
const textarea = ref<{ $el?: HTMLTextAreaElement } | null>(null);
let resize: { startY: number; startHeight: number } | undefined;
const emit = defineEmits<{ submit: [] }>();
const { submit, onKeydown } = createComposerActions(
  () => ({ draft: draft.value, sending: props.sending, disabled: props.disabled }),
  () => emit('submit'),
);

// 折叠态只留一行:草稿非空时显示首行,否则显示占位提示,避免收起后看不出内容。
const collapsed = computed({
  get: () => ui.composerCollapsed,
  set: (value: boolean) => {
    ui.composerCollapsed = value;
    ui.persist();
  },
});
const draftPreview = computed(() => draft.value.trim().split('\n')[0] || props.placeholder);

async function expand() {
  if (props.disabled) return;
  collapsed.value = false;
  await nextTick();
  textarea.value?.$el?.focus();
}

function collapse() {
  collapsed.value = true;
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
  <!-- 容器查询按输入区自身宽度决定控件密度:侧栏展开时聊天列可能远窄于视口。 -->
  <div class="agent-composer-shell">
    <button
      v-if="collapsed"
      type="button"
      class="agent-composer-collapsed"
      :aria-label="`展开输入区${draft.trim() ? '，草稿：' + draftPreview : ''}`"
      :aria-expanded="false"
      :disabled="disabled"
      @click="expand"
    >
      <span class="min-w-0 flex-1 truncate" :class="{ 'text-muted-foreground': !draft.trim() }">{{ draftPreview }}</span>
      <ChevronUp class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
    <form
      v-else
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
          ref="textarea"
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
          <span class="composer-hint ml-auto text-muted-foreground">
            Enter 发送 · Shift + Enter 换行
          </span>
          <slot name="actions" />
          <InputGroupButton
            type="button"
            size="icon-sm"
            variant="ghost"
            :disabled="sending"
            aria-label="收起输入区"
            title="收起输入区"
            @click="collapse"
          >
            <ChevronDown />
          </InputGroupButton>
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
  </div>
</template>

<style scoped>
.agent-composer-shell {
  container-type: inline-size;
}

.agent-composer-collapsed {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: transparent;
  color: var(--foreground);
  font-size: 0.875rem;
  text-align: left;
  cursor: pointer;
}

.agent-composer-collapsed:hover {
  background: var(--accent);
}

/* 窄输入区收掉快捷键提示与控件文字,让模型、权限、设置与发送保持一行。
   宽度按输入区自身测量:侧栏展开时聊天列可能远窄于视口。 */
@container (max-width: 560px) {
  .composer-hint {
    display: none;
  }
}
</style>
