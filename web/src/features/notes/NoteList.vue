<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { Search as SearchIcon, NotebookPen } from '@lucide/vue';
import { draggable, dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Disclosure } from '@/components/ui/disclosure';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import type { Note, NoteCounts, NoteState } from '@/shared/api/raw-types';
import { useSentinelLoad } from '@/shared/use-sentinel-load';
import { NOTE_DRAG_TYPE, useNoteHandoffStore } from '@/stores/note-handoff';
import { motionDurationMs, MOTION_EASING, prefersReducedMotion } from '@/shared/motion';
import { cn } from '@/lib/utils';
import {
  NOTE_STATES,
  TEAM_FILTER_ALL,
  TEAM_FILTER_NONE,
  formatNoteTime,
  groupNotesByDay,
  noteExcerpt,
  noteSourceLabel,
  noteStateLabel,
  selectRange,
  toggleSelection,
} from './notes-state';

const props = defineProps<{
  notes: Note[];
  filter: NoteState;
  counts: NoteCounts;
  search: string;
  selectedId: string | null;
  loading: boolean;
  error: string;
  hasMore: boolean;
  loadingMore: boolean;
  /** 团队筛选：TEAM_FILTER_ALL（不筛选）/ TEAM_FILTER_NONE（无来源）/ 团队 id。 */
  team: string;
  teams: Array<{ id: string; name: string }>;
}>();

const emit = defineEmits<{
  'update:filter': [state: NoteState];
  'update:team': [team: string];
  'update:search': [value: string];
  select: [id: string];
  'load-more': [];
  /** 笔记拖拽开始:工作区收起详情、展开批量投放卡片。 */
  'drag-start': [];
  /** 拖拽结束(落下或取消):工作区收起批量投放卡片。 */
  'drag-end': [];
}>();

const groups = computed(() => groupNotesByDay(props.notes));
const filters = NOTE_STATES;
// 当前筛选指向一个已不存在的团队时补一个选项，别让下拉静默退回「全部」。
const danglingTeam = computed(() =>
  props.team !== TEAM_FILTER_ALL
  && props.team !== TEAM_FILTER_NONE
  && !props.teams.some(team => team.id === props.team),
);
const teamLabel = computed(() => {
  if (props.team === TEAM_FILTER_ALL) return '全部团队';
  if (props.team === TEAM_FILTER_NONE) return '无来源';
  return props.teams.find(item => item.id === props.team)?.name ?? '团队已删除';
});

/* ------------------------------ 多选与批量 ------------------------------ */
/* 交互镜像左侧栏团队列表:普通点击=重置选区并打开详情;shift+点击=区间并集;
   Cmd/Ctrl=间断切换;拖拽把整个选区带走,投到批量卡片或侧栏 Panel Agent。 */

const selected = ref<string[]>([]);
const anchor = ref<string>();
const visibleIds = computed(() => props.notes.map(note => note.id));

// 拖拽幻影:拖动中的视觉交给原生拖拽影像(合成器渲染,1:1 跟手不节流),
// DOM 幻影只在松手瞬间接力播放「飞向落点」的释放动画。
// 原生影像是快照,悬停变色做不了——动作语义由落点侧的高亮承担。
const dragGhost = ref<HTMLElement | null>(null);
const ghostTitle = ref('');
const ghostCount = ref(0);
const ghostVisible = ref(false);
let ghostLeaveTimer: ReturnType<typeof setTimeout> | undefined;
const noteHandoff = useNoteHandoffStore();

function clearSelection() {
  selected.value = [];
  anchor.value = undefined;
}
watch(() => [props.filter, props.search, props.team], clearSelection);

function toggleSelect(note: Note, event: MouseEvent) {
  // shift = 区间并集;Cmd(Mac)/Ctrl(Windows/Linux)= 间断切换;两者都接受,
  // 不嗅探系统,混合设备(触控板+异厂鼠标)也不会踩空。
  if (event.shiftKey) {
    ({ selected: selected.value, anchor: anchor.value } = selectRange(
      selected.value,
      visibleIds.value,
      anchor.value,
      note.id,
    ));
    return;
  }
  if (event.metaKey || event.ctrlKey) {
    selected.value = toggleSelection(selected.value, note.id);
    anchor.value = note.id;
    return;
  }
  selected.value = [note.id];
  anchor.value = note.id;
  emit('select', note.id);
}

/* ------------------------------ 拖拽接线（PDD 试点） ------------------------------ */
/* 事件层交给 @atlaskit/pragmatic-drag-and-drop:draggable/dropTarget 只声明
   「谁能拖、谁能放、负载是什么」,业务动作与视觉反馈仍是上面的既有逻辑。
   拖拽负载走 PDD 的 data(source.data),不再直接读写 dataTransfer。 */

