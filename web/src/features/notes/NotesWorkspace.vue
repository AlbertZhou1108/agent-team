<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter, onBeforeRouteLeave } from 'vue-router';
import { useQueryClient } from '@tanstack/vue-query';
import { toast } from 'vue-sonner';
import { Surface } from '@/components/surface';
import { Card } from '@/components/ui/card';
import ConfirmDialog from '@/components/panel/ConfirmDialog.vue';
import { api, ApiError } from '@/shared/api/client';
import { useResourceQuery } from '@/features/queries';
import { usePanelAgentStore } from '@/stores/panel-agent';
import type { Note, NoteState } from '@/shared/api/raw-types';
import NoteComposer from './NoteComposer.vue';
import NoteList from './NoteList.vue';
import NoteDetail from './NoteDetail.vue';

// 随心记只做「记」：这里没有交接、没有回合、没有任务状态。
// 「交给 Panel Agent」只是生成一段提示词并跳转，执行与结果都在私人会话里。
const route = useRoute();
const router = useRouter();
const client = useQueryClient();
const panelState = usePanelAgentStore();

const filter = ref<NoteState>('active');
const search = ref('');
const saving = ref(false);
const detailError = ref('');
const conflict = ref(false);
const pendingPrompt = ref<string | null>(null);
const composer = ref<InstanceType<typeof NoteComposer> | null>(null);
// 详情里的未保存内容不会被自动保存：切换或收起前必须先问用户。
const detailDirty = ref(false);
const pendingLeave = ref<string | null>(null);
const pendingRoute = ref<string | null>(null);
let bypassLeaveGuard = false;

const notesQuery = useResourceQuery(
  () => ['notes', filter.value, search.value],
  signal => api.notes({ state: filter.value, q: search.value }, signal),
  true,
  10000,
);
const directoryQuery = useResourceQuery(['directory'], api.directory, true, 30000);
const panelReady = computed(() => Boolean(directoryQuery.data.value?.panelAgent));
const notes = computed(() => notesQuery.data.value?.notes ?? []);
const counts = computed(() => notesQuery.data.value?.counts ?? { active: 0, done: 0, archived: 0 });
const selectedId = computed(() => (typeof route.query.note === 'string' ? route.query.note : null));
const detailQuery = useResourceQuery(
  () => ['note', selectedId.value],
  signal => api.note(selectedId.value!, signal),
  () => Boolean(selectedId.value),
  false,
);
const selectedNote = computed<Note | null>(() => {
  if (!selectedId.value) return null;
  if (detailQuery.data.value?.id === selectedId.value) return detailQuery.data.value;
  return notes.value.find(note => note.id === selectedId.value) ?? null;
});
const listError = computed(() => (notesQuery.error.value as Error | null)?.message ?? '');

async function refresh() {
  await Promise.all([
    client.invalidateQueries({ predicate: query => String(query.queryKey[0]) === 'notes' }),
    client.invalidateQueries({ predicate: query => String(query.queryKey[0]) === 'note' }),
  ]);
}

function openNote(id: string) {
  if (detailDirty.value && id !== selectedId.value) {
    pendingLeave.value = id;
    return;
  }
  applyOpen(id);
}

function applyOpen(id: string) {
  void router.replace({ query: { ...route.query, note: id } });
  // 窄屏把详情排在列表之前，选中后直接带过去，省掉一次手动滚动。
  if (window.innerWidth < 1024) {
    void nextTick(() => document.querySelector('.notes-detail-pane')?.scrollIntoView({ block: 'start' }));
  }
}

function closeNote() {
  if (detailDirty.value) {
    pendingLeave.value = '__close__';
    return;
  }
  applyClose();
}

function applyClose() {
  const query = { ...route.query };
  delete query.note;
  void router.replace({ query });
}

function confirmLeave() {
  const target = pendingLeave.value;
  pendingLeave.value = null;
  detailDirty.value = false;
  if (target === '__close__') applyClose();
  else if (target === '__route__') {
    const path = pendingRoute.value;
    pendingRoute.value = null;
    if (path) {
      // 放过这一次离开：否则同一条未保存判断会再次拦截。
      bypassLeaveGuard = true;
      void router.push(path).finally(() => { bypassLeaveGuard = false; });
    }
  } else if (target) applyOpen(target);
}

// 直接跳到别的页面同样会丢掉草稿，和切换记录是一类问题。
onBeforeRouteLeave(to => {
  if (bypassLeaveGuard || !detailDirty.value) return true;
  pendingRoute.value = to.fullPath;
  pendingLeave.value = '__route__';
  return false;
});

