<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ArrowUpRight, Brain, Square } from '@lucide/vue';
import { usePreferencesStore } from '@/stores/preferences';
import { identityColor, identityTintBg, identityTintFg } from '@/features/messages/identity';
import { MOTION_EASING, motionDurationMs, prefersReducedMotion } from '@/shared/motion';
import { CollapseReveal } from '@/components/ui/collapse-reveal';
import { DisclosureChevron } from '@/components/ui/disclosure';
import {
  buildRunRows,
  elapsedLabel,
  runPhaseLabel,
  toolActionLabel,
} from '@/features/messages/run-rows';
import type { StreamView } from '@/features/messages/adapters';
import type { MessageView } from '@/shared/models/view-types';
import {
  buildMemberActivitySummaries,
  buildTopology,
  detectNewFlights,
  type TopologyFlight,
} from '@/features/messages/topology';
import MemberTopologyOverlay from './MemberTopologyOverlay.vue';
import ReasoningScroller from './ReasoningScroller.vue';

/**
 * 运行状态卡:汇总当前会话里正在运行的回合。它只表达“谁在做什么、做了多久”,
 * 正文由消息区的流式组件负责,避免同一份过程在两处重复展示。
 * 卡片读取 source 取值函数,每个增量只重渲染本组件,不牵连已定稿消息。
 */
const props = withDefaults(
  defineProps<{
    source: () => StreamView[];
    messages?: MessageView[];
    selectedKey?: string | null;
    groupNames?: Record<string, string>;
    onStop?: (memberId?: string) => Promise<void> | void;
  }>(),
  {
    messages: () => [],
  },
);
const emit = defineEmits<{ select: [key: string]; jumpMessage: [messageId: string] }>();

const stoppingAll = ref(false);
const stoppingMemberIds = ref<Set<string>>(new Set());

async function handleStop(memberId?: string) {
  if (!props.onStop) return;
  if (!memberId) {
    if (stoppingAll.value) return;
    stoppingAll.value = true;
    try {
      await props.onStop();
    } finally {
      stoppingAll.value = false;
    }
    return;
  }
  if (stoppingAll.value || stoppingMemberIds.value.has(memberId)) return;
  const next = new Set(stoppingMemberIds.value);
  next.add(memberId);
  stoppingMemberIds.value = next;
  try {
    await props.onStop(memberId);
  } finally {
    const after = new Set(stoppingMemberIds.value);
    after.delete(memberId);
    stoppingMemberIds.value = after;
  }
}

const preferences = usePreferencesStore();
// 计时每秒推进一次;只在卡片存在期间运行,卸载即停止。
const now = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | undefined;
onMounted(() => { ticker = setInterval(() => { now.value = Date.now(); }, 1000); });
onBeforeUnmount(() => { if (ticker) clearInterval(ticker); });

const streams = computed(() => props.source());
const rows = computed(() => buildRunRows(streams.value));
const single = computed(() => (rows.value.length === 1 ? rows.value[0]! : null));
const seenMessageIds = new Set<string>();
const seenStreamIds = new Set<string>();
let hydrated = false;
const activeFlights = ref<TopologyFlight[]>([]);

const topology = computed(() =>
  buildTopology(rows.value, props.messages, streams.value, activeFlights.value),
);
const showTopology = computed(() => topology.value.members.length >= 2);
const hasActiveTopologyEdges = computed(
  () => topology.value.edges.length > 0 || activeFlights.value.length > 0,
);
const memberSummaries = computed(() => buildMemberActivitySummaries(props.messages));
const idleTopologyMembers = computed(() => {
  const activeNames = new Set(rows.value.map(r => r.name));
  return topology.value.members.filter(m => !activeNames.has(m.name));
});

watch(
  [() => props.messages, streams],
  ([msgs, currentStreams]) => {
    const nextFlights = detectNewFlights(
      seenMessageIds,
      seenStreamIds,
      msgs,
      currentStreams,
      hydrated,
    );
    hydrated = true;
    if (nextFlights.length) {
      activeFlights.value = [...activeFlights.value, ...nextFlights].slice(-12);
    }
  },
  { immediate: true },
);

function removeFlight(id: string) {
  activeFlights.value = activeFlights.value.filter(f => f.id !== id);
}

const hoveredMember = ref<string | null>(null);
const rowElements = ref<Record<string, HTMLElement | null>>({});

