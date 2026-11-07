<script setup lang="ts">
import { CircleCheck, CircleOff, Radio } from '@lucide/vue';
import type { TaskPanelPlan } from './task-panel-model';

defineProps<{ plan: TaskPanelPlan }>();

const stateMeta = {
  doing: { icon: Radio, label: '进行中', class: 'task-doing' },
  done: { icon: CircleCheck, label: '已完成', class: 'task-done' },
  dropped: { icon: CircleOff, label: '已放弃', class: 'task-dropped' },
} as const;
</script>

<template>
  <ol class="flex flex-col gap-2">
    <li
      v-for="step in plan.steps"
      :key="step.key"
      class="flex flex-col gap-1"
    >
      <div
        class="flex items-start gap-2 text-sm"
        :class="stateMeta[step.step.state].class"
      >
        <span class="mt-0.5 w-5 shrink-0 text-xs text-muted-foreground tabular-nums">{{ step.number }}.</span>
        <component :is="stateMeta[step.step.state].icon" class="mt-1 size-4 shrink-0" />
        <span class="min-w-0 flex-1 break-words leading-6">{{ step.step.text }}</span>
        <span class="sr-only">{{ stateMeta[step.step.state].label }}</span>
      </div>
      <ul
        v-if="step.children.length"
        class="ms-7 flex flex-col gap-1 border-s border-border ps-3"
      >
        <li
          v-for="child in step.children"
          :key="child.key"
          class="flex items-start gap-2 text-sm"
          :class="stateMeta[child.task.state].class"
        >
          <span class="mt-0.5 w-8 shrink-0 text-xs text-muted-foreground tabular-nums">{{ child.number }}</span>
          <span class="mt-1.5 size-2 shrink-0 rounded-full" :style="{ backgroundColor: child.color }" />
          <span class="max-w-24 shrink-0 truncate text-xs text-muted-foreground" :title="child.ownerName">{{ child.ownerName }}</span>
          <span class="min-w-0 flex-1 break-words leading-6">{{ child.task.text }}</span>
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
