<script setup lang="ts">
import { computed, ref } from 'vue';
import { Search as SearchIcon } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import type { Note, NoteCounts, NoteState } from '@/shared/api/raw-types';
import { useSentinelLoad } from '@/shared/use-sentinel-load';
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
  <div class="flex min-w-0 flex-col gap-3">
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

    <div v-else class="flex flex-col gap-4">
      <section v-for="group in groups" :key="group.key" class="flex flex-col gap-1">
        <h2 class="px-1 text-xs font-medium text-muted-foreground">{{ group.label }}</h2>
        <ul class="flex flex-col">
          <li v-for="note in group.notes" :key="note.id">
            <button
              type="button"
              :data-note-id="note.id"
              :class="cn(
                'note-row flex w-full min-w-0 flex-col gap-1 rounded-(--component-control-radius) px-2 py-2 text-start transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
                note.id === selectedId && 'bg-accent/70',
              )"
              :aria-current="note.id === selectedId ? 'true' : undefined"
              @click="emit('select', note.id)"
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
      </section>

      <!-- 滚动浏览 + 触底追加:分页是数据层能力,列表里不出现页码或按钮。 -->
      <div ref="sentinel" class="h-px" aria-hidden="true"></div>
      <p v-if="loadingMore" class="pt-1 text-center text-xs text-muted-foreground" role="status">
        正在读取…
      </p>
    </div>
  </div>
</template>