async function create(body: string) {
  const note = await api.createNote({ id: crypto.randomUUID(), body });
  filter.value = 'active';
  await refresh();
  openNote(note.id);
  toast.success('已记下来');
}

async function save(draft: { revision: number; title: string; body: string; todos: Array<{ text: string; done: boolean }>; due: string | null }) {
  const note = selectedNote.value;
  if (!note) return;
  saving.value = true;
  detailError.value = '';
  conflict.value = false;
  try {
    await api.updateNote(note.id, draft);
    await refresh();
  } catch (cause) {
    detailError.value = cause instanceof Error ? cause.message : String(cause);
    conflict.value = cause instanceof ApiError && cause.status === 409;
  } finally {
    saving.value = false;
  }
}

async function changeState(state: NoteState | 'restore') {
  const note = selectedNote.value;
  if (!note) return;
  saving.value = true;
  detailError.value = '';
  conflict.value = false;
  try {
    await api.setNoteState(note.id, { state, revision: note.revision });
    await refresh();
  } catch (cause) {
    detailError.value = cause instanceof Error ? cause.message : String(cause);
    conflict.value = cause instanceof ApiError && cause.status === 409;
  } finally {
    saving.value = false;
  }
}

async function remove() {
  const note = selectedNote.value;
  if (!note) return;
  saving.value = true;
  try {
    await api.deleteNote(note.id);
    closeNote();
    await refresh();
    toast.success('已删除');
  } catch (cause) {
    detailError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    saving.value = false;
  }
}

async function handoff(instruction: string) {
  const note = selectedNote.value;
  if (!note) return;
  try {
    const { text } = await api.notePrompt(note.id, instruction);
    // 已有未发送草稿时不静默覆盖：先让用户决定。
    if (panelState.draft.trim()) {
      pendingPrompt.value = text;
      return;
    }
    applyPrompt(text);
  } catch (cause) {
    detailError.value = cause instanceof Error ? cause.message : String(cause);
  }
}

function applyPrompt(text: string) {
  pendingPrompt.value = null;
  panelState.setDraft(text);
  void router.push({ name: 'panel-agent' });
}

function reloadDetail() {
  void detailQuery.refetch();
}

function onKeydown(event: KeyboardEvent) {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target as HTMLElement | null;
  const tag = target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;
  if (event.key !== 'n' || route.name !== 'notes') return;
  event.preventDefault();
  composer.value?.focusInput();
}

onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <Surface role="context-panel" :as="Card" class="notes-page min-w-0">
    <div class="notes-page-inner">
      <header class="flex flex-wrap items-end justify-between gap-2">
        <div class="flex flex-col gap-1">
          <h1 class="text-2xl font-semibold tracking-tight">随心记</h1>
          <p class="text-sm text-muted-foreground">
            正常 {{ counts.active }} · 已完成 {{ counts.done }} · 已归档 {{ counts.archived }}
          </p>
        </div>
      </header>

      <NoteComposer ref="composer" :submit="create" />

      <div class="notes-page-body" :class="selectedNote ? 'has-detail' : ''">
        <div class="notes-page-column">
          <NoteList
            :notes="notes"
            :filter="filter"
            :counts="counts"
            :search="search"
            :selected-id="selectedId"
            :loading="notesQuery.isPending.value"
            :error="listError"
            @update:filter="value => { filter = value; }"
            @update:search="value => { search = value; }"
            @select="openNote"
          />
        </div>

        <aside v-if="selectedNote" class="notes-page-column notes-detail-pane min-w-0">
          <NoteDetail
            :key="selectedNote.id"
            :note="selectedNote"
            :panel-ready="panelReady"
            :saving="saving"
            :error="detailError"
            :conflict="conflict"
            @save="save"
            @state="changeState"
            @remove="remove"
              @handoff="handoff"
              @reload="reloadDetail"
              @close="closeNote"
              @dirty="detailDirty = $event"
          />
        </aside>
      </div>
    </div>

    <ConfirmDialog
      :open="pendingLeave !== null"
      title="还有未保存的修改"
      description="切换后这些修改会丢失。可以先取消，回到记录里保存。"
      confirm-text="放弃修改"
      destructive
      @cancel="pendingLeave = null; pendingRoute = null"
      @confirm="confirmLeave"
    />

    <ConfirmDialog
      :open="pendingPrompt !== null"
      title="替换 Panel Agent 里未发送的草稿"
      description="输入框里已经有内容。继续会用它替换成这条记录。"
      confirm-text="替换并跳转"
      @cancel="pendingPrompt = null"
      @confirm="pendingPrompt && applyPrompt(pendingPrompt)"
    />
  </Surface>
</template>
