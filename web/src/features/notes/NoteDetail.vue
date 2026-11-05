<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  CalendarDays,
  Check,
  Plus,
  Send,
  Trash2,
  X,
} from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import ConfirmDialog from '@/components/panel/ConfirmDialog.vue';
import type { Note, NoteState } from '@/shared/api/raw-types';
import { draftFrom, isDirty, noteStateLabel, toggleTodo } from './notes-state';

const props = defineProps<{
  note: Note;
  panelReady: boolean;
  saving: boolean;
  error: string;
  conflict: boolean;
}>();

const emit = defineEmits<{
  save: [draft: { revision: number; title: string; body: string; todos: Array<{ text: string; done: boolean }>; due: string | null }];
  state: [state: NoteState | 'restore'];
  remove: [];
  handoff: [instruction: string];
  reload: [];
  close: [];
  dirty: [value: boolean];
}>();

const draft = ref(draftFrom(props.note));
const newTodo = ref('');
const instruction = ref('');
const showHandoff = ref(false);
const confirmDelete = ref(false);

const archived = computed(() => props.note.state === 'archived');
const dirty = computed(() => isDirty(props.note, draft.value));
const openTodos = computed(() => draft.value.todos.filter(todo => !todo.done).length);
const canHandoff = computed(() => !archived.value && props.panelReady && !dirty.value && !props.saving);

function reset() {
  draft.value = draftFrom(props.note);
  newTodo.value = '';
}

// 只在没有本地改动时跟随服务端；避免重取详情时把正在编辑的内容冲掉。
watch(() => props.note.id, reset, { immediate: true });
// 保存成功后服务端会重排空白、把空截止归一为 null；此时必须整体对齐，
// 否则草稿会带着旧 revision 继续「看起来未保存」，下一次保存直接 409。
watch(() => props.note.revision, () => { draft.value = draftFrom(props.note); });
// 父组件在切换/收起详情前要知道有没有未保存内容，否则会静默丢弃。
watch(dirty, value => emit('dirty', value), { immediate: true });

async function save() {
  if (!dirty.value || props.saving) return;
  emit('save', {
    revision: draft.value.revision,
    title: draft.value.title,
    body: draft.value.body,
    todos: draft.value.todos,
    due: draft.value.due,
  });
}

function toggle(index: number) {
  if (archived.value || props.saving) return;
  draft.value.todos = toggleTodo(draft.value.todos, index);
  // 勾选立即落库：它是最轻的操作，不应该还要再点一次保存。
  emit('save', {
    revision: draft.value.revision,
    title: draft.value.title,
    body: draft.value.body,
    todos: draft.value.todos,
    due: draft.value.due,
  });
}

function addTodo() {
  const text = newTodo.value.trim();
  if (!text || archived.value) return;
  draft.value.todos = [...draft.value.todos, { text, done: false }];
  newTodo.value = '';
  emit('save', {
    revision: draft.value.revision,
    title: draft.value.title,
    body: draft.value.body,
    todos: draft.value.todos,
    due: draft.value.due,
  });
}

function removeTodo(index: number) {
  if (archived.value) return;
  draft.value.todos = draft.value.todos.filter((_, current) => current !== index);
  emit('save', {
    revision: draft.value.revision,
    title: draft.value.title,
    body: draft.value.body,
    todos: draft.value.todos,
    due: draft.value.due,
  });
}

function handoff() {
  if (!canHandoff.value) return;
  emit('handoff', instruction.value.trim());
}
</script>

