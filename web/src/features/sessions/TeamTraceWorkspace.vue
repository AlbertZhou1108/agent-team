<script setup lang="ts">
import { computed, ref } from 'vue';
import { Activity, Braces, Check, Copy, LoaderCircle } from '@lucide/vue';
import CodeBlock from '@/components/ai-elements/CodeBlock.vue';
import TurnTraceSection from '@/components/ai-elements/TurnTraceSection.vue';
import TraceStepCard from '@/components/ai-elements/TraceStepCard.vue';
import PanelState from '@/components/panel/PanelState.vue';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Disclosure } from '@/components/ui/disclosure';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { buildTurns, serverStatus } from '@/features/traces/reducer';
import { useSentinelLoad } from '@/shared/use-sentinel-load';
import { useRawEventsQuery } from './use-raw-events';
import type { HistoryRow, Member, SessionEndpoint, TurnSummary } from '@/shared/api/raw-types';
import type { Host } from '@/shared/models/view-types';

/**
 * 中间主区「轨迹 / 原始事件」宽版工作区（参考 DSH 标签页布局）。
 * - 轨迹页：时间轴概览色块条 + 统一外层滚动容器包裹连续回合行（非每回合卡片）
 * - 原始事件页：分类过滤标签 + 搜索过滤 + 展开 JSON + 一键复制
 */
const props = defineProps<{
  mode: 'trace' | 'events';
  endpoints: SessionEndpoint[];
  endpoint?: SessionEndpoint;
  members: Member[];
  actors?: Array<{ id: string; name: string; host?: string }>;
  turnSummaries: TurnSummary[];
  unaffiliatedEvents: HistoryRow[];
  loading?: boolean;
  hasNextPage?: boolean;
  fetchingNextPage?: boolean;
  searchQuery?: string;
}>();

const emit = defineEmits<{
  'select-session': [id: string];
  'load-more': [];
}>();

const endpointHost = computed(
  () =>
    props.members.find((member) => member.id === props.endpoint?.member_id)?.host ??
    props.actors?.find((actor) => actor.id === props.endpoint?.member_id)?.host,
);

const selectableEndpoints = computed(() =>
  props.endpoints.filter((item) => item.context !== 'profile'),
);

function memberName(id: string) {
  return (
    props.members.find((member) => member.id === id)?.name ??
    props.actors?.find((actor) => actor.id === id)?.name ??
    id
  );
}

// ── 轨迹视图：时间轴概览 + 状态分段筛选 ──────────────────────────────────────
type TurnFilter = 'all' | 'error' | 'completed';
const turnFilter = ref<TurnFilter>('all');
const turnFilterOptions: Array<{ value: TurnFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'error', label: '失败' },
  { value: 'completed', label: '已完成' },
];
function setTurnFilter(value: unknown) {
  if (value === 'all' || value === 'error' || value === 'completed') {
    turnFilter.value = value;
    highlightedTurnId.value = null;
  }
}

const highlightedTurnId = ref<string | null>(null);
const normalizedQuery = computed(() => (props.searchQuery ?? '').trim().toLowerCase());

const filteredTurns = computed(() => {
  if (turnFilter.value === 'all') return props.turnSummaries;
  return props.turnSummaries.filter((turn) => serverStatus(turn.state) === turnFilter.value);
});

const turnStats = computed(() => {
  let failed = 0;
  let completed = 0;
  let running = 0;
  for (const turn of props.turnSummaries) {
    const st = serverStatus(turn.state);
    if (st === 'error') failed += 1;
    else if (st === 'completed') completed += 1;
    else if (st === 'running') running += 1;
  }
  return { total: props.turnSummaries.length, failed, completed, running };
});

function segmentTone(state: string) {
  const st = serverStatus(state);
  if (st === 'error') return 'bg-destructive/80';
  if (st === 'running') return 'bg-success';
  if (st === 'completed') return 'bg-primary/70';
  return 'bg-muted-foreground/40';
}

