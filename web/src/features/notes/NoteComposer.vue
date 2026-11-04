<script setup lang="ts">
import { ref } from 'vue';
import { NotebookPen } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

const props = defineProps<{
  submit: (body: string) => Promise<void>;
}>();

const draft = ref('');
const saving = ref(false);
const error = ref('');
const input = ref<{ $el?: HTMLTextAreaElement } | null>(null);

async function save() {
  const body = draft.value.trim();
  if (!body || saving.value) return;
  saving.value = true;
  error.value = '';
  try {
    await props.submit(body);
    // 只有确认写入后才清空；失败时保留原文，避免用户重写。
    draft.value = '';
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    saving.value = false;
  }
}

function onKeydown(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    void save();
  }
}

function focusInput() {
  input.value?.$el?.focus();
}

defineExpose({ focusInput });
</script>

<template>
  <div class="flex flex-col gap-2">
    <Textarea
      ref="input"
      v-model="draft"
      rows="3"
      class="min-h-24 resize-y"
      placeholder="想到什么就写下来……"
      aria-label="记一条想法"
      @keydown="onKeydown"
    />
    <div class="flex items-center justify-between gap-2">
      <span class="text-xs text-muted-foreground">标题会取第一行 · ⌘/Ctrl + Enter</span>
      <Button size="sm" :disabled="!draft.trim() || saving" @click="save">
        <NotebookPen />
        {{ saving ? '记下来…' : '记下来' }}
      </Button>
    </div>
    <p v-if="error" class="text-xs text-destructive">{{ error }}</p>
  </div>
</template>
