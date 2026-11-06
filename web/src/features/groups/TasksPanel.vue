<script setup lang="ts">
import { computed } from 'vue';
import { CircleCheck, CircleOff, ClipboardList, Radio } from '@lucide/vue';
import PanelState from '@/components/panel/PanelState.vue';
import { Badge } from '@/components/ui/badge';
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
  />
  <div v-else class="flex flex-col divide-y divide-border">
    <!-- 面板本身已是唯一一层;每位成员的任务组分段展示,靠分割线与标题区分。 -->
    <section
      v-for="group in groups"
      :key="group.key"
      class="flex min-w-0 flex-col gap-2 py-4 first:pt-0 last:pb-0"
    >
      <header class="flex min-w-0 items-center gap-2">
        <span class="speaking-dot" :style="{ backgroundColor: group.color }" />
        <span class="min-w-0 flex-1 truncate text-sm font-medium">{{ group.name }}</span>
        <Badge v-if="group.isController" variant="outline">主控</Badge>
        <Badge v-if="group.doingCount" variant="secondary">{{ group.doingCount }} 进行中</Badge>
        <span class="shrink-0 text-xs text-muted-foreground tabular-nums">{{ group.updated }}</span>
      </header>
      <ul class="flex flex-col gap-2">
        <li
          v-for="(task, index) in group.tasks"
          :key="index"
          class="flex items-start gap-2 text-sm"
          :class="stateMeta[task.state].class"
        >
          <!-- 16px 图标在 24px 行高里居中需要 4px 上偏移。 -->
          <component :is="stateMeta[task.state].icon" class="mt-1 size-4 shrink-0" />
          <span class="min-w-0 flex-1 break-words leading-6">{{ task.text }}</span>
          <span class="sr-only">{{ stateMeta[task.state].label }}</span>
        </li>
      </ul>
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
