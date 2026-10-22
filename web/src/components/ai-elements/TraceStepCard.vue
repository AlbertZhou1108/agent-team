<script setup lang="ts">
import { computed } from 'vue';
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  CircleDot,
  Clock3,
  Database,
  LoaderCircle,
  MessageSquareText,
  Terminal,
  ToolCase,
} from '@lucide/vue';
import type { TraceStep } from '@/shared/models/view-types';
import { Badge } from '@/components/ui/badge';
import { usePreferencesStore } from '@/stores/preferences';
import CodeBlock from './CodeBlock.vue';

const props = defineProps<{ step: TraceStep }>();
const preferences = usePreferencesStore();

const icons = {
  input: MessageSquareText,
  output: CheckCircle2,
  tool: ToolCase,
  reasoning: Brain,
  model: Database,
  checkpoint: CircleDot,
  terminal: Terminal,
  error: AlertTriangle,
  unknown: CircleDot,
};

const icon = computed(() => icons[props.step.kind]);
const badge = computed(() => {
  if (props.step.status === 'running') return { text: '运行中', variant: 'accent' as const, icon: LoaderCircle };
  if (props.step.status === 'success') return { text: '完成', variant: 'success' as const, icon: CheckCircle2 };
  if (props.step.status === 'error') return { text: '失败', variant: 'danger' as const, icon: AlertTriangle };
  return { text: '未知', variant: 'default' as const, icon: Clock3 };
});

const hidden = computed(() => props.step.kind === 'reasoning' && !preferences.showReasoning);
</script>

<template>
  <details v-if="!hidden" class="trace-step group">
    <summary>
      <span :class="['trace-icon', `trace-${step.kind}`]">
        <component :is="icon" :size="14" />
      </span>
      <span class="min-w-0 flex-1">
        <span class="block truncate text-xs font-medium text-[var(--foreground)]">{{ step.title }}</span>
      </span>
      <Badge :variant="badge.variant">
        <component :is="badge.icon" :size="10" :class="{ 'animate-spin': step.status === 'running' }" />
        {{ badge.text }}
      </Badge>
    </summary>
    <div v-if="step.summary || step.detail || step.raw.length" class="ml-9 mt-2 flex flex-col gap-2 pb-2">
      <p v-if="step.summary" class="whitespace-pre-wrap break-words text-xs text-muted-foreground">{{ step.summary }}</p>
      <CodeBlock
        v-if="step.detail"
        :code="step.detail"
        :language="step.kind === 'terminal' ? 'shell' : step.kind === 'reasoning' ? 'text' : 'json'"
        max-height="14rem"
      />
      <details v-if="(preferences.showRawPayloads || step.kind === 'unknown') && step.raw.length" class="raw-step">
        <summary class="cursor-pointer px-1 py-1 font-mono text-[10px] text-dim">
          原始事件 · {{ step.sourceEvents.join(', #') }}
        </summary>
        <CodeBlock :code="JSON.stringify(step.raw, null, 2)" max-height="16rem" />
      </details>
    </div>
  </details>
</template>
