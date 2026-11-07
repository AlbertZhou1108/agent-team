<script setup lang="ts">
import { computed } from 'vue';
import { CircleCheck, CircleOff, ClipboardList, Radio } from '@lucide/vue';
import PanelState from '@/components/panel/PanelState.vue';
import { Badge } from '@/components/ui/badge';
import { Disclosure } from '@/components/ui/disclosure';
import TaskPlanSteps from './TaskPlanSteps.vue';
import { buildTaskPanelModel } from './task-panel-model';
import type { AgentTasksView, Member, PanelAgent } from '@/shared/api/raw-types';

const props = defineProps<{
  view: AgentTasksView;
  members: Member[];
  panelAgent: PanelAgent | null;
}>();

const model = computed(() => buildTaskPanelModel({
  view: props.view,
  members: props.members,
  panelAgent: props.panelAgent,
}));

const stateMeta = {
  doing: { icon: Radio, label: '进行中', class: 'task-doing' },
  done: { icon: CircleCheck, label: '已完成', class: 'task-done' },
  dropped: { icon: CircleOff, label: '已放弃', class: 'task-dropped' },
} as const;
</script>

<template>
  <PanelState
    v-if="model.empty"
    :icon="ClipboardList"
    title="任务面板为空"
  />
  <div v-else class="flex flex-col gap-6">
    <!-- 当前计划:主控本任期写下的步骤;成员任务按 parent 挂到步骤下。 -->
    <section class="flex flex-col gap-2" data-testid="current-plan">
      <header class="flex min-w-0 flex-wrap items-center gap-2">
        <h3 class="text-xs font-semibold tracking-wide text-muted-foreground">当前计划</h3>
        <Badge v-if="model.current" variant="secondary">主控：{{ model.current.ownerName }}</Badge>
        <span v-if="model.current?.timeLabel" class="ms-auto text-xs text-muted-foreground tabular-nums">{{ model.current.timeLabel }}</span>
      </header>
      <TaskPlanSteps v-if="model.current?.steps.length" :plan="model.current" />
      <p v-else class="text-xs text-muted-foreground">
        {{ model.current ? '当前计划为空。' : (model.historical.length ? '当前任期尚未建立计划，上一任期计划已归档。' : '当前任期尚未建立计划。') }}
      </p>
      <div v-if="model.cancelled.length" class="flex flex-col gap-1 rounded-md border border-border/60 p-2">
        <p class="text-xs font-medium text-muted-foreground">已取消的步骤</p>
        <p v-for="item in model.cancelled" :key="item.key" class="text-xs leading-5">
          「{{ item.text }}」<span v-if="item.affectedNames.length" class="text-muted-foreground"> · 影响：{{ item.affectedNames.join('、') }}</span>
        </p>
      </div>
    </section>

    <!-- 历史计划:只出现仍有子任务挂靠的冻结快照;默认折叠。 -->
    <Disclosure v-if="model.historical.length" class="min-w-0">
      <template #summary>
        <h3 class="text-xs font-semibold tracking-wide text-muted-foreground">历史计划</h3>
        <Badge variant="outline">{{ model.historical.length }}</Badge>
      </template>
      <div class="mt-3 flex flex-col gap-4">
        <section
          v-for="plan in model.historical"
          :key="plan.planId"
          class="flex min-w-0 flex-col gap-2"
          :data-testid="`historical-plan-${plan.planId}`"
        >
          <header class="flex min-w-0 flex-wrap items-center gap-2">
            <span class="size-2 shrink-0 rounded-full" :style="{ backgroundColor: plan.color }" />
            <span class="text-xs text-muted-foreground">前任主控：{{ plan.ownerName }}</span>
            <span class="ms-auto text-xs text-muted-foreground tabular-nums">{{ plan.timeLabel }}</span>
          </header>
          <TaskPlanSteps :plan="plan" />
        </section>
      </div>
    </Disclosure>

    <!-- 未挂靠任务:没有 parent,或父步骤已不存在。 -->
    <section v-if="model.members.length" class="flex flex-col gap-3" data-testid="member-tasks">
      <h3 class="text-xs font-semibold tracking-wide text-muted-foreground">成员任务</h3>
      <section
        v-for="group in model.members"
        :key="group.ownerId"
        class="flex min-w-0 flex-col gap-2"
      >
        <header class="flex min-w-0 items-center gap-2">
          <span class="size-2 shrink-0 rounded-full" :style="{ backgroundColor: group.color }" />
          <span class="min-w-0 flex-1 truncate text-sm font-medium">{{ group.name }}</span>
        </header>
        <ul class="flex flex-col gap-2">
          <li
            v-for="item in group.tasks"
            :key="item.key"
            class="flex items-start gap-2 text-sm"
            :class="stateMeta[item.task.state].class"
          >
            <component :is="stateMeta[item.task.state].icon" class="mt-1 size-4 shrink-0" />
            <span class="min-w-0 flex-1 break-words leading-6">{{ item.task.text }}</span>
            <Badge v-if="item.orphan" variant="outline" title="所属步骤已移除">未挂靠</Badge>
            <span class="sr-only">{{ stateMeta[item.task.state].label }}</span>
          </li>
        </ul>
      </section>
    </section>
  </div>
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