function setRowElement(name: string, el: unknown) {
  if (el instanceof HTMLElement) {
    rowElements.value[name] = el;
  } else {
    delete rowElements.value[name];
  }
}
const activeKey = computed(() => {
  const selected = rows.value.find(row => row.key === props.selectedKey);
  return selected?.key ?? rows.value[0]?.key ?? null;
});
const collapsed = ref(true);
// 手风琴:同一时间只展开一路思考,避免多路并发时把卡片撑到上限。
const openReasoning = ref<string | null>(null);

const headerName = computed(() => {
  if (single.value) return single.value.name;
  if (rows.value.length > 0) return `正在处理 · ${rows.value.length} 路`;
  return `成员通信 · ${topology.value.members.length} 位成员`;
});
const headerDotName = computed(
  () => single.value?.name ?? rows.value[0]?.name ?? topology.value.members[0]?.name ?? '',
);
const headerDotActive = computed(
  () => rows.value.length > 0 && (single.value?.phase ?? 'thinking') !== 'writing',
);
const headerPhase = computed(() => (single.value ? runPhaseLabel(single.value.phase) : ''));
const headerElapsed = computed(() =>
  elapsedLabel(single.value?.startedAt ?? rows.value[0]?.startedAt, now.value),
);
// 折叠后只在还有额外信息时补一行:单路有工具动作时说明动作,多路时列出各路阶段;
// 单路无工具时阶段已在表头,不再重复一行。
const headerSummary = computed(() => {
  if (!single.value) {
    return rows.value.map(row => `${row.name} ${runPhaseLabel(row.phase)}`).join('，');
  }
  return single.value.tool ? toolActionLabel(single.value.tool, props.groupNames) : '';
});
// 单路展开后就是完整明细,不再需要第二层开关;有可展示内容时才给开关,
// 避免点开一个空面板。多路每行各有自己的思考开关,卡片开关始终有意义。
const singleHasDetail = computed(() => Boolean(
  single.value && (single.value.tool || (preferences.showReasoning && single.value.reasoning)),
));
const canToggle = computed(() => !single.value || singleHasDetail.value);
const liveSummary = computed(() => {
  if (rows.value.length > 0) {
    return rows.value.map(row => `${row.name} ${runPhaseLabel(row.phase)}`).join('，');
  }
  return `成员通信拓扑，${topology.value.members.length} 位成员`;
});

const cardRef = ref<HTMLElement | null>(null);
let activeFlip: Animation | null = null;

async function toggleCollapsed(nextCollapsed?: boolean) {
  const target = nextCollapsed ?? !collapsed.value;
  if (target === collapsed.value) return;

  const el = cardRef.value;
  if (!showTopology.value || !el || prefersReducedMotion() || typeof el.animate !== 'function') {
    collapsed.value = target;
    return;
  }

  activeFlip?.cancel();
  const firstRect = el.getBoundingClientRect();
  collapsed.value = target;
  await nextTick();

  const lastRect = el.getBoundingClientRect();
  if (!firstRect.width || !firstRect.height || !lastRect.width || !lastRect.height) return;

  activeFlip = el.animate(
    [
      {
        width: `${firstRect.width}px`,
        height: `${firstRect.height}px`,
        overflow: 'hidden',
      },
      {
        width: `${lastRect.width}px`,
        height: `${lastRect.height}px`,
        overflow: 'hidden',
      },
    ],
    {
      duration: motionDurationMs('slow'),
      easing: MOTION_EASING.out,
    },
  );
  activeFlip.onfinish = () => { activeFlip = null; };
  activeFlip.oncancel = () => { activeFlip = null; };
}

function onRowClick(rowKey: string, rowHasReasoning: boolean) {
  emit('select', rowKey);
  if (!rowHasReasoning) return;
  openReasoning.value = openReasoning.value === rowKey ? null : rowKey;
}
</script>

