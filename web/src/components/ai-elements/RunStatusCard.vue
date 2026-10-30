<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { Brain, ChevronDown } from '@lucide/vue';
import { usePreferencesStore } from '@/stores/preferences';
import { useUiStore } from '@/stores/ui';
import { identityColor } from '@/features/messages/identity';
import {
  buildRunRows,
  elapsedLabel,
  runPhaseLabel,
  toolActionLabel,
} from '@/features/messages/run-rows';
import type { StreamView } from '@/features/messages/adapters';

/**
 * 运行状态卡:汇总当前会话里正在运行的回合。它只表达“谁在做什么、做了多久”,
 * 正文由消息区的流式组件负责,避免同一份过程在两处重复展示。
 * 卡片读取 source 取值函数,每个增量只重渲染本组件,不牵连已定稿消息。
 */
const props = defineProps<{
  source: () => StreamView[];
  selectedKey?: string | null;
  groupNames?: Record<string, string>;
}>();
const emit = defineEmits<{ select: [key: string] }>();

const preferences = usePreferencesStore();
const ui = useUiStore();
// 计时每秒推进一次;只在卡片存在期间运行,卸载即停止。
const now = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | undefined;
onMounted(() => { ticker = setInterval(() => { now.value = Date.now(); }, 1000); });
onBeforeUnmount(() => { if (ticker) clearInterval(ticker); });

const rows = computed(() => buildRunRows(props.source()));
const single = computed(() => (rows.value.length === 1 ? rows.value[0]! : null));
const activeKey = computed(() => {
  const selected = rows.value.find(row => row.key === props.selectedKey);
  return selected?.key ?? rows.value[0]?.key ?? null;
});
const collapsed = computed({
  get: () => ui.runCardCollapsed,
  set: (value: boolean) => {
    ui.runCardCollapsed = value;
    ui.persist();
  },
});
// 手风琴:同一时间只展开一路思考,避免多路并发时把卡片撑到上限。
const openReasoning = ref<string | null>(null);

const headerName = computed(() => single.value?.name ?? `正在处理 · ${rows.value.length} 路`);
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
const liveSummary = computed(() =>
  rows.value.map(row => `${row.name} ${runPhaseLabel(row.phase)}`).join('，'),
);

function onRowClick(rowKey: string, rowHasReasoning: boolean) {
  emit('select', rowKey);
  if (!rowHasReasoning) return;
  openReasoning.value = openReasoning.value === rowKey ? null : rowKey;
}
</script>

<template>
  <div v-if="rows.length" class="run-card" data-testid="run-status-card">
    <p class="sr-only" role="status" aria-live="polite">{{ liveSummary }}</p>

    <div class="run-card-head">
      <span
        class="run-dot"
        :class="{ 'animate-pulse': (single?.phase ?? 'thinking') !== 'writing' }"
        :style="{ backgroundColor: identityColor(single?.name ?? rows[0]!.name) }"
        aria-hidden="true"
      />
      <span class="min-w-0 flex-1 truncate font-medium">{{ headerName }}</span>
      <span v-if="headerPhase" class="run-phase">{{ headerPhase }}</span>
      <span v-if="headerElapsed" class="run-time tabular-nums">{{ headerElapsed }}</span>
      <button
        v-if="canToggle"
        type="button"
        class="run-card-toggle"
        :aria-label="collapsed ? '展开运行状态' : '收起运行状态'"
        :aria-expanded="!collapsed"
        @click="collapsed = !collapsed"
      >
        {{ collapsed ? '展开' : '收起' }}
        <ChevronDown class="size-3.5 transition-transform" :class="!collapsed && 'rotate-180'" />
      </button>
    </div>

    <!-- 折叠态仅在还有补充信息时占第二行。 -->
    <p v-if="collapsed && headerSummary" class="run-card-summary">{{ headerSummary }}</p>

    <template v-if="!collapsed">
      <p v-if="single?.tool" class="run-card-tool">{{ toolActionLabel(single.tool, groupNames) }}</p>
      <!-- 单路:展开即完整明细,思考直接跟随当前动作显示。 -->
      <div v-if="single" class="run-card-list">
        <div
          v-if="preferences.showReasoning && single.reasoning"
          class="run-reasoning"
        >
          <p class="run-reasoning-text scrollbar-thin">{{ single.reasoning }}</p>
        </div>
      </div>
      <!-- 多路并发:每路一行,点选决定正文区展示哪一路。 -->
      <div v-else class="run-card-list">
        <div v-for="row in rows" :key="row.key" class="run-row-wrap">
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
                class="run-dot"
                :class="{ 'animate-pulse': row.phase !== 'writing' }"
                :style="{ backgroundColor: identityColor(row.name) }"
                aria-hidden="true"
              />
              <span class="min-w-0 flex-1 truncate font-medium">{{ row.name }}</span>
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
          <div
            v-if="preferences.showReasoning && row.reasoning && openReasoning === row.key"
            class="run-reasoning"
          >
            <p class="run-reasoning-text scrollbar-thin">{{ row.reasoning }}</p>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