function jumpToTurn(turnId: string) {
  highlightedTurnId.value = turnId;
  if (typeof document !== 'undefined') {
    document.getElementById(`turn-row-${turnId}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

const unaffiliatedSteps = computed(() => {
  if (!props.unaffiliatedEvents.length || !props.endpoint?.id) return [];
  const [view] = buildTurns(props.unaffiliatedEvents, {
    hosts: { [props.endpoint.id]: (endpointHost.value ?? 'unknown') as Host },
  });
  return view?.steps ?? [];
});

// ── 原始事件视图：按类型过滤 + 关键词搜索 + 单条复制 ──────────────────────────
type EventCategory = 'all' | 'error' | 'model' | 'tool' | 'system';
const eventCategory = ref<EventCategory>('all');
const categoryOptions: Array<{ value: EventCategory; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'error', label: '错误' },
  { value: 'model', label: '模型' },
  { value: 'tool', label: '工具' },
  { value: 'system', label: '系统' },
];
function setEventCategory(value: unknown) {
  if (value === 'all' || value === 'error' || value === 'model' || value === 'tool' || value === 'system') {
    eventCategory.value = value;
  }
}

const eventsActive = computed(() => props.mode === 'events');
const {
  rows: rawRows,
  isPending: rawPending,
  hasNextPage: rawHasNextPage,
  isFetchingNextPage: rawFetchingNextPage,
  fetchNextPage: rawFetchNextPage,
} = useRawEventsQuery(() => props.endpoint?.id, eventsActive);

const rawScrollEl = ref<HTMLElement | null>(null);
const rawSentinel = ref<HTMLElement | null>(null);
useSentinelLoad({
  sentinel: rawSentinel,
  root: rawScrollEl,
  hasMore: () => rawHasNextPage.value,
  loading: () => rawPending.value || rawFetchingNextPage.value,
  load: () => { void rawFetchNextPage(); },
});

function eventName(value: string) {
  try {
    const parsed = JSON.parse(value);
    return String(parsed.method ?? parsed.type ?? 'event');
  } catch {
    return '无法解析的事件';
  }
}

function eventMatchesCategory(value: string, category: EventCategory): boolean {
  if (category === 'all') return true;
  const name = eventName(value).toLowerCase();
  if (category === 'error') {
    return name.includes('error') || name.includes('fail') || value.includes('"is_error":true');
  }
  if (category === 'model') {
    return name.includes('model') || name.includes('thinking') || name.includes('text') || name.includes('reasoning');
  }
  if (category === 'tool') {
    return name.includes('tool') || name.includes('call') || name.includes('mcp');
  }
  return name.startsWith('framework.') || name.includes('session') || name.includes('status') || name.includes('system');
}

const filteredRawRows = computed(() => {
  const q = normalizedQuery.value;
  return rawRows.value.filter((row) => {
    if (!eventMatchesCategory(row.event, eventCategory.value)) return false;
    if (!q) return true;
    const haystack = `#${row.seq} ${eventName(row.event)} ${row.event}`.toLowerCase();
    return haystack.includes(q);
  });
});

const expandedRawSeqs = ref(new Set<number>());
function toggleRawRow(seq: number, open: boolean) {
  const next = new Set(expandedRawSeqs.value);
  if (open) next.add(seq);
  else next.delete(seq);
  expandedRawSeqs.value = next;
}

const copiedSeq = ref<number | null>(null);
let copySeqTimer: ReturnType<typeof setTimeout> | null = null;
async function copyRawEvent(row: HistoryRow) {
  try {
    await navigator.clipboard?.writeText(prettyEvent(row.event));
    copiedSeq.value = row.seq;
    if (copySeqTimer) clearTimeout(copySeqTimer);
    copySeqTimer = setTimeout(() => { copiedSeq.value = null; }, 1600);
  } catch {
    // ignore
  }
}

function prettyEvent(value: string) {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}
</script>

