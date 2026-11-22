<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { ChevronDown, ChevronUp, NotebookPen } from '@lucide/vue';
import {
  InputGroup,
  InputGroupInput,
  InputGroupTextarea,
  InputGroupAddon,
  InputGroupButton,
} from '@/components/ui/input-group';
import { useUiStore } from '@/stores/ui';

const props = defineProps<{
  submit: (body: string) => Promise<void>;
}>();

const ui = useUiStore();
const draft = ref('');
const saving = ref(false);
const error = ref('');
const input = ref<{ $el?: HTMLTextAreaElement } | null>(null);
const compactInput = ref<{ $el?: HTMLInputElement } | null>(null);

// 展开态的高度由手柄拖动决定,但必须有上限:长笔记只让框内滚动,不能把页面顶开。
// 128px 对齐 min-h-32;360px 与团队会话输入框同一个封顶值,矮屏再按视口收一档。
// 高度跟人走(存 ui store),换机器/矮屏时读出来的旧值也会被视口上限夹住。
const minHeight = 128;
const resizing = ref(false);
let drag: { startY: number; startHeight: number } | undefined;

function maxHeight() {
  // SSR(测试)里没有 window,直接按 360 的封顶值算。
  const viewport = typeof window === 'undefined' ? Number.POSITIVE_INFINITY : window.innerHeight * 0.45;
  return Math.max(minHeight, Math.min(360, Math.round(viewport)));
}

function clampHeight(value: number) {
  return Math.round(Math.min(maxHeight(), Math.max(minHeight, value)));
}

const noteHeight = computed({
  get: () => clampHeight(ui.noteComposerHeight),
  set: (value: number) => {
    ui.noteComposerHeight = clampHeight(value);
  },
});

function setHeight(value: number) {
  noteHeight.value = value;
}

function beginResize(event: PointerEvent) {
  if (event.button !== 0) return;
  const handle = event.currentTarget as HTMLElement;
  // 指针捕获让指针移出组件也继续跟手;测试环境没有这个 API,跳过即可。
  try {
    handle.setPointerCapture(event.pointerId);
  } catch {
    // 捕获失败不影响拖动本身。
  }
  drag = { startY: event.clientY, startHeight: noteHeight.value };
  resizing.value = true;
  event.preventDefault();
}

function moveResize(event: PointerEvent) {
  if (!drag) return;
  // 往下拖变高,与原生缩放手柄的手感一致。
  setHeight(drag.startHeight + event.clientY - drag.startY);
}

function endResize() {
  if (!drag) return;
  drag = undefined;
  resizing.value = false;
  // 拖完才落盘,拖动过程中不反复写 localStorage。
  ui.persist();
}

function keyboardResize(event: KeyboardEvent) {
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
  event.preventDefault();
  setHeight(noteHeight.value + (event.key === 'ArrowDown' ? 24 : -24));
  ui.persist();
}

// 默认收起:进随心记多半是来翻记录的,写新的一条按需展开。
// 折叠状态与其它模块一样跟人走,不随页面重挂载复位。
const expanded = computed({
  get: () => !ui.noteComposerCollapsed,
  set: (value: boolean) => {
    ui.noteComposerCollapsed = !value;
    ui.persist();
  },
});

async function setExpanded(value: boolean) {
  expanded.value = value;
  await nextTick();
  // 两种形态都能继续写:切换后把焦点交给当前可见的输入框。
  const target = value ? input.value?.$el : compactInput.value?.$el;
  target?.focus({ preventScroll: true });
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
  <div class="flex flex-col gap-2">
    <!-- 收起/展开共用一个切换按钮,和「记下来」一起嵌在文本框内。
         收起态是单行输入、展开态是多行文本,两种形态都保留草稿。 -->
    <InputGroup>
      <!-- 收起态:单行输入,切换与「记下来」嵌在框内右侧。 -->
      <template v-if="!expanded">
        <InputGroupInput
          ref="compactInput"
          v-model="draft"
          placeholder="想到什么就写下来……"
          aria-label="记一条想法"
          @keydown="onKeydown"
        />
        <InputGroupAddon align="inline-end" class="gap-1">
          <InputGroupButton
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="展开输入区"
            title="展开输入区"
            @click="setExpanded(true)"
          >
            <ChevronDown />
          </InputGroupButton>
          <InputGroupButton
            type="button"
            size="sm"
            :disabled="!draft.trim() || saving"
            @click="save"
          >
            <NotebookPen />
            {{ saving ? '记下来…' : '记下来' }}
          </InputGroupButton>
        </InputGroupAddon>
      </template>

      <!-- 展开态:多行文本 + 底部操作行,高度由右下角手柄拖动、带上下限。
           手柄自己画在整框右下角,不依赖 textarea 的原生缩放手柄 ——
           原生手柄只能落在 textarea 自己的角上,操作行一入流就会被顶到右缘中间。 -->
      <template v-else>
        <InputGroupTextarea
          ref="input"
          v-model="draft"
          rows="3"
          class="min-h-32 flex-none resize-none overflow-y-auto field-sizing-fixed"
          :style="{ height: `${noteHeight}px` }"
          placeholder="想到什么就写下来……"
          aria-label="记一条想法"
          @keydown="onKeydown"
        />
        <InputGroupAddon align="block-end" class="gap-2 pr-7">
          <span class="min-w-0 flex-1 truncate text-xs">
            标题会取第一行 · ⌘/Ctrl + Enter
          </span>
          <InputGroupButton
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="收起输入区"
            title="收起输入区"
            @click="setExpanded(false)"
          >
            <ChevronUp />
          </InputGroupButton>
          <InputGroupButton
            type="button"
            size="sm"
            :disabled="!draft.trim() || saving"
            @click="save"
          >
            <NotebookPen />
            {{ saving ? '记下来…' : '记下来' }}
          </InputGroupButton>
        </InputGroupAddon>
        <!-- 缩放手柄:与原生手柄同一个角落位置,可拖可键盘(↑/↓)调高。 -->
        <span
          role="separator"
          tabindex="0"
          aria-label="调整输入区高度"
          aria-orientation="horizontal"
          :aria-valuemin="minHeight"
          :aria-valuemax="maxHeight()"
          :aria-valuenow="noteHeight"
          class="absolute right-0 bottom-0 size-4 cursor-nwse-resize touch-none text-muted-foreground/60 outline-none"
          :class="resizing && 'text-primary'"
          @pointerdown="beginResize"
          @pointermove="moveResize"
          @pointerup="endResize"
          @pointercancel="endResize"
          @lostpointercapture="endResize"
          @keydown="keyboardResize"
        >
          <span
            aria-hidden="true"
            class="pointer-events-none absolute right-1 bottom-1 size-2.5 bg-[repeating-linear-gradient(135deg,transparent_0_2px,currentColor_2px_3px)]"
          />
        </span>
      </template>
    </InputGroup>
    <p v-if="error" class="text-xs text-destructive">{{ error }}</p>
  </div>
</template>
