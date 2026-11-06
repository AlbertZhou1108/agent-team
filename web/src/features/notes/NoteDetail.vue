<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  CalendarDays,
  Check,
  Pin,
  Plus,
  Send,
  Tags,
  Trash2,
  Users,
  X,
} from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import ConfirmDialog from '@/components/panel/ConfirmDialog.vue';
import { TEAM_COLORS } from '@/shared/team-colors';
import type { Note, NoteState, NoteTag } from '@/shared/api/raw-types';
import { TEAM_FILTER_NONE, draftFrom, isDirty, noteStateLabel, toggleTodo } from './notes-state';

const props = defineProps<{
  note: Note;
  panelReady: boolean;
  saving: boolean;
  error: string;
  conflict: boolean;
  teams: Array<{ id: string; name: string }>;
  /** 全局标签注册表:详情页展示全部标签,点击切换当前笔记是否引用。 */
  tags: NoteTag[];
}>();

const emit = defineEmits<{
  save: [draft: { revision: number; title: string; body: string; todos: Array<{ text: string; done: boolean }>; tags: string[]; due: string | null; sourceTeamId: string | null }];
  state: [state: NoteState | 'restore'];
  pin: [pinned: boolean];
  'create-tag': [payload: { name: string; color: string | null }];
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
const tagDialogOpen = ref(false);
const newTagName = ref('');
const newTagColor = ref<string | null>(null);

const archived = computed(() => props.note.state === 'archived');
const dirty = computed(() => isDirty(props.note, draft.value));
const openTodos = computed(() => draft.value.todos.filter(todo => !todo.done).length);
const canHandoff = computed(() => !archived.value && props.panelReady && !dirty.value && !props.saving);

// 来源团队是可选字段：'none' 是界面上的「无来源」，落库为 null。
const sourceValue = computed({
  get: () => draft.value.sourceTeamId ?? TEAM_FILTER_NONE,
  set: (value: string) => { draft.value.sourceTeamId = value === TEAM_FILTER_NONE ? null : value; },
});
// 团队已被删除时补一个选项，避免下拉把当前值悄悄显示成「无来源」。
const danglingTeam = computed(() => {
  const id = draft.value.sourceTeamId;
  return id && !props.teams.some(team => team.id === id) ? id : null;
});
const sourceLabel = computed(() => {
  const id = draft.value.sourceTeamId;
  if (!id) return '无来源';
  return props.teams.find(team => team.id === id)?.name ?? props.note.sourceTeamName ?? '团队已删除';
});

function payload() {
  return {
    revision: draft.value.revision,
    title: draft.value.title,
    body: draft.value.body,
    todos: draft.value.todos,
    tags: draft.value.tags,
    due: draft.value.due,
    sourceTeamId: draft.value.sourceTeamId,
  };
}

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
  emit('save', payload());
}

function toggle(index: number) {
  if (archived.value || props.saving) return;
  draft.value.todos = toggleTodo(draft.value.todos, index);
  // 勾选立即落库：它是最轻的操作，不应该还要再点一次保存。
  emit('save', payload());
}

function addTodo() {
  const text = newTodo.value.trim();
  if (!text || archived.value) return;
  draft.value.todos = [...draft.value.todos, { text, done: false }];
  newTodo.value = '';
  emit('save', payload());
}

function removeTodo(index: number) {
  if (archived.value) return;
  draft.value.todos = draft.value.todos.filter((_, current) => current !== index);
  emit('save', payload());
}

// 标签切换与待办同款:点击立即落库,不走保存按钮。
function toggleTag(tagId: string) {
  if (archived.value || props.saving) return;
  draft.value.tags = draft.value.tags.includes(tagId)
    ? draft.value.tags.filter(id => id !== tagId)
    : [...draft.value.tags, tagId];
  emit('save', payload());
}

function openTagDialog() {
  newTagName.value = '';
  newTagColor.value = null;
  tagDialogOpen.value = true;
}