<template>
  <div class="flex min-h-0 flex-col gap-4">
    <header class="flex items-start justify-between gap-2">
      <div class="flex min-w-0 flex-col gap-1">
        <Badge variant="outline">{{ noteStateLabel(note.state) }}</Badge>
        <span class="text-xs text-muted-foreground tabular-nums">
          r{{ note.revision }} · {{ archived ? '归档后不可修改' : dirty ? '有未保存修改' : '已保存' }}
        </span>
      </div>
      <Button variant="ghost" size="icon-sm" aria-label="收起详情" title="收起详情" @click="emit('close')">
        <X />
      </Button>
    </header>

    <div class="flex flex-col gap-2">
      <Input
        v-model="draft.title"
        :disabled="archived"
        aria-label="标题"
        placeholder="标题会取正文第一行"
      />
      <Textarea
        v-model="draft.body"
        :disabled="archived"
        rows="8"
        aria-label="正文"
        class="min-h-32 resize-y"
      />
    </div>

    <section class="flex flex-col gap-2">
      <div class="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        待办
        <span v-if="draft.todos.length" class="tabular-nums">
          {{ draft.todos.length - openTodos }}/{{ draft.todos.length }}
        </span>
      </div>
      <ul v-if="draft.todos.length" class="flex flex-col gap-1">
        <li v-for="(todo, index) in draft.todos" :key="`${todo.text}-${index}`" class="group flex items-center gap-2">
          <button
            type="button"
            class="flex size-5 shrink-0 items-center justify-center rounded border transition-colors"
            :class="todo.done ? 'border-primary bg-primary text-primary-foreground' : 'border-input'"
            :aria-pressed="todo.done"
            :aria-label="todo.done ? '标记为未完成' : '标记为完成'"
            :disabled="archived"
            @click="toggle(index)"
          >
            <Check v-if="todo.done" class="size-3.5" />
          </button>
          <span class="min-w-0 flex-1 truncate text-sm" :class="todo.done && 'text-muted-foreground line-through'">
            {{ todo.text }}
          </span>
          <Button
            v-if="!archived"
            variant="ghost"
            size="icon-sm"
            aria-label="删除待办"
            title="删除待办"
            class="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            @click="removeTodo(index)"
          >
            <X />
          </Button>
        </li>
      </ul>
      <div v-if="!archived" class="flex items-center gap-2">
        <Input
          v-model="newTodo"
          class="h-8"
          placeholder="添加待办"
          aria-label="添加待办"
          @keydown.enter.prevent="addTodo"
        />
        <Button variant="outline" size="icon-sm" aria-label="添加待办" :disabled="!newTodo.trim()" @click="addTodo">
          <Plus />
        </Button>
      </div>
    </section>

    <section class="flex flex-col gap-2">
      <div class="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <CalendarDays class="size-3.5" />
        截止日期
      </div>
      <div class="flex items-center gap-2">
        <Input
          :model-value="draft.due ?? ''"
          type="date"
          :disabled="archived"
          aria-label="截止日期"
          class="h-8 w-40"
          @update:model-value="value => { draft.due = String(value ?? '') || null; }"
        />
        <Button v-if="draft.due && !archived" variant="ghost" size="sm" @click="draft.due = null">清除</Button>
      </div>
    </section>

    <p v-if="error" class="flex flex-col gap-1 text-xs text-destructive">
      {{ error }}
      <Button v-if="conflict" variant="link" size="sm" class="h-auto self-start p-0" @click="emit('reload')">
        重新载入最新内容
      </Button>
    </p>

    <div class="flex flex-wrap items-center gap-2">
      <Button v-if="!archived" size="sm" :disabled="!dirty || saving" @click="save">
        {{ saving ? '保存中…' : '保存' }}
      </Button>
      <Button
        v-if="note.state === 'active'"
        size="sm"
        variant="outline"
        :disabled="saving || dirty"
        @click="emit('state', 'done')"
      >
        完成
      </Button>
      <Button
        v-if="note.state === 'done'"
        size="sm"
        variant="outline"
        :disabled="saving || dirty"
        @click="emit('state', 'active')"
      >
        取消完成
      </Button>
      <Button
        v-if="!archived"
        size="sm"
        variant="ghost"
        :disabled="saving || dirty"
        @click="emit('state', 'archived')"
      >
        归档
      </Button>
      <Button v-if="archived" size="sm" variant="outline" :disabled="saving" @click="emit('state', 'restore')">
        恢复
      </Button>
      <Button v-if="archived" size="sm" variant="ghost" class="text-destructive" :disabled="saving" @click="confirmDelete = true">
        <Trash2 />
        删除
      </Button>
    </div>


    <section class="flex flex-col gap-2">
      <Button
        v-if="!showHandoff"
        size="sm"
        variant="secondary"
        class="self-start"
        :disabled="!canHandoff"
        :title="archived ? '归档的记录不能交给助手' : !panelReady ? '请先创建 Panel Agent' : dirty ? '先保存当前修改' : undefined"
        @click="showHandoff = true"
      >
        <Send />
        交给 Panel Agent
      </Button>
      <template v-else>
        <Input
          v-model="instruction"
          class="h-8"
          placeholder="补充一句要求（可留空）"
          aria-label="补充要求"
          @keydown.enter.prevent="handoff"
        />
        <div class="flex items-center gap-2">
          <Button size="sm" :disabled="!canHandoff" @click="handoff">
            <Send />
            带着这条记录去问它
          </Button>
          <Button size="sm" variant="ghost" @click="showHandoff = false">取消</Button>
        </div>
        <p class="text-xs text-muted-foreground">
          会跳到 Panel Agent 并把这条记录填进输入框；由你按发送。它会先判断这条想法是否已经能直接做。
        </p>
      </template>
    </section>

    <ConfirmDialog
      :open="confirmDelete"
      title="永久删除这条记录"
      description="删除后无法恢复。只有已归档的记录可以删除。"
      confirm-text="永久删除"
      destructive
      :busy="saving"
      @cancel="confirmDelete = false"
      @confirm="confirmDelete = false; emit('remove')"
    />
  </div>
</template>