<template>
<!-- 底栏整块由 ConversationScroller 统一承担 action 表面，这里只作底栏内的状态子区，避免双层毛玻璃与边界嵌套。 -->
  <aside
    v-if="rows.length || showTopology"
    ref="cardRef"
    class="run-card"
    :class="{
      'run-card-capsule': showTopology && collapsed,
      'run-card-with-topology': showTopology && !collapsed,
    }"
    data-testid="run-status-card"
  >
    <p class="sr-only" role="status" aria-live="polite">{{ liveSummary }}</p>

    <template v-if="showTopology && collapsed">
      <div
        class="run-card-capsule-trigger run-card-toggle"
        role="button"
        tabindex="0"
        aria-expanded="false"
        aria-label="展开成员活动与通信拓扑"
        data-testid="run-card-capsule"
        @click="toggleCollapsed(false)"
        @keydown.enter.space.prevent="toggleCollapsed(false)"
      >
        <MemberTopologyOverlay
          mode="compact"
          :members="topology.members"
          :edges="topology.edges"
          :flights="activeFlights"
          :hovered-member="hoveredMember"
          @hover-member="hoveredMember = $event"
          @flight-done="removeFlight"
        />
      </div>
    </template>

    <template v-else>
      <div class="run-card-head">
        <span
          class="run-dot"
          :class="{ 'animate-pulse': headerDotActive }"
          :style="{ backgroundColor: identityColor(headerDotName) }"
          aria-hidden="true"
        />
        <span class="min-w-0 flex-1 truncate font-medium">{{ headerName }}</span>
        <span v-if="headerPhase" class="run-phase">{{ headerPhase }}</span>
        <span v-if="headerElapsed" class="run-time tabular-nums">{{ headerElapsed }}</span>
        <button
          v-if="onStop && rows.length"
          type="button"
          class="run-card-stop"
          :disabled="stoppingAll || (single?.memberId ? stoppingMemberIds.has(single.memberId) : false)"
          :aria-label="single ? `停止 ${single.name}` : '停止全部运行中成员'"
          :title="single ? `停止 ${single.name}` : '停止全部'"
          data-testid="run-card-stop"
          @click="handleStop(single?.memberId)"
        >
          <Square class="size-3 fill-current" aria-hidden="true" />
          {{ stoppingAll || (single?.memberId && stoppingMemberIds.has(single.memberId)) ? '停止中…' : '停止' }}
        </button>
        <button
          v-if="canToggle || showTopology"
          type="button"
          class="run-card-toggle"
          :aria-label="collapsed ? '展开运行状态' : '收起运行状态'"
          :aria-expanded="!collapsed"
          @click="toggleCollapsed()"
        >
          {{ collapsed ? '展开' : '收起' }}
          <DisclosureChevron :open="collapsed" />
        </button>
      </div>

      <!-- 折叠态仅在还有补充信息时占第二行。 -->
      <p v-if="collapsed && headerSummary" class="run-card-summary">{{ headerSummary }}</p>
    </template>

    <CollapseReveal v-if="!showTopology" :show="!collapsed">
      <div class="run-card-body">
        <div class="run-card-main">
          <p v-if="single?.tool" class="run-card-tool">{{ toolActionLabel(single.tool, groupNames) }}</p>
          <!-- 单路:展开即完整明细,思考直接跟随当前动作显示。 -->
          <div v-if="single" class="run-card-list">
            <div
              v-if="preferences.showReasoning && single.reasoning"
              class="run-reasoning"
            >
              <ReasoningScroller :key="single.key" :text="single.reasoning" />
            </div>
          </div>
        </div>
      </div>
    </CollapseReveal>

    <div v-else-if="!collapsed" class="run-card-body run-card-body-with-topology run-card-body-enter">
        <div class="run-card-main">
          <p v-if="single?.tool" class="run-card-tool">{{ toolActionLabel(single.tool, groupNames) }}</p>
          <!-- 单路:展开即完整明细,思考直接跟随当前动作显示。 -->
          <div v-if="single && !showTopology" class="run-card-list">
            <div
              v-if="preferences.showReasoning && single.reasoning"
              class="run-reasoning"
            >
              <ReasoningScroller :key="single.key" :text="single.reasoning" />
            </div>
          </div>
          <!-- 多路或含拓扑:每路一行,右侧可锚定拓扑连线。 -->
          <div v-else class="run-card-list">
            <div v-for="row in rows" :key="row.key" class="run-row-wrap">
              <div
                :ref="el => setRowElement(row.name, el)"
                class="run-row-item"
                @mouseenter="hoveredMember = row.name"
                @mouseleave="hoveredMember = null"
              >
                <div class="run-row-stack">
                  <button
                    type="button"
                    class="run-row"
                    :class="activeKey === row.key && 'run-row-active'"
                    :aria-pressed="activeKey === row.key"
                    :aria-expanded="preferences.showReasoning && row.reasoning ? openReasoning === row.key : undefined"
                    :data-run-key="row.key"
                    @click="onRowClick(row.key, preferences.showReasoning && Boolean(row.reasoning))"
                  >
                    <span class="run-row-line">
                      <span
                        class="run-row-avatar"
                        :style="{
                          backgroundColor: identityTintBg(row.name),
                          color: identityTintFg(row.name),
                        }"
                        aria-hidden="true"
                      >{{ row.name.slice(0, 1) }}</span>
                      <span class="min-w-0 flex-1 truncate font-medium">{{ row.name }}</span>
                      <span v-if="memberSummaries[row.name]?.count" class="run-row-count">
                        收发 {{ memberSummaries[row.name]!.count }} 条
                      </span>
                      <span class="run-phase">{{ runPhaseLabel(row.phase) }}</span>
                      <span v-if="elapsedLabel(row.startedAt, now)" class="run-time tabular-nums">
                        {{ elapsedLabel(row.startedAt, now) }}
                      </span>
                      <span
                        v-if="preferences.showReasoning && row.reasoning"
                        class="run-reasoning-hint"
                      >
                        <Brain class="run-reasoning-icon" aria-hidden="true" />
                        思考
                      </span>
                    </span>
                    <span v-if="row.tool" class="run-row-tool">
                      {{ toolActionLabel(row.tool, groupNames) }}
                    </span>
                  </button>
                  <button
                    v-if="!row.tool && memberSummaries[row.name]?.lastMessageId"
                    type="button"
                    class="run-row-tool run-row-jump"
                    title="跳转到该条消息"
                    :data-jump-message="memberSummaries[row.name]!.lastMessageId"
                    @click.stop="emit('jumpMessage', memberSummaries[row.name]!.lastMessageId!)"
                  >
                    <span class="min-w-0 truncate">{{ memberSummaries[row.name]!.lastSummary }}</span>
                    <ArrowUpRight class="size-3 shrink-0" aria-hidden="true" />
                  </button>
                </div>
                <button
                  v-if="onStop && row.memberId"
                  type="button"
                  class="run-row-stop"
                  :disabled="stoppingAll || stoppingMemberIds.has(row.memberId)"
                  :aria-label="`停止 ${row.name}`"
                  :title="`停止 ${row.name}`"
                  :data-stop-member="row.memberId"
                  @click.stop="handleStop(row.memberId)"
                >
                  <Square class="size-3 fill-current" aria-hidden="true" />
                </button>
              </div>
              <CollapseReveal
                v-if="preferences.showReasoning && row.reasoning"
                :show="openReasoning === row.key"
              >
                <div class="run-reasoning">
                  <ReasoningScroller :key="row.key" :text="row.reasoning" />
                </div>
              </CollapseReveal>
            </div>
            <div
              v-for="idle in idleTopologyMembers"
              :key="`idle:${idle.name}`"
              :ref="el => setRowElement(idle.name, el)"
              class="run-row-idle"
              @mouseenter="hoveredMember = idle.name"
              @mouseleave="hoveredMember = null"
            >
              <span
                class="run-row-avatar"
                :style="{
                  backgroundColor: identityTintBg(idle.name),
                  color: identityTintFg(idle.name),
                }"
                aria-hidden="true"
              >{{ idle.name.slice(0, 1) }}</span>
              <span class="run-row-idle-info">
                <span class="run-row-line">
                  <span class="min-w-0 flex-1 truncate font-medium text-foreground">{{ idle.name }}</span>
                  <span v-if="memberSummaries[idle.name]?.count" class="run-row-count">
                    收发 {{ memberSummaries[idle.name]!.count }} 条
                  </span>
                </span>
                <button
                  v-if="memberSummaries[idle.name]?.lastMessageId"
                  type="button"
                  class="run-row-tool run-row-jump"
                  title="跳转到该条消息"
                  :data-jump-message="memberSummaries[idle.name]!.lastMessageId"
                  @click="emit('jumpMessage', memberSummaries[idle.name]!.lastMessageId!)"
                >
                  <span class="min-w-0 truncate">{{ memberSummaries[idle.name]!.lastSummary }}</span>
                  <ArrowUpRight class="size-3 shrink-0" aria-hidden="true" />
                </button>
              </span>
            </div>
          </div>
        </div>
        <MemberTopologyOverlay
          v-if="showTopology && !collapsed && hasActiveTopologyEdges"
          mode="expanded"
          :members="topology.members"
          :edges="topology.edges"
          :flights="activeFlights"
          :hovered-member="hoveredMember"
          :anchor-elements="rowElements"
          @hover-member="hoveredMember = $event"
          @flight-done="removeFlight"
        />
      </div>
  </aside>
</template>