const rowCleanups = new Map<string, () => void>();
function bindRowDraggable(el: unknown, note: Note) {
  if (el instanceof HTMLElement) {
    // 同一元素重复回调(重渲染)时跳过,避免反复增删监听。
    if (rowCleanups.has(note.id)) return;
    rowCleanups.set(
      note.id,
      draggable({
        element: el,
        getInitialData: () => {
          // 拖拽行不在选区时收缩为单条,与左侧栏团队列表同一套语义。
          if (!selected.value.includes(note.id)) {
            selected.value = [note.id];
            anchor.value = note.id;
          }
          const ids = [...selected.value];
          const first = props.notes.find(item => item.id === ids[0]);
          return {
            type: NOTE_DRAG_TYPE,
            ids,
            title: first?.title || '无标题',
            count: ids.length,
          };
        },
        onGenerateDragPreview: ({ source, location, nativeSetDragImage }) => {
          // 填好幻影内容 → 显示在视口外 → 抓为原生拖拽影像(合成器 1:1 跟手) → 再藏起。
          // 原生影像是拖起瞬间的快照,拖动中不需要 DOM 跟随。
          ghostTitle.value = String(source.data.title);
          ghostCount.value = Number(source.data.count);
          const ghost = dragGhost.value;
          ghost?.getAnimations().forEach(animation => animation.cancel());
          if (ghost) {
            ghost.style.left = '-1000px';
            ghost.style.top = `${location.current.input.clientY}px`;
            ghostVisible.value = true;
            nativeSetDragImage?.(ghost, 140, 28);
            ghostVisible.value = false;
            ghost.style.left = '';
            ghost.style.top = '';
          }
          noteHandoff.beginDrag();
          // 拖起信号:工作区据此收起详情、展开批量投放卡片。
          emit('drag-start');
        },
        // 落下与取消(Esc/落空)都会走到 onDrop:释放动效 + 收尾一次到位。
        onDrop: ({ location }) => {
          noteHandoff.endDrag();
          releaseGhost(location.current.dropTargets[0]?.element, location.current.input);
          // 拖拽结束信号:工作区收起批量投放卡片。
          emit('drag-end');
        },
      }),
    );
    return;
  }
  // 卸载:ref 以 null 回调,清掉该行的 PDD 绑定。
  rowCleanups.get(note.id)?.();
  rowCleanups.delete(note.id);
}

// 释放动效:原生影像在松手瞬间消失,同款幻影在光标处接力,飞向落点中心、
// 缩小淡出(fast 档);取消/无落点则原地快速淡出;减少动态偏好直接撤下。
function releaseGhost(targetElement: Element | undefined, input: { clientX: number; clientY: number }) {
  const ghost = dragGhost.value;
  if (!ghost) return;
  // 内容沿用 dragstart 快照(ghostTitle/ghostCount),这里只负责位置与动效。
  const rect = targetElement instanceof HTMLElement ? targetElement.getBoundingClientRect() : null;
  const duration = motionDurationMs('fast');
  const hide = () => { ghostVisible.value = false; };
  if (prefersReducedMotion()) {
    hide();
    return;
  }
  const inputX = input.clientX;
  const inputY = input.clientY;
  const frames = rect
    ? [
        { left: `${inputX}px`, top: `${inputY}px`, opacity: 1, scale: '1' },
        { left: `${rect.left + rect.width / 2}px`, top: `${rect.top + rect.height / 2}px`, opacity: 0, scale: '0.5' },
      ]
    : [
        { left: `${inputX}px`, top: `${inputY}px`, opacity: 1 },
        { opacity: 0, scale: '0.92' },
      ];
  ghost.style.left = `${inputX}px`;
  ghost.style.top = `${inputY}px`;
  ghostVisible.value = true;
  const animation = ghost.animate(frames, { duration, easing: MOTION_EASING.out, fill: 'forwards' });
  animation.onfinish = hide;
  // WAAPI 偶发不回调的兜底:时长过半倍后强制撤下。
  setTimeout(hide, duration + 80);
}

onBeforeUnmount(() => {
  rowCleanups.forEach(cleanup => cleanup());
  rowCleanups.clear();
});

/* ------------------------------ 日期分组折叠 ------------------------------ */

// 折叠是会话内状态:切筛选/搜索后分组重排,保留旧 key 没有意义。
const collapsedGroups = ref(new Set<string>());
function toggleGroup(key: string, open: boolean) {
  if (open) collapsedGroups.value.delete(key);
  else collapsedGroups.value.add(key);
}

// 触底自动加载:哨兵进入视口即追加下一页,不设按钮。
// 列表是倒序时间线,追加不会改变已读位置,所以不需要用户点头。
const sentinel = ref<HTMLElement | null>(null);
useSentinelLoad({
  sentinel,
  hasMore: () => props.hasMore,
  loading: () => props.loadingMore,
  load: () => emit('load-more'),
});
</script>

