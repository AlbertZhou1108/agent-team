<script setup lang="ts">
import { computed } from 'vue';
import { CircleCheck, CircleDot, CircleMinus, ClipboardList } from '@lucide/vue';
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
  actors?: Array<{ id: string; name: string }>;
}>();

const model = computed(() => buildTaskPanelModel({
  view: props.view,
  members: props.members,
  panelAgent: props.panelAgent,
  actors: props.actors,
}));

const stateMeta = {
  doing: { icon: CircleDot, label: '进行中', class: 'task-doing' },
  done: { icon: CircleCheck, label: '已完成', class: 'task-done' },
  dropped: { icon: CircleMinus, label: '已放弃', class: 'task-dropped' },
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
        <h3 class="text-xs font-medium tracking-wide text-muted-foreground">当前计划</h3>
        <span v-if="model.current?.timeLabel" class="ms-auto text-xs text-muted-foreground tabular-nums">{{ model.current.timeLabel }}</span>
      </header>
      <TaskPlanSteps v-if="model.current?.steps.length" :plan="model.current" />
      <p v-else class="text-xs text-muted-foreground">
        {{ model.current ? '当前计划为空。' : (model.historical.length ? '当前任期尚未建立计划，上一任期计划已归档。' : '当前任期尚未建立计划。') }}
      </p>
      <ul v-if="model.cancelled.length" class="flex flex-col gap-1" data-testid="cancelled-steps">
        <li
          v-for="item in model.cancelled"
          :key="item.key"
          class="flex items-start gap-2 text-xs leading-5 text-muted-foreground line-through"
        >
          <CircleMinus class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span class="min-w-0 flex-1 break-words">{{ item.text }}</span>
        </li>
      </ul>
    </section>

    <!-- 历史计划:徽标样式与位置与任务面板保持统一（右侧 secondary 徽标）。 -->
    <Disclosure v-if="model.historical.length" class="min-w-0">
      <template #summary>
        <h3 class="text-xs font-medium tracking-wide text-muted-foreground">历史计划</h3>
        <Badge variant="secondary" class="ms-auto">{{ model.historical.length }}</Badge>
      </template>
      <div class="mt-3 flex flex-col gap-4">
        <section
          v-for="plan in model.historical"
          :key="plan.planId"
          class="flex min-w-0 flex-col gap-2"
          :data-testid="`historical-plan-${plan.planId}`"
        >
          <header class="flex min-w-0 flex-wrap items-center gap-2">
            <span class="text-xs text-muted-foreground">前任主控</span>
            <Badge variant="secondary" class="max-w-32 shrink-0 truncate" :title="plan.ownerName">
              {{ plan.ownerName }}
            </Badge>
            <span class="ms-auto text-xs text-muted-foreground tabular-nums">{{ plan.timeLabel }}</span>
          </header>
          <TaskPlanSteps :plan="plan" />
        </section>
      </div>
    </Disclosure>

    <!-- 未挂靠任务:统一色系成员标签作为分组头，任务列表缩进并带左侧竖线。 -->
    <section v-if="model.members.length" class="flex flex-col gap-3" data-testid="member-tasks">
      <h3 class="text-xs font-medium tracking-wide text-muted-foreground">成员任务</h3>
      <section
        v-for="group in model.members"
        :key="group.ownerId"
        class="flex min-w-0 flex-col gap-2"
      >
        <header class="flex min-w-0 items-center gap-2">
          <Badge variant="secondary" class="max-w-40 shrink-0 truncate" :title="group.name">
            {{ group.name }}
          </Badge>
        </header>
        <ul class="ms-2 flex flex-col gap-1.5 border-s border-border ps-3">
          <li
            v-for="item in group.tasks"
            :key="item.key"
            class="flex items-start gap-2 text-xs leading-5"
            :class="stateMeta[item.task.state].class"
          >
            <component
              :is="stateMeta[item.task.state].icon"
              class="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <span class="min-w-0 flex-1 break-words">{{ item.task.text }}</span>
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