function confirmCreateTag() {
  const name = newTagName.value.trim();
  if (!name) return;
  emit('create-tag', { name, color: newTagColor.value });
  tagDialogOpen.value = false;
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

    <section class="flex flex-col gap-2">
      <div class="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Users class="size-3.5" />
        来源团队
      </div>
      <!-- 来源只回答「这笔是在哪个团队里记的」，不是归属：团队删了这条记录也还在。 -->
      <Select v-if="!archived" v-model="sourceValue">
        <SelectTrigger class="h-8 w-full" aria-label="来源团队">
          <span data-slot="select-value" class="min-w-0 truncate">{{ sourceLabel }}</span>
        </SelectTrigger>
        <SelectContent>
          <SelectItem :value="TEAM_FILTER_NONE">无来源</SelectItem>
          <SelectItem v-for="team in teams" :key="team.id" :value="team.id">{{ team.name }}</SelectItem>
          <SelectItem v-if="danglingTeam" :value="danglingTeam">团队已删除</SelectItem>
        </SelectContent>
      </Select>
      <p v-else class="text-sm text-muted-foreground">{{ sourceLabel }}</p>
    </section>

    <section class="flex flex-col gap-2">
      <div class="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Tags class="size-3.5" />
        标签
      </div>
      <!-- 点击标签即引用/取消引用,立即落库(与待办同款);「+ 新增」扩展注册表。 -->
      <div class="flex flex-wrap items-center gap-1.5">
        <button
          v-for="tag in tags"
          :key="tag.id"
          type="button"
          class="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors"
          :class="draft.tags.includes(tag.id) ? 'border-primary bg-primary/10 text-foreground' : 'border-input text-muted-foreground hover:bg-accent/60'"
          :aria-pressed="draft.tags.includes(tag.id)"
          :disabled="archived"
          @click="toggleTag(tag.id)"
        >
          <span
            v-if="tag.color"
            class="size-2 shrink-0 rounded-full"
            :style="{ backgroundColor: tag.color }"
            aria-hidden="true"
          />
          {{ tag.name }}
        </button>
        <button
          v-if="!archived"
          type="button"
          class="flex items-center gap-1 rounded-full border border-dashed border-input px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent/60"
          aria-label="新增标签"
          @click="openTagDialog"
        >
          <Plus class="size-3" />
          新增
        </button>
      </div>
      <p v-if="!tags.length && archived" class="text-xs text-muted-foreground">暂无标签。</p>
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
        v-if="!archived || note.pinnedAt"
        size="sm"
        variant="outline"
        :disabled="saving || dirty"
        @click="emit('pin', !note.pinnedAt)"
      >
        <Pin />
        {{ note.pinnedAt ? '取消置顶' : '置顶' }}
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

    <Dialog v-model:open="tagDialogOpen">
      <DialogContent class="max-w-sm">
        <DialogHeader>
          <DialogTitle>新增标签</DialogTitle>
        </DialogHeader>
        <div class="flex flex-col gap-3">
          <Input
            v-model="newTagName"
            placeholder="标签名称"
            aria-label="标签名称"
            @keydown.enter.prevent="confirmCreateTag"
          />
          <div class="flex items-center gap-1.5">
            <button
              v-for="preset in TEAM_COLORS"
              :key="preset.value"
              type="button"
              class="size-5 rounded-full border-2 transition-transform"
              :class="newTagColor === preset.value ? 'scale-110' : 'scale-100'"
              :style="{ backgroundColor: preset.value, borderColor: newTagColor === preset.value ? 'var(--foreground)' : 'color-mix(in srgb, ' + preset.value + ', black 45%)' }"
              :aria-label="'颜色：' + preset.label"
              :aria-pressed="newTagColor === preset.value"
              @click="newTagColor = newTagColor === preset.value ? null : preset.value"
            />
            <span v-if="!newTagColor" class="text-xs text-muted-foreground">无色</span>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="tagDialogOpen = false">取消</Button>
          <Button :disabled="!newTagName.trim()" @click="confirmCreateTag">创建</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
