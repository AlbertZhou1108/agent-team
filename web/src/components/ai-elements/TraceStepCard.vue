<script setup lang="ts">
import { Disclosure } from '@/components/ui/disclosure';
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
  if (props.step.status === 'running')
    return { text: '运行中', variant: 'default' as const, icon: LoaderCircle };
  if (props.step.status === 'success')
    return { text: '完成', variant: 'secondary' as const, icon: CheckCircle2 };
  if (props.step.status === 'error')
    return {
      text: '失败',
      variant: 'destructive' as const,
      icon: AlertTriangle,
    };
  return { text: '未知', variant: 'outline' as const, icon: Clock3 };
});

const hidden = computed(
  () => props.step.kind === 'reasoning' && !preferences.showReasoning,
);
</script>

<template>
  <Disclosure v-if="!hidden" class="trace-step group">
    <template #summary>
      <span class="flex shrink-0 items-center text-muted-foreground">
        <component :is="icon" class="size-4" />
      </span>
      <span class="min-w-0 flex-1">
        <span class="block truncate text-sm font-medium text-foreground">{{
          step.title
        }}</span>
      </span>
      <Badge v-if="step.status !== 'success'" :variant="badge.variant">
        <component
          :is="badge.icon"
          :class="{ 'animate-spin': step.status === 'running' }"
        />
        {{ badge.text }}
      </Badge>
      <CheckCircle2
        v-else
        class="size-4 shrink-0 text-muted-foreground"
        aria-label="已完成"
      />

    </template>
    <div
      v-if="step.summary || step.detail || step.raw.length"
      class="mt-2 flex flex-col gap-3 pb-2 pl-6"
    >
      <p
        v-if="step.summary"
        class="whitespace-pre-wrap break-words text-xs text-muted-foreground"
      >
        {{ step.summary }}
      </p>
      <CodeBlock
        v-if="step.detail"
        :code="step.detail"
        :language="
          step.kind === 'terminal'
            ? 'shell'
            : step.kind === 'reasoning'
              ? 'text'
              : 'json'
        "
        max-height="14rem"
      />
      <Disclosure
        v-if="
          (preferences.showRawPayloads || step.kind === 'unknown') &&
          step.raw.length
        "
        class="raw-step"
      >
        <template #summary>
          原始事件 · {{ step.sourceEvents.join(', #') }}
        </template>
        <CodeBlock
          :code="JSON.stringify(step.raw, null, 2)"
          max-height="16rem"
        />
      </Disclosure>
    </div>
  </Disclosure>
</template>
