<script setup lang="ts">
import { CircleCheck, CircleDot, CircleMinus } from '@lucide/vue';
import { Badge } from '@/components/ui/badge';
import type { TaskPanelPlan } from './task-panel-model';

defineProps<{ plan: TaskPanelPlan }>();

const stateMeta = {
  doing: { icon: CircleDot, label: '进行中', class: 'task-doing' },
  done: { icon: CircleCheck, label: '已完成', class: 'task-done' },
  dropped: { icon: CircleMinus, label: '已放弃', class: 'task-dropped' },
} as const;
</script>

<template>
  <ol class="flex flex-col gap-2">
    <li
      v-for="step in plan.steps"
      :key="step.key"
      class="flex flex-col gap-1.5"
    >
      <div
        class="flex items-start gap-2 text-sm leading-5"
        :class="stateMeta[step.step.state].class"
      >
        <component
          :is="stateMeta[step.step.state].icon"
          class="mt-0.5 size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span class="shrink-0 text-xs leading-5 text-muted-foreground tabular-nums">{{ step.number }}.</span>
        <span class="min-w-0 flex-1 break-words" :class="step.step.state === 'doing' ? 'font-medium' : 'font-normal'">{{ step.step.text }}</span>
        <span class="sr-only">{{ stateMeta[step.step.state].label }}</span>
      </div>
      <ul
        v-if="step.children.length"
        class="ms-2 flex flex-col gap-1.5 border-s border-border ps-3"
      >
        <li
          v-for="child in step.children"
          :key="child.key"
          class="flex items-start gap-2 text-xs leading-5"
          :class="stateMeta[child.task.state].class"
        >
          <component
            :is="stateMeta[child.task.state].icon"
            class="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <span class="shrink-0 text-xs leading-5 text-muted-foreground tabular-nums">{{ child.number }}</span>
          <span class="min-w-0 flex-1 break-words">{{ child.task.text }}</span>
          <Badge
            variant="secondary"
            class="max-w-24 shrink-0 truncate"
            :title="child.ownerName"
          >
            {{ child.ownerName }}
          </Badge>
          <span class="sr-only">{{ stateMeta[child.task.state].label }}</span>
        </li>
      </ul>
    </li>
  </ol>
</template>

<style scoped>
.task-doing {
  color: var(--foreground);
}

.task-done {
  color: var(--muted-foreground);
}

.task-dropped {
  color: var(--muted-foreground);
  text-decoration: line-through;
  text-decoration-color: color-mix(in oklch, var(--muted-foreground) 60%, transparent);
}
</style>
