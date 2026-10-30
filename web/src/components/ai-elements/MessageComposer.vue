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

// 禁用只限制发送,展开仍应允许:用户需要能查看自己写下的草稿。
async function expand() {
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
  <div v-if="collapsed" class="agent-composer-collapsed">
    <button
      type="button"
      class="agent-composer-collapsed-label"
      :aria-label="`展开输入区${draft.trim() ? '，草稿：' + draftPreview : ''}`"
      :aria-expanded="false"
      @click="expand"
    >
      <span class="min-w-0 flex-1 truncate" :class="{ 'text-muted-foreground': !draft.trim() }">{{ draftPreview }}</span>
    </button>
    <!-- 收起后运行仍可能在进行,操作入口(如停止)必须保留。 -->
    <slot name="actions" />
    <button
      type="button"
      class="agent-composer-expand"
      aria-label="展开输入区"
      @click="expand"
    >
      <ChevronUp class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
  </div>
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
        <!-- 控件始终一行:窄列下由模型名截断让位,避免按钮被挤到第二行。 -->
        <InputGroupAddon align="block-end" class="flex-nowrap">
          <slot name="controls" />
          <div class="ml-auto flex flex-none items-center gap-2">
            <slot name="actions" />
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
          </div>
        </InputGroupAddon>
      </InputGroup>
    </form>
</template>

<style scoped>
/* 折叠态是一条可点击展开的整行,右侧保留仍在进行的操作(如停止)。 */
.agent-composer-collapsed {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 8px;
  padding: 6px 8px 6px 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: transparent;
}

.agent-composer-collapsed-label {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  padding: 4px 0;
  color: var(--foreground);
  font-size: 0.875rem;
  text-align: left;
  cursor: pointer;
}

.agent-composer-collapsed-label:hover {
  color: var(--foreground);
  opacity: 0.8;
}

.agent-composer-expand {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  cursor: pointer;
}

.agent-composer-expand:hover {
  background: var(--accent);
}
</style>