<template>
  <div class="flex min-h-0 min-w-0 flex-1 flex-col gap-3 px-4 py-3" data-testid="team-trace-workspace">
    <!-- 无选中会话时，提供一键选择可用会话。 -->
    <div v-if="!endpoint" class="flex flex-1 flex-col items-center justify-center gap-3">
      <PanelState
        :icon="mode === 'events' ? Braces : Activity"
        title="选择一个会话查看执行轨迹"
        description="从顶部下拉切换器或下方快捷按钮选择团队会话。"
      />
      <div v-if="selectableEndpoints.length" class="flex flex-wrap justify-center gap-2">
        <Button
          v-for="item in selectableEndpoints"
          :key="item.id"
          variant="outline"
          size="sm"
          @click="emit('select-session', item.id)"
        >
          {{ memberName(item.member_id) }} · {{ item.context === 'coordination' ? '统一调度' : item.context }}
        </Button>
      </div>
    </div>

    <!-- 模式一：执行轨迹 -->
    <template v-else-if="mode === 'trace'">
      <div
        v-if="turnSummaries.length"
        class="flex shrink-0 flex-col gap-2 rounded-(--component-card-radius) border border-border bg-muted/20 px-3 py-2"
        data-testid="trace-timeline-overview"
      >
        <div class="flex flex-wrap items-center gap-3 text-xs text-muted-foreground tabular-nums">
          <span>轮次 {{ turnStats.total }}</span>
          <span v-if="turnStats.completed">已完成 {{ turnStats.completed }}</span>
          <span v-if="turnStats.failed" class="text-destructive">失败 {{ turnStats.failed }}</span>
          <span v-if="turnStats.running" class="text-success">运行中 {{ turnStats.running }}</span>
          <ToggleGroup
            presentation="segmented"
            type="single"
            variant="outline"
            size="sm"
            :model-value="turnFilter"
            class="ms-auto"
            aria-label="回合状态筛选"
            @update:model-value="setTurnFilter"
          >
            <ToggleGroupItem
              v-for="item in turnFilterOptions"
              :key="item.value"
              :value="item.value"
            >
              {{ item.label }}
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        <div
          class="flex h-2.5 w-full items-stretch gap-0.5 overflow-hidden rounded-(--component-chip-radius) bg-muted/50"
          role="group"
          aria-label="回合时间轴概览"
        >
          <button
            v-for="turn in filteredTurns"
            :key="turn.id"
            type="button"
            class="h-full min-w-2 flex-1 transition-opacity hover:opacity-80"
            :class="[segmentTone(turn.state), highlightedTurnId === turn.id && 'ring-1 ring-inset ring-foreground/50']"
            :style="{ flexGrow: Math.max(1, turn.eventCount) }"
            :title="`第 ${turn.ordinal} 轮 · ${turn.eventCount} 步 · ${turn.state}`"
            :aria-label="`定位到第 ${turn.ordinal} 轮`"
            @click="jumpToTurn(turn.id)"
          />
        </div>
      </div>

      <!-- 统一外层滚动容器包裹所有连续回合行（非每回合卡片）。 -->
      <div
        class="scrollbar-thin flex min-h-0 flex-1 flex-col overflow-y-auto rounded-(--component-card-radius) border border-border bg-background/40 px-4 py-2"
        data-testid="trace-turns-scroll"
      >
        <PanelState v-if="loading" loading title="正在读取回合" />
        <PanelState
          v-else-if="!filteredTurns.length"
          :icon="Activity"
          :title="turnFilter !== 'all' ? '该状态下暂无回合' : '暂无执行轨迹'"
          :description="turnFilter !== 'all' ? '切换上方状态筛选或加载更多回合。' : '会话开始执行后，回合会显示在这里。'"
        />
        <div v-else class="flex min-w-0 flex-col divide-y divide-border/70">
          <TurnTraceSection
            v-for="turn in filteredTurns"
            :key="turn.id"
            :turn="turn"
            :endpoint-id="endpoint.id"
            :highlighted="highlightedTurnId === turn.id"
          />
        </div>

        <Button
          v-if="hasNextPage"
          variant="outline"
          size="sm"
          class="mt-3 w-full shrink-0"
          :disabled="fetchingNextPage"
          @click="emit('load-more')"
        >
          <LoaderCircle v-if="fetchingNextPage" class="animate-spin" />
          {{ fetchingNextPage ? '正在加载' : '加载更多回合' }}
        </Button>

        <Disclosure v-if="unaffiliatedSteps.length" class="mt-3 border-t border-border pt-2">
          <template #summary>
            <span class="min-w-0 flex-1 truncate">未关联回合</span>
            <Badge variant="outline">{{ unaffiliatedEvents.length }} 条</Badge>
          </template>
          <p class="mt-1 text-xs text-muted-foreground">以下事件不属于任何回合（如宿主会话轮换）。</p>
          <div class="mt-2 flex min-w-0 flex-col">
            <TraceStepCard
              v-for="step in unaffiliatedSteps"
              :key="step.id"
              :step="step"
              data-record-row
            />
          </div>
        </Disclosure>
      </div>
    </template>

    <!-- 模式二：原始事件（展开 + 分类过滤 + 搜索 + 复制） -->
    <template v-else>
      <div class="flex shrink-0 flex-wrap items-center justify-between gap-2" data-testid="raw-events-filters">
        <ToggleGroup
          presentation="segmented"
          type="single"
          variant="outline"
          size="sm"
          :model-value="eventCategory"
          aria-label="原始事件分类过滤"
          @update:model-value="setEventCategory"
        >
          <ToggleGroupItem
            v-for="item in categoryOptions"
            :key="item.value"
            :value="item.value"
          >
            {{ item.label }}
          </ToggleGroupItem>
        </ToggleGroup>
        <span class="text-xs text-muted-foreground tabular-nums">
          显示 {{ filteredRawRows.length }} / {{ rawRows.length }} 条
        </span>
      </div>

      <div
        ref="rawScrollEl"
        class="scrollbar-thin flex min-h-0 flex-1 flex-col overflow-y-auto rounded-(--component-card-radius) border border-border bg-background/40 px-3 py-2"
        data-testid="raw-events-scroll"
      >
        <PanelState v-if="rawPending" loading title="正在读取原始事件" />
        <PanelState
          v-else-if="!filteredRawRows.length"
          :icon="Braces"
          :title="rawRows.length ? '没有匹配的原始事件' : '暂无原始事件'"
          :description="rawRows.length ? '尝试切换分类或清空搜索词。' : '宿主输出事件流后显示在这里。'"
        />
        <div v-else class="flex min-w-0 flex-col divide-y divide-border/60">
          <div
            v-for="row in filteredRawRows"
            :key="row.seq"
            class="min-w-0 py-1.5"
            data-record-row
          >
            <Disclosure
              :open="expandedRawSeqs.has(row.seq)"
              persist-actions
              @update:open="toggleRawRow(row.seq, $event)"
            >
              <template #summary>
                <span class="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">#{{ row.seq }}</span>
                <span
                  class="min-w-0 flex-1 truncate font-mono text-xs text-foreground"
                  :title="eventName(row.event)"
                >{{ eventName(row.event) }}</span>
                <time class="shrink-0 text-xs text-muted-foreground tabular-nums">{{
                  new Date(row.created).toLocaleTimeString('zh-CN')
                }}</time>
              </template>
              <template #actions>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  :aria-label="`复制事件 #${row.seq}`"
                  title="复制原始 JSON"
                  @click="copyRawEvent(row)"
                >
                  <Check v-if="copiedSeq === row.seq" class="text-success" />
                  <Copy v-else />
                </Button>
              </template>
              <div class="mt-2">
                <CodeBlock
                  v-if="expandedRawSeqs.has(row.seq)"
                  :code="prettyEvent(row.event)"
                  max-height="18rem"
                />
              </div>
            </Disclosure>
          </div>
          <div ref="rawSentinel" class="h-px" aria-hidden="true" />
        </div>
        <p
          v-if="rawFetchingNextPage"
          class="flex items-center gap-1 py-2 text-xs text-muted-foreground"
        >
          <LoaderCircle class="size-3 animate-spin" />正在加载更多事件…
        </p>
      </div>
    </template>
  </div>
</template>
