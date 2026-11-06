<script setup lang="ts">
import { QUERY_POLLING } from '@/features/queries';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter, onBeforeRouteLeave } from 'vue-router';
import { useInfiniteQuery, useQueryClient } from '@tanstack/vue-query';
import { toast } from 'vue-sonner';
import { Card, CardContent } from '@/components/ui/card';
import ConfirmDialog from '@/components/panel/ConfirmDialog.vue';
import { api, ApiError } from '@/shared/api/client';
import { useResourceQuery } from '@/features/queries';
import { queryKeys } from '@/features/query-keys';
import { usePanelAgentStore } from '@/stores/panel-agent';
import { useNoteHandoffStore } from '@/stores/note-handoff';
import type { Note, NoteState, NoteTag } from '@/shared/api/raw-types';
import NoteComposer from './NoteComposer.vue';
import NoteList from './NoteList.vue';
import NoteDetail from './NoteDetail.vue';
import NoteBatchCard from './NoteBatchCard.vue';
import { TEAM_FILTER_ALL, TEAM_FILTER_NONE, TAG_FILTER_ALL, type NoteBatchAction } from './notes-state';

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
const pendingTag = ref<string | null>(null);
let bypassLeaveGuard = false;

// 级联筛选:维度是显式 URL 状态(?dim=tag),否则「选了维度但没选值」无法表达,
// 维度下拉会点不动。值参数互斥:选团队清标签,选标签清团队。
const filterDimension = computed<'team' | 'tag'>(() => (route.query.dim === 'tag' ? 'tag' : 'team'));
// 团队筛选落 URL（?team=），这样从团队右栏的「查看全部」可以直接深链过来。
const teamFilter = computed(() => {
  if (filterDimension.value !== 'team') return TEAM_FILTER_ALL;
  const value = route.query.team;
  const raw = typeof value === 'string' ? value : '';
  // 'none' 是旧链接里的「只看无来源」,该入口已并入「全部」,这里归一避免下拉显示空值。
  if (!raw || raw === 'none') return TEAM_FILTER_ALL;
  return raw;
});
// 标签筛选落 URL（?tag=），'all' 表示维度在标签但未选具体标签。
const tagFilter = computed(() => {
  if (filterDimension.value !== 'tag') return TAG_FILTER_ALL;
  const value = route.query.tag;
  return typeof value === 'string' && value ? value : TAG_FILTER_ALL;
});
const teamsQuery = useResourceQuery(queryKeys.groups, api.groups, true, QUERY_POLLING.rare);
const teams = computed(() => (teamsQuery.data.value ?? []).map(team => ({ id: team.id, name: team.name })));
const noteTagsQuery = useResourceQuery(['note-tags'], api.noteTags, true, QUERY_POLLING.rare);
const noteTags = computed(() => noteTagsQuery.data.value ?? []);

