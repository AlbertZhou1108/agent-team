<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter, onBeforeRouteLeave } from 'vue-router';
import { useInfiniteQuery, useQueryClient } from '@tanstack/vue-query';
import { toast } from 'vue-sonner';
import { Card, CardContent } from '@/components/ui/card';
import ConfirmDialog from '@/components/panel/ConfirmDialog.vue';
import { api, ApiError } from '@/shared/api/client';
import { useResourceQuery } from '@/features/queries';
import { queryKeys } from '@/features/query-keys';
import { usePanelAgentStore } from '@/stores/panel-agent';
import type { Note, NoteState } from '@/shared/api/raw-types';
import NoteComposer from './NoteComposer.vue';
import NoteList from './NoteList.vue';
import NoteDetail from './NoteDetail.vue';
import { TEAM_FILTER_ALL, TEAM_FILTER_NONE } from './notes-state';

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
const pendingFilter = ref<NoteState | null>(null);
const pendingTeam = ref<string | null>(null);
let bypassLeaveGuard = false;

// 团队筛选落 URL（?team=），这样从团队右栏的「查看全部」可以直接深链过来。
const teamFilter = computed(() => {
  const value = route.query.team;
  return typeof value === 'string' && value ? value : TEAM_FILTER_ALL;
});
const teamsQuery = useResourceQuery(queryKeys.groups, api.groups, true, 30000);
const teams = computed(() => (teamsQuery.data.value ?? []).map(team => ({ id: team.id, name: team.name })));

const notesQuery = useInfiniteQuery({
  queryKey: computed(() => ['notes', filter.value, search.value, teamFilter.value] as const),
  // 服务端按 updated 倒序游标分页;前端按需追加,不做页码跳转。
  initialPageParam: null as string | null,
  queryFn: ({ pageParam, signal }) =>
    api.notes({
      state: filter.value,
      q: search.value,
      cursor: pageParam ?? undefined,
      team: teamFilter.value === TEAM_FILTER_ALL ? undefined : teamFilter.value,
    }, signal),
  getNextPageParam: last => last.nextCursor,
  refetchInterval: 10000,
  refetchOnWindowFocus: false,
  retry: 1,
});
const directoryQuery = useResourceQuery(['directory'], api.directory, true, 30000);
const panelReady = computed(() => Boolean(directoryQuery.data.value?.panelAgent));
const notes = computed(() => notesQuery.data.value?.pages.flatMap(page => page.notes) ?? []);
// 计数随当前筛选（状态、团队、搜索）变化，只认第一页。
const counts = computed(() => notesQuery.data.value?.pages[0]?.counts ?? { active: 0, done: 0, archived: 0 });
const hasMore = computed(() => Boolean(notesQuery.hasNextPage.value));
const loadingMore = computed(() => notesQuery.isFetchingNextPage.value);

function loadMore() {
  if (!hasMore.value || loadingMore.value) return;
  void notesQuery.fetchNextPage();
}
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
  const closingId = selectedId.value;
  // 卡片里被点掉的按钮会随卡片一起消失:焦点必须有人接手,否则落回 body。
  // 从卡片外收起的(比如切页签点的是页签本身)不动焦点。
  const active = document.activeElement;
  const focusWasInPane = !active
    || active === document.body
    || (active instanceof Element && Boolean(active.closest('.notes-detail-pane')));
  const query = { ...route.query };
  delete query.note;
  void router.replace({ query });
  if (!closingId || !focusWasInPane) return;
  void nextTick(() => {
    // 记录还在列表里就回到它那一行;已经离开当前页签(归档/完成)就回到当前页签。
    const row = document.querySelector<HTMLElement>(`.note-row[data-note-id="${CSS.escape(closingId)}"]`);
    const fallback = document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    (row ?? fallback)?.focus({ preventScroll: true });
  });
}

