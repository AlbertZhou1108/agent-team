<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { ChevronDown, NotebookPen } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useUiStore } from '@/stores/ui';

const props = defineProps<{
  submit: (body: string) => Promise<void>;
}>();

const ui = useUiStore();
const draft = ref('');
const saving = ref(false);
const error = ref('');
const input = ref<{ $el?: HTMLTextAreaElement } | null>(null);

// 默认收起:进随心记多半是来翻记录的,写新的一条按需展开。
// 折叠状态与其它模块一样跟人走,不随页面重挂载复位。
const expanded = computed({
  get: () => !ui.noteComposerCollapsed,
  set: (value: boolean) => {
    ui.noteComposerCollapsed = !value;
    ui.persist();
  },
});

// 收起态仍要看得见已写的内容:截断显示首行,不像草稿被丢掉了。
const collapsedLabel = computed(() => {
  const text = draft.value.trim().replace(/\s+/g, ' ');
  return text || '想到什么就写下来……';
});

async function setExpanded(value: boolean) {
  expanded.value = value;
  if (value) {
    await nextTick();
    input.value?.$el?.focus({ preventScroll: true });
  }
}

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
  // 空草稿时 Esc 直接收起,回到浏览。
  if (event.key === 'Escape' && !draft.value.trim()) {
    event.preventDefault();
    expanded.value = false;
  }
}

function focusInput() {
  if (!expanded.value) {
    void setExpanded(true);
    return;
  }
  input.value?.$el?.focus();
}

defineExpose({ focusInput });
</script>

<template>
  <Collapsible :open="expanded" class="flex flex-col gap-2" @update:open="setExpanded">
    <!-- 收起态是一行入口,不是只读预览:点一下就能写。 -->
    <CollapsibleTrigger v-show="!expanded" as-child>
      <button
        type="button"
        class="flex w-full min-w-0 items-center gap-2 rounded-(--component-control-radius) border border-input px-3 py-2 text-start text-sm outline-none transition-[color,box-shadow] hover:bg-(--state-hover) focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-3"
      >
        <NotebookPen class="size-4 shrink-0 text-muted-foreground" />
        <span
          class="min-w-0 flex-1 truncate"
          :class="draft.trim() ? '' : 'text-muted-foreground'"
        >{{ collapsedLabel }}</span>
        <ChevronDown class="size-4 shrink-0 text-muted-foreground" />
      </button>
    </CollapsibleTrigger>

    <CollapsibleContent>
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
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="text-xs text-muted-foreground">标题会取第一行 · ⌘/Ctrl + Enter</span>
          <div class="flex items-center gap-2">
            <Button variant="ghost" size="sm" @click="expanded = false">收起</Button>
            <Button size="sm" :disabled="!draft.trim() || saving" @click="save">
              <NotebookPen />
              {{ saving ? '记下来…' : '记下来' }}
            </Button>
          </div>
        </div>
        <p v-if="error" class="text-xs text-destructive">{{ error }}</p>
      </div>
    </CollapsibleContent>
  </Collapsible>
</template>