const notesQuery = useInfiniteQuery({
  queryKey: computed(() => ['notes', filter.value, search.value, teamFilter.value, tagFilter.value] as const),
  // 服务端按 updated 倒序游标分页;前端按需追加,不做页码跳转。
  initialPageParam: null as string | null,
  queryFn: ({ pageParam, signal }) =>
    api.notes({
      state: filter.value,
      q: search.value,
      cursor: pageParam ?? undefined,
      team: teamFilter.value === TEAM_FILTER_ALL ? undefined : teamFilter.value,
      tag: tagFilter.value === TAG_FILTER_ALL ? undefined : tagFilter.value,
    }, signal),
  getNextPageParam: last => last.nextCursor,
  // 笔记列表不做后台轮询:新增/修改走本地失效,切页时按需刷新。
  refetchOnWindowFocus: false,
  retry: 1,
});
const directoryQuery = useResourceQuery(['directory'], api.directory, true, QUERY_POLLING.rare);
const panelReady = computed(() => Boolean(directoryQuery.data.value?.panelAgent));
const notes = computed(() => notesQuery.data.value?.pages.flatMap(page => page.notes) ?? []);
// 置顶笔记由服务端单独全量返回(不占游标分页),只认第一页。
const pinnedNotes = computed(() => notesQuery.data.value?.pages[0]?.pinned ?? []);
// 团队维度候选只取服务端分面结果:只列真有笔记的团队,不受已加载页数影响。
const teamFacets = computed(() => notesQuery.data.value?.pages[0]?.teamFacets ?? []);
// 值下拉的候选团队 = 分面里出现过的团队(按分面顺序),无笔记的团队不进下拉。
const filterableTeams = computed(() =>
  teamFacets.value
    .filter(facet => facet.teamId)
    .map(facet => teams.value.find(team => team.id === facet.teamId))
    .filter((team): team is { id: string; name: string } => Boolean(team)),
);
// 标签维度候选同理:只列真有笔记的标签(分面已排除标签维度本身,选中后仍能切走)。
// 行内徽章仍用全量 noteTags,保证筛选范围外的标签名也能显示。
const filterableTags = computed(() =>
  (notesQuery.data.value?.pages[0]?.tagFacets ?? [])
    .map(facet => noteTags.value.find(tag => tag.id === facet.tagId))
    .filter((tag): tag is NoteTag => Boolean(tag)),
);
// 计数随当前筛选（状态、团队、标签、搜索）变化，只认第一页。
const counts = computed(() => notesQuery.data.value?.pages[0]?.counts ?? { active: 0, done: 0, archived: 0 });const hasMore = computed(() => Boolean(notesQuery.hasNextPage.value));
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
  return notes.value.find(note => note.id === selectedId.value)
    ?? pinnedNotes.value.find(note => note.id === selectedId.value)
    ?? null;
});
const listError = computed(() => (notesQuery.error.value as Error | null)?.message ?? '');

async function refresh() {
  await Promise.all([
    client.invalidateQueries({ predicate: query => String(query.queryKey[0]) === 'notes' }),
    client.invalidateQueries({ predicate: query => String(query.queryKey[0]) === 'note' }),
  ]);
}

function openNote(id: string) {
  // 打开详情即收起批量投放卡片:点击笔记是明确的「切换到详情」信号,
  // 无论拖拽状态如何残留,这里都要强制切换。
  batchCardVisible.value = false;
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
  batchCardVisible.value = false;
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
  batchCardVisible.value = false;
  if (detailDirty.value) {
    pendingTeam.value = next;
    pendingLeave.value = '__team__';
    return;
  }
  applyTeam(next);
}

/**
 * 筛选状态的唯一写入口。维度/值/团队/标签都是互斥字段，整组重写而不是
 * 「复制旧 query 再改一个键」——那样每加一个字段就要在多处维护排除名单，
 * 已经因此出过两次 bug（维度切不动、标签回不到全部）。
 */
function applyFilters(next: { dimension: 'team' | 'tag'; team?: string; tag?: string }) {
  const query: Record<string, string> = {};
  for (const [key, value] of Object.entries(route.query)) {
    if (key === 'note' || key === 'team' || key === 'tag' || key === 'dim') continue;
    if (typeof value === 'string') query[key] = value;
  }
  if (next.dimension === 'tag') {
    query.dim = 'tag';
    if (next.tag && next.tag !== TAG_FILTER_ALL) query.tag = next.tag;
  } else if (next.team && next.team !== TEAM_FILTER_ALL) {
    query.team = next.team;
  }
  void router.replace({ query });
  if (!selectedId.value) return;
  void nextTick(() => {
    document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true });
  });
}

function applyTeam(next: string) {
  applyFilters({ dimension: 'team', team: next });
}

// 标签筛选与团队筛选互斥:选中一个维度就清掉另一个,级联下拉的值落 URL(?tag=)。
function changeTag(next: string) {
  if (next === tagFilter.value && filterDimension.value === 'tag') return;
  batchCardVisible.value = false;
  if (detailDirty.value) {
    pendingTag.value = next;
    pendingLeave.value = '__tag__';
    return;
  }
  applyTag(next);
}

function applyTag(next: string) {
  applyFilters({ dimension: 'tag', tag: next });
}

