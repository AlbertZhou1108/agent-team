<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { createComposerActions } from './composer-actions';
import { ArrowUp, ChevronDown, ChevronUp, LoaderCircle } from '@lucide/vue';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
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
const compactInput = ref<{ $el?: HTMLInputElement } | null>(null);
let resize: { startY: number; startHeight: number } | undefined;
const emit = defineEmits<{ submit: [] }>();
const { submit, onKeydown } = createComposerActions(
  () => ({ draft: draft.value, sending: props.sending, disabled: props.disabled }),
  () => emit('submit'),
);

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
  >
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
        <!-- 运行中的停止入口在折叠后仍需可达。 -->
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
      </InputGroupAddon>
    </InputGroup>
  </form>
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
/* 简洁输入区:单行输入 + 操作。与展开态共用输入组件的视觉,只是高度收敛。 */
.agent-composer-compact :deep([data-slot="input-group"]) {
  height: 44px;
}

.agent-composer-compact :deep([data-slot="input-group-control"]) {
  height: 44px;
  padding-block: 0;
  font-size: 0.875rem;
}
</style>