// 详情卡只展示「当前页签里还在」的那一条：切页签先收起,
// 有未保存内容时仍旧先问,不静默丢弃。
function changeFilter(next: NoteState) {
  if (next === filter.value) return;
  if (detailDirty.value) {
    pendingFilter.value = next;
    pendingLeave.value = '__filter__';
    return;
  }
  filter.value = next;
  if (selectedId.value) applyClose();
}

// 切换团队筛选同样会收起详情：团队 + 记录一次导航写清，
// 否则「切团队」和「收详情」两次 replace 会互相覆盖。
function changeTeam(next: string) {
  if (next === teamFilter.value) return;
  if (detailDirty.value) {
    pendingTeam.value = next;
    pendingLeave.value = '__team__';
    return;
  }
  applyTeam(next);
}

function applyTeam(next: string) {
  const query: Record<string, string> = {};
  for (const [key, value] of Object.entries(route.query)) {
    if (key !== 'note' && typeof value === 'string') query[key] = value;
  }
  if (next === TEAM_FILTER_ALL) delete query.team;
  else query.team = next;
  void router.replace({ query });
  if (!selectedId.value) return;
  void nextTick(() => {
    document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true });
  });
}

function confirmLeave() {
  const target = pendingLeave.value;
  pendingLeave.value = null;
  detailDirty.value = false;
  if (target === '__close__') applyClose();
  else if (target === '__filter__') {
    const next = pendingFilter.value;
    pendingFilter.value = null;
    if (next) filter.value = next;
    if (selectedId.value) applyClose();
  } else if (target === '__team__') {
    const next = pendingTeam.value;
    pendingTeam.value = null;
    if (next) applyTeam(next);
  } else if (target === '__route__') {
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
  // 正在看某个团队的记录时，新记的那笔默认也标上这个来源；看「全部」或「无来源」则不标。
  const source = teamFilter.value === TEAM_FILTER_ALL || teamFilter.value === TEAM_FILTER_NONE
    ? undefined
    : teamFilter.value;
  const note = await api.createNote({ id: crypto.randomUUID(), body, ...(source ? { sourceTeamId: source } : {}) });
  filter.value = 'active';
  await refresh();
  openNote(note.id);
  toast.success('已记下来');
}

async function save(draft: { revision: number; title: string; body: string; todos: Array<{ text: string; done: boolean }>; due: string | null; sourceTeamId: string | null }) {
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
    // 归档 / 完成 / 恢复都会让这条记录离开当前页签(恢复回到归档前的状态,
    // 由服务端决定落哪个页签)。列表里已经没有了,卡片就不再挂着。
    if (selectedId.value === note.id && !notes.value.some(item => item.id === note.id)) applyClose();
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
  <!-- 页面本身不是卡片:页面里的内容卡片才是唯一一层边框。 -->
  <div class="notes-page min-w-0">
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
            :has-more="hasMore"
            :loading-more="loadingMore"
            :team="teamFilter"
            :teams="teams"
            @update:filter="changeFilter"
            @update:team="changeTeam"
            @update:search="value => { search = value; }"
            @select="openNote"
            @load-more="loadMore"
          />
        </div>

        <!-- 详情是独立一张内容卡片,不做「一条竖线切两半」。槽位常驻、宽 0,
             列宽与卡片的进出才有一段可打断的过渡。 -->
        <div class="notes-detail-slot">
          <Transition name="pane-reveal">
            <Card v-if="selectedNote" size="compact" class="notes-page-column notes-detail-pane min-w-0">
              <CardContent class="min-h-0">
                <NoteDetail
                  :key="selectedNote.id"
                  class="content-appear"
                  :note="selectedNote"
                  :panel-ready="panelReady"
                  :teams="teams"
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
              </CardContent>
            </Card>
          </Transition>
        </div>
      </div>
    </div>

    <ConfirmDialog
      :open="pendingLeave !== null"
      title="还有未保存的修改"
      description="切换后这些修改会丢失。可以先取消，回到记录里保存。"
      confirm-text="放弃修改"
      destructive
      @cancel="pendingLeave = null; pendingRoute = null; pendingFilter = null; pendingTeam = null"
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
  </div>
</template>
