<script setup lang="ts">
import { ref } from 'vue';
import { ArrowUp, CircleStop, Settings2 } from '@lucide/vue';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from '@/components/ui/input-group';
import { useUiStore } from '@/stores/ui';
import type { PanelAgent } from '@/shared/api/raw-types';
import PanelAgentModelSelector from './PanelAgentModelSelector.vue';
import type { AvailableHost, PanelAgentForm } from './types';

const props = defineProps<{
  agent: PanelAgent;
  sending: boolean;
  stopping: boolean;
  hosts: AvailableHost[];
  catalogLoading: boolean;
  modelSaving: boolean;
}>();
const draft = defineModel<string>({ required: true });
const form = defineModel<PanelAgentForm>('form', { required: true });
const ui = useUiStore();
const resizing = ref(false);
let resize: { startY: number; startHeight: number } | undefined;
const emit = defineEmits<{
  submit: [];
  stop: [];
  edit: [];
  updateModel: [form: PanelAgentForm];
}>();

function onKeydown(event: KeyboardEvent) {
  if (event.isComposing || event.key !== 'Enter' || event.shiftKey) return;
  event.preventDefault();
  if (draft.value.trim() && !props.sending) emit('submit');
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
  <form
    class="agent-ai-composer"
    :class="{ 'is-resizing': resizing }"
    :style="{ '--agent-composer-height': `${ui.composerHeight}px` }"
    @submit.prevent="emit('submit')"
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
        placeholder="询问团队状态，或让 Panel Agent 准备一个新团队…"
        class="max-h-none min-h-20 flex-none field-sizing-fixed"
        :style="{ height: 'var(--agent-composer-height)' }"
        @keydown="onKeydown"
      />
      <InputGroupAddon align="block-end" class="flex-wrap">
        <PanelAgentModelSelector
          v-model:form="form"
          :hosts="hosts"
          size="sm"
          :disabled="sending || catalogLoading || modelSaving"
          @change="emit('updateModel', $event)"
        />
        <InputGroupButton
          size="icon-sm"
          variant="ghost"
          :disabled="sending || modelSaving"
          aria-label="Panel Agent 设置"
          title="Panel Agent 设置"
          @click="emit('edit')"
        >
          <Settings2 />
        </InputGroupButton>
        <span class="ml-auto hidden text-muted-foreground sm:inline">
          Enter 发送 · Shift + Enter 换行
        </span>
        <InputGroupButton
          v-if="sending"
          size="sm"
          variant="outline"
          :disabled="stopping"
          @click="emit('stop')"
        >
          <CircleStop data-icon="inline-start" />
          {{ stopping ? '停止中…' : '停止' }}
        </InputGroupButton>
        <InputGroupButton
          type="submit"
          size="icon-sm"
          variant="default"
          :disabled="!draft.trim() || sending"
          aria-label="发送"
        >
          <ArrowUp />
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  </form>
</template>
