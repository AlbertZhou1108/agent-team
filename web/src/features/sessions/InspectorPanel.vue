<script setup lang="ts">
import { computed } from 'vue';
import {
  Activity,
  Braces,
  Database,
  LoaderCircle,
  PanelRightClose,
} from '@lucide/vue';
import type {
  Member,
  ModelObservation,
  ModelState,
  SessionEndpoint,
} from '@/shared/api/raw-types';
import type { HistoryRow } from '@/shared/api/raw-types';
import type { TurnView } from '@/shared/models/view-types';
import TraceTimeline from '@/components/ai-elements/TraceTimeline.vue';
import CodeBlock from '@/components/ai-elements/CodeBlock.vue';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { TabsList, TabsRoot, TabsTrigger } from 'reka-ui';
import type { InspectorTab } from './types';

const props = defineProps<{
  endpoint?: SessionEndpoint;
  members: Member[];
  turns: TurnView[];
  historyRows: HistoryRow[];
  modelState?: ModelState | null;
  observations: ModelObservation[];
  tab: InspectorTab;
  loading?: boolean;
  hasNextPage?: boolean;
  fetchingNextPage?: boolean;
}>();

const emit = defineEmits<{
  'update:tab': [value: InspectorTab];
  loadMore: [];
  close: [];
}>();

const tabs: Array<{ value: InspectorTab; label: string; icon: typeof Activity }> = [
  { value: 'trace', label: '执行轨迹', icon: Activity },
  { value: 'events', label: '原始事件', icon: Braces },
  { value: 'models', label: '模型', icon: Database },
];

const memberName = computed(() => {
  const id = props.endpoint?.member_id;
  return props.members.find(member => member.id === id)?.name ?? id ?? '宿主会话';
});

function prettyEvent(value: string) {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}
</script>

<template>
  <section class="inspector-panel">
    <header class="flex items-start justify-between gap-3 border-b border-[var(--border)] pb-3">
      <div class="min-w-0">
        <p class="eyebrow">SESSION INSPECTOR</p>
        <h2 class="mt-1 truncate text-sm font-medium">{{ memberName }}</h2>
        <p class="mt-1 truncate font-mono text-[9px] text-dim">{{ endpoint?.id ?? '尚未选择会话' }}</p>
      </div>
      <Button variant="ghost" size="icon" class="lg:hidden" title="关闭详情" @click="emit('close')">
        <PanelRightClose :size="15" />
      </Button>
    </header>

    <TabsRoot
      v-if="endpoint"
      :model-value="tab"
      class="mt-4"
      @update:model-value="emit('update:tab', $event as InspectorTab)"
    >
      <TabsList class="flex gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] p-1">
        <TabsTrigger
          v-for="item in tabs"
          :key="item.value"
          :value="item.value"
          :class="cn('inspector-tab', tab === item.value && 'inspector-tab-active')"
        >
          <component :is="item.icon" :size="12" />
          {{ item.label }}
        </TabsTrigger>
      </TabsList>
    </TabsRoot>

    <div v-if="loading" class="mt-8 flex items-center justify-center gap-2 text-xs text-muted">
      <LoaderCircle :size="15" class="animate-spin" />
      正在读取宿主事件…
    </div>

    <div v-else-if="!endpoint" class="empty-state mt-6">
      从右侧会话列表选择一个宿主会话。
    </div>

    <div v-else class="mt-4 min-h-0 flex-1 overflow-y-auto pr-1">
      <TraceTimeline v-if="tab === 'trace'" :turns="turns" />

      <div v-else-if="tab === 'events'" class="space-y-2">
        <div class="mb-3 flex items-center justify-between">
          <p class="text-[11px] leading-5 text-muted">宿主实际输出的事件流，可能包含宿主自身的截断。</p>
          <Badge>{{ historyRows.length }} 条</Badge>
        </div>
        <details v-for="row in historyRows" :key="row.seq" class="event-row">
          <summary class="flex cursor-pointer items-center gap-2">
            <span class="font-mono text-[10px] text-dim">#{{ row.seq }}</span>
            <span class="min-w-0 flex-1 truncate font-mono text-[11px]">
              {{ (() => { try { const event = JSON.parse(row.event); return event.method ?? event.type ?? 'event'; } catch { return 'invalid event'; } })() }}
            </span>
            <span class="font-mono text-[9px] text-dim">{{ new Date(row.created).toLocaleTimeString('zh-CN') }}</span>
          </summary>
          <div class="mt-2">
            <CodeBlock :code="prettyEvent(row.event)" max-height="16rem" />
          </div>
        </details>
      </div>

      <div v-else class="space-y-4">
        <section class="inspector-section">
          <p class="eyebrow">CURRENT MODEL</p>
          <dl class="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <dt class="text-[10px] text-dim">模型</dt>
              <dd class="mt-1 font-mono text-xs">{{ modelState?.currentModel?.model ?? '未知' }}</dd>
              <p class="mt-1 text-[10px] text-dim">{{ modelState?.currentModel?.source ?? '宿主尚未报告' }}</p>
            </div>
            <div>
              <dt class="text-[10px] text-dim">思考强度</dt>
              <dd class="mt-1 font-mono text-xs">{{ modelState?.currentReasoningEffort?.reasoningEffort ?? '未知' }}</dd>
              <p class="mt-1 text-[10px] text-dim">{{ modelState?.currentReasoningEffort?.source ?? '宿主尚未报告' }}</p>
            </div>
          </dl>
        </section>
        <section class="inspector-section">
          <p class="eyebrow">MODEL OBSERVATIONS</p>
          <div v-if="observations.length" class="mt-3 space-y-1">
            <details v-for="observation in observations" :key="observation.seq" class="event-row">
              <summary class="cursor-pointer">
                <span class="font-mono text-[10px] text-dim">#{{ observation.seq }}</span>
                {{ observation.phase }} · {{ observation.model ?? observation.models?.join(', ') ?? '模型未知' }}
              </summary>
              <CodeBlock :code="JSON.stringify(observation, null, 2)" max-height="12rem" />
            </details>
          </div>
          <div v-else class="empty-state compact">本会话还没有模型观测。</div>
        </section>
      </div>

      <Button
        v-if="hasNextPage"
        variant="outline"
        size="sm"
        class="mt-4 w-full"
        :disabled="fetchingNextPage"
        @click="emit('loadMore')"
      >
        <LoaderCircle v-if="fetchingNextPage" :size="13" class="animate-spin" />
        {{ fetchingNextPage ? '正在加载' : '加载更多事件' }}
      </Button>
    </div>
  </section>
</template>