// 维度切换:只换维度并清掉两侧的值,值选择器随维度更换。
function changeDimension(next: 'team' | 'tag') {
  if (next === filterDimension.value) return;
  batchCardVisible.value = false;
  applyFilters({ dimension: next });
}

function onSearch(value: string) {
  search.value = value;
  // 搜索会清空选区(列表内部处理),批量卡片随之收起。
  batchCardVisible.value = false;
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
  } else if (target === '__tag__') {
    const next = pendingTag.value;
    pendingTag.value = null;
    if (next) applyTag(next);
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

async function save(draft: { revision: number; title: string; body: string; todos: Array<{ text: string; done: boolean }>; tags: string[]; due: string | null; sourceTeamId: string | null }) {
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

/* ------------------------------ 批量操作 ------------------------------ */
/* 多选拖到工具栏投放区后走到这里。批量不加新端点:逐条走既有单条 API,
   每条带自己的 revision,部分失败(乐观锁冲突)逐条汇报,不静默吞。 */

const pendingBatchRemove = ref<string[] | null>(null);
const BATCH_DONE_LABEL: Record<NoteBatchAction, string> = {
  handoff: '已汇总',
  done: '已完成',
  archived: '已归档',
  active: '已恢复为正常',
  restore: '已恢复',
  remove: '已删除',
};

function reportBatch(action: NoteBatchAction, results: Array<PromiseSettledResult<unknown>>) {
  const failed = results.filter(result => result.status === 'rejected');
  const ok = results.length - failed.length;
  if (!failed.length) {
    toast.success(`${BATCH_DONE_LABEL[action]} ${ok} 条`);
    return;
  }
  toast.warning(`${BATCH_DONE_LABEL[action]} ${ok} 条，${failed.length} 条失败`, {
    description: '失败的多为记录已被更新；刷新列表后可对剩余的再操作一次。',
  });
}

async function onBatch(payload: { action: NoteBatchAction; ids: string[] }) {
  const { action, ids } = payload;
  if (!ids.length) return;
  if (action === 'handoff') return batchHandoff(ids);
  if (action === 'remove') {
    pendingBatchRemove.value = ids;
    return;
  }
  const results = await Promise.allSettled(
    ids.map(id => {
      const note = notes.value.find(item => item.id === id);
      if (!note) return Promise.reject(new Error('记录不在当前列表'));
      return api.setNoteState(id, { state: action, revision: note.revision });
    }),
  );
  await refresh();
  reportBatch(action, results);
  if (selectedId.value && !notes.value.some(item => item.id === selectedId.value)) applyClose();
}

/* 拖起 → 收起详情、展开批量投放卡片(与详情同槽位);
   有未保存修改时不出卡片——拖拽中丢草稿比没有卡片更糟,侧栏投放仍可用。
   拖拽结束 → 卡片收起,详情不自动重开。 */
const batchCardVisible = ref(false);

function onNoteDragStarted() {
  if (detailDirty.value) return;
  if (selectedId.value) applyClose();
  batchCardVisible.value = true;
}

function onNoteDragEnded() {
  batchCardVisible.value = false;
}

// 置顶:展示层动作,不动状态机。幂等由服务端保证(重复置顶不 bump revision)。
async function pinNote(pinned: boolean) {
  const note = selectedNote.value;
  if (!note) return;
  try {
    await api.setNotePin(note.id, { pinned, revision: note.revision });
    await refresh();
  } catch (cause) {
    detailError.value = cause instanceof Error ? cause.message : String(cause);
  }
}

// 新增标签:先进注册表(同名幂等),再自动引用到当前打开的笔记(与点标签同款落库)。
async function onCreateTag(payload: { name: string; color: string | null }) {
  try {
    const { tag } = await api.createNoteTag(payload);
    await client.invalidateQueries({ queryKey: ['note-tags'] });
    const note = selectedNote.value;
    if (!note || note.state === 'archived' || note.tags.includes(tag.id)) return;
    await api.updateNote(note.id, { revision: note.revision, tags: [...note.tags, tag.id] });
    await refresh();
  } catch (cause) {
    toast.error('新增标签失败', { description: cause instanceof Error ? cause.message : String(cause) });
  }
}

async function confirmBatchRemove() {
  const ids = pendingBatchRemove.value;
  pendingBatchRemove.value = null;
  if (!ids?.length) return;
  const results = await Promise.allSettled(ids.map(id => api.deleteNote(id)));
  await refresh();
  reportBatch('remove', results);
  if (selectedId.value && ids.includes(selectedId.value)) applyClose();
}

async function batchHandoff(ids: string[]) {
  try {
    const { text } = await api.notesPrompt(ids);
    // 已有未发送草稿时不静默覆盖：先让用户决定（与单条「交给 Panel Agent」同一道闸）。
    if (panelState.draft.trim()) {
      pendingPrompt.value = text;
      return;
    }
    applyPrompt(text);
  } catch (cause) {
    toast.error('生成汇总提示词失败', {
      description: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

// 侧栏 Panel Agent 投放桥:拖拽源只有本列表,这里必然挂载着,消费即处理。
const noteHandoff = useNoteHandoffStore();
watch(
  () => noteHandoff.pending,
  (ids) => {
    if (!ids?.length) return;
    const consumed = noteHandoff.consume();
    if (consumed?.length) void batchHandoff(consumed);
  },
);

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

      <div class="notes-page-body" :class="selectedNote || batchCardVisible ? 'has-detail' : ''">
        <div class="notes-page-column">
          <NoteList
            :notes="notes"
            :pinned="pinnedNotes"
            :tags="noteTags"
            :filter-tags="filterableTags"
            :filter="filter"
            :counts="counts"
            :search="search"
            :selected-id="selectedId"
            :loading="notesQuery.isPending.value"
            :error="listError"
            :has-more="hasMore"
            :loading-more="loadingMore"
            :team="teamFilter"
            :teams="filterableTeams"
            :tag="tagFilter"
            :dimension="filterDimension"
            @update:filter="changeFilter"
            @update:team="changeTeam"
            @update:tag="changeTag"
            @update:dimension="changeDimension"
            @update:search="onSearch"
            @select="openNote"
            @load-more="loadMore"
            @drag-start="onNoteDragStarted"
            @drag-end="onNoteDragEnded"
          />
        </div>

        <!-- 详情槽位:详情卡与批量投放卡共用,拖拽期间卡片顶替详情。 -->
        <!-- 详情是独立一张内容卡片,不做「一条竖线切两半」。槽位常驻、宽 0,
             列宽与卡片的进出才有一段可打断的过渡。拖拽批量卡片与详情共用槽位。 -->
        <div class="notes-detail-slot">
          <Transition name="pane-reveal">
            <NoteBatchCard
              v-if="batchCardVisible"
              :filter="filter"
              @batch="onBatch"
            />
            <Card v-else-if="selectedNote" size="compact" class="notes-page-column notes-detail-pane min-w-0">
              <CardContent class="min-h-0">
                <NoteDetail
                  :key="selectedNote.id"
                  class="content-appear"
                  :note="selectedNote"
                  :panel-ready="panelReady"
                  :teams="teams"
                  :tags="noteTags"
                  :saving="saving"
                  :error="detailError"
                  :conflict="conflict"
                  @save="save"
                  @state="changeState"
                  @pin="pinNote"
                  @create-tag="onCreateTag"
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
      description="输入框里已经有内容，继续会替换成新的汇总内容。"
      confirm-text="替换并跳转"
      @cancel="pendingPrompt = null"
      @confirm="pendingPrompt && applyPrompt(pendingPrompt)"
    />

    <ConfirmDialog
      :open="pendingBatchRemove !== null"
      title="永久删除所选记录？"
      :description="`将永久删除 ${pendingBatchRemove?.length ?? 0} 条已归档记录，删除后不可恢复。`"
      confirm-text="全部删除"
      destructive
      @cancel="pendingBatchRemove = null"
      @confirm="confirmBatchRemove"
    />
  </div>
</template>