<template>
  <div class="flex min-w-0 flex-col gap-3" @keydown.esc.prevent="clearSelection">
    <div class="flex flex-wrap items-center gap-2">
      <div class="flex items-center gap-1" role="tablist" aria-label="记录状态">
        <Button
          v-for="state in filters"
          :key="state"
          size="sm"
          :variant="state === filter ? 'secondary' : 'ghost'"
          role="tab"
          :aria-selected="state === filter"
          @click="emit('update:filter', state)"
        >
          {{ noteStateLabel(state) }}
          <span class="text-xs text-muted-foreground tabular-nums">{{ counts[state] }}</span>
        </Button>
      </div>
      <Select :model-value="team" @update:model-value="value => emit('update:team', String(value))">
        <SelectTrigger class="w-40" aria-label="按来源团队筛选">
          <span data-slot="select-value" class="min-w-0 truncate">{{ teamLabel }}</span>
        </SelectTrigger>
        <SelectContent>
          <SelectItem :value="TEAM_FILTER_ALL">全部团队</SelectItem>
          <SelectItem :value="TEAM_FILTER_NONE">无来源</SelectItem>
          <SelectItem v-for="item in teams" :key="item.id" :value="item.id">{{ item.name }}</SelectItem>
          <SelectItem v-if="danglingTeam" :value="team">团队已删除</SelectItem>
        </SelectContent>
      </Select>
      <div class="relative ms-auto w-full sm:w-56">
        <SearchIcon class="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          :model-value="search"
          class="ps-8"
          placeholder="搜索记录"
          aria-label="搜索记录"
          @update:model-value="emit('update:search', String($event))"
        />
      </div>
    </div>

    <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
    <p v-else-if="loading && !notes.length" class="text-sm text-muted-foreground">正在读取…</p>
    <p v-else-if="!notes.length" class="py-10 text-center text-sm text-muted-foreground">
      {{ search ? '没有匹配的记录' : team !== TEAM_FILTER_ALL ? '这个筛选下还没有记录' : filter === 'archived' ? '还没有归档的记录' : '还没有记录' }}
    </p>

    <div v-else class="flex flex-col gap-2">
      <Disclosure
        v-for="group in groups"
        :key="group.key"
        :heading-level="2"
        :open="!collapsedGroups.has(group.key)"
        @update:open="value => toggleGroup(group.key, value)"
      >
        <template #summary>
          <span class="text-xs font-medium text-muted-foreground">{{ group.label }}</span>
          <Badge variant="outline">{{ group.notes.length }} 条</Badge>
        </template>
        <ul class="flex flex-col pt-1">
          <li v-for="note in group.notes" :key="note.id">
            <button
              type="button"
              :ref="el => bindRowDraggable(el, note)"
              :data-note-id="note.id"
              :data-selected="selected.includes(note.id) ? 'true' : undefined"
              :class="cn(
                'note-row flex w-full min-w-0 cursor-grab flex-col gap-1 rounded-(--component-control-radius) px-2 py-2 text-start transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none active:cursor-grabbing',
                note.id === selectedId && 'bg-accent/70',
              )"
              :aria-current="note.id === selectedId ? 'true' : undefined"
              :aria-pressed="selected.includes(note.id) ? 'true' : undefined"
              @click="toggleSelect(note, $event)"
            >
              <span class="flex min-w-0 items-center gap-2">
                <span class="min-w-0 flex-1 truncate text-sm font-medium">{{ note.title || '无标题' }}</span>
                <Badge v-if="note.state !== 'active'" variant="outline">{{ noteStateLabel(note.state) }}</Badge>
                <span class="shrink-0 text-xs text-muted-foreground tabular-nums">{{ formatNoteTime(note.updated) }}</span>
              </span>
              <span class="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                <Badge v-if="noteSourceLabel(note)" variant="outline" class="shrink-0">
                  {{ noteSourceLabel(note) }}
                </Badge>
                <span class="min-w-0 flex-1 truncate">{{ noteExcerpt(note) }}</span>
                <span v-if="note.todos.length" class="shrink-0 tabular-nums">
                  {{ note.todos.filter(todo => todo.done).length }}/{{ note.todos.length }}
                </span>
                <span v-if="note.due" class="shrink-0">{{ note.due }}</span>
              </span>
            </button>
          </li>
        </ul>
      </Disclosure>

      <!-- 滚动浏览 + 触底追加:分页是数据层能力,列表里不出现页码或按钮。 -->
      <div ref="sentinel" class="h-px" aria-hidden="true"></div>
      <p v-if="loadingMore" class="pt-1 text-center text-xs text-muted-foreground" role="status">
        正在读取…
      </p>

      <!-- 拖拽幻影:常驻但隐藏,拖拽期间作为跟随鼠标的自绘元素
           (原生气动影像已换成透明图)。边框随悬停目标变对应语义色,
           松手时飞向落点收进(WAAPI,见 releaseGhost)。 -->
      <div
        ref="dragGhost"
        class="note-drag-ghost"
        :data-active="ghostVisible ? 'true' : undefined"
        aria-hidden="true"
      >
        <div class="note-drag-ghost-card">
          <NotebookPen class="size-4 shrink-0 text-muted-foreground" />
          <span class="min-w-0 flex-1 truncate text-sm font-medium">{{ ghostTitle }}</span>
          <Badge v-if="ghostCount > 1" variant="secondary" class="shrink-0">{{ ghostCount }} 条</Badge>
        </div>
      </div>
    </div>
  </div>
</template>
