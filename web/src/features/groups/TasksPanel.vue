<script setup lang="ts">
import { computed } from 'vue';
import { CircleCheck, CircleOff, ClipboardList, ListTodo, Radio } from '@lucide/vue';
import PanelState from '@/components/panel/PanelState.vue';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import type { AgentTaskEntry, Member, PanelAgent } from '@/shared/api/raw-types';
import { identityColor } from '@/features/messages/identity';

const props = defineProps<{
  tasks: AgentTaskEntry[];
  members: Member[];
  panelAgent: PanelAgent | null;
}>();

const groups = computed(() =>
  props.tasks.map(entry => {
    const member = props.members.find(item => item.id === entry.owner_id);
    const name = member?.name
      ?? (props.panelAgent && entry.owner_id === props.panelAgent.id ? props.panelAgent.name : entry.owner_id);
    return {
      key: entry.owner_id,
      name,
      isController: entry.owner_kind === 'panel_agent',
      color: identityColor(name),
      tasks: entry.tasks,
      updated: new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(entry.updated)),
      doingCount: entry.tasks.filter(task => task.state === 'doing').length,
    };
  }),
);

const stateMeta = {
  doing: { icon: Radio, label: '进行中', class: 'task-doing' },
  done: { icon: CircleCheck, label: '已完成', class: 'task-done' },
  dropped: { icon: CircleOff, label: '已放弃', class: 'task-dropped' },
} as const;
</script>

<template>
  <PanelState
    v-if="!groups.length"
    :icon="ClipboardList"
    title="任务面板为空"
    description="成员与主控用 tasks_set 工具更新自己的任务后，会显示在这里。任务进度由各 Agent 自行维护，不阻塞流程。"
  />
  <div v-else class="flex flex-col gap-4">
    <Card v-for="group in groups" :key="group.key" class="py-0">
      <CardContent class="flex flex-col gap-3 py-4">
        <div class="flex min-w-0 items-center gap-2">
          <span class="speaking-dot" :style="{ backgroundColor: group.color }" />
          <span class="min-w-0 flex-1 truncate text-sm font-medium">{{ group.name }}</span>
          <Badge v-if="group.isController" variant="outline">主控</Badge>
          <Badge v-if="group.doingCount" variant="secondary">{{ group.doingCount }} 进行中</Badge>
          <span class="text-xs text-muted-foreground tabular-nums">{{ group.updated }}</span>
        </div>
        <ul class="flex flex-col gap-2">
          <li
            v-for="(task, index) in group.tasks"
            :key="index"
            class="flex items-start gap-2 text-sm"
            :class="stateMeta[task.state].class"
          >
            <component :is="stateMeta[task.state].icon" class="mt-0.5 size-4 shrink-0" />
            <span class="min-w-0 flex-1 break-words leading-6">{{ task.text }}</span>
            <span class="sr-only">{{ stateMeta[task.state].label }}</span>
          </li>
        </ul>
      </CardContent>
    </Card>
    <p class="flex items-center gap-1.5 text-xs text-muted-foreground">
      <ListTodo class="size-3.5" />
      任务由各 Agent 通过 tasks_set 整体更新，进度自控、不阻塞流程。
    </p>
  </div>
</template>

<style scoped>
.task-doing {
  color: hsl(var(--foreground));
}

.task-done {
  color: hsl(var(--muted-foreground));
}

.task-dropped {
  color: hsl(var(--muted-foreground));
  text-decoration: line-through;
  text-decoration-color: hsl(var(--muted-foreground) / 60%);
}
</style>
