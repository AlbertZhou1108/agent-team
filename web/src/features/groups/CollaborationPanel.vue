<script setup lang="ts">
import { Disclosure } from '@/components/ui/disclosure';
import { computed, ref } from 'vue';
import { useQueryClient } from '@tanstack/vue-query';
import { toast } from 'vue-sonner';
import { Undo2 } from '@lucide/vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import PanelState from '@/components/panel/PanelState.vue';
import TasksPanel from './TasksPanel.vue';
import { api } from '@/shared/api/client';
import { useCharterQuery, useCollaborationQuery } from '@/features/queries';
import type { AgentTaskEntry, Member, PanelAgent } from '@/shared/api/raw-types';

const props = defineProps<{
  groupId: string;
  tasks?: AgentTaskEntry[];
  members?: Member[];
  panelAgent?: PanelAgent | null;
}>();
const queryClient = useQueryClient();
const summaryQuery = useCollaborationQuery(() => props.groupId || undefined);
const charterQuery = useCharterQuery(() => props.groupId || undefined);
const summary = computed(() => summaryQuery.data.value);
const charter = computed(() => charterQuery.data.value ?? null);
const doingCount = computed(() =>
  (props.tasks ?? []).reduce(
    (total, entry) => total + entry.tasks.filter(task => task.state === 'doing').length,
    0,
  ),
);
// 收起态也要给完成留痕:没有进行中时显示已完成计数,展开可见灰显明细。
const finishedCount = computed(() =>
  (props.tasks ?? []).reduce(
    (total, entry) => total + entry.tasks.filter(task => task.state !== 'doing').length,
    0,
  ),
);
const archived = computed(() =>
  summary.value ? !summary.value.communicationOpen : false,
);
const busy = ref(false);

async function refresh() {
  await Promise.all([
    // 控制权变化同时刷新导航、目录与当前团队资源。
    queryClient.invalidateQueries({ predicate: query => ['groups', 'directory', 'home-summary'].includes(String(query.queryKey[0])) }),
    queryClient.invalidateQueries({ queryKey: ['group', props.groupId] }),
    queryClient.invalidateQueries({ queryKey: ['collaboration', props.groupId] }),
    queryClient.invalidateQueries({ queryKey: ['charter', props.groupId] }),
  ]);
}

async function restoreTeam() {
  if (busy.value) return;
  busy.value = true;
  try {
    await api.restoreTeam(props.groupId);
    await refresh();
    toast.success('团队已恢复');
  } catch (error) {
    toast.error('恢复团队失败', { description: String(error) });
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div
    class="flex min-w-0 flex-col gap-6 p-1 text-sm leading-relaxed [overflow-wrap:anywhere]"
    data-testid="collaboration-panel"
  >
    <PanelState
      v-if="summaryQuery.isPending.value"
      loading
      title="正在读取团队概览"
    />
    <Alert v-else-if="summaryQuery.error.value" variant="destructive">
      <AlertDescription>
        读取失败：{{ summaryQuery.error.value.message }}
      </AlertDescription>
    </Alert>
    <template v-else-if="summary">
      <section class="flex flex-col gap-2">
        <h3 class="text-xs font-semibold tracking-wide text-muted-foreground">
          沟通状态
        </h3>
        <div class="flex flex-wrap items-center gap-2">
          <Badge :variant="archived ? 'outline' : 'secondary'">
            {{ archived ? '已归档' : '沟通开放' }}
          </Badge>
          <span class="text-xs text-muted-foreground">
            {{ summary.runningCount }} 个运行中回合
          </span>
        </div>
        <p v-if="archived" class="text-xs text-muted-foreground">
          团队已归档，不再接收消息；恢复后可继续沟通。
        </p>
        <div v-if="archived" class="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" :disabled="busy" @click="restoreTeam">
            <Undo2 data-icon="inline-start" />
            恢复团队
          </Button>
        </div>
      </section>

      <Disclosure class="overview-tasks group">
        <template #summary>

          <h3 class="text-xs font-semibold tracking-wide text-muted-foreground">
            任务面板
          </h3>
          <Badge v-if="doingCount" variant="secondary">{{ doingCount }} 进行中</Badge>
          <Badge v-else-if="finishedCount" variant="outline">{{ finishedCount }} 项已完成</Badge>
          <span v-else class="text-xs font-normal text-muted-foreground">
            {{ (props.tasks ?? []).length ? '暂无进行中任务' : '未使用' }}
          </span>
        </template>
        <div class="scrollbar-thin mt-3 max-h-[45vh] overflow-y-auto pr-1">
          <TasksPanel
            :tasks="props.tasks ?? []"
            :members="props.members ?? []"
            :panel-agent="props.panelAgent ?? null"
          />
        </div>
      </Disclosure>

      <section v-if="summary.unknown.length" class="flex flex-col gap-2">
        <h3 class="text-xs font-semibold tracking-wide text-muted-foreground">
          待核实运行 · {{ summary.unknown.length }}
        </h3>
        <p class="text-xs text-muted-foreground">
          以下宿主运行状态未知，请在 CLI 中核实宿主进程是否已停止。
        </p>
        <div class="divide-y divide-border">
          <div
            v-for="runtime in summary.unknown"
            :key="runtime.turn_id"
            class="flex flex-col gap-1 py-2 first:pt-0 last:pb-0"
          >
            <p class="break-all font-mono text-xs">{{ runtime.turn_id }}</p>
            <p class="text-xs text-muted-foreground">{{ runtime.detail }}</p>
          </div>
        </div>
      </section>

      <section class="flex flex-col gap-2">
        <h3 class="text-xs font-semibold tracking-wide text-muted-foreground">
          团队说明
        </h3>
        <p
          v-if="charterQuery.isPending.value"
          class="text-xs text-muted-foreground"
        >
          正在读取团队说明…
        </p>
        <p v-else-if="charter" class="whitespace-pre-wrap wrap-anywhere">{{ charter }}</p>
        <p v-else class="text-xs text-muted-foreground">暂无团队说明。</p>
      </section>
    </template>
  </div>
</template>
