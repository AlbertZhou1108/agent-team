<script setup lang="ts">
import { computed, ref } from 'vue';
import { useQueryClient } from '@tanstack/vue-query';
import { toast } from 'vue-sonner';
import { Archive, Undo2 } from '@lucide/vue';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import PanelState from '@/components/panel/PanelState.vue';
import ConfirmDialog from '@/components/panel/ConfirmDialog.vue';
import { api } from '@/shared/api/client';
import { useCharterQuery, useCollaborationQuery } from '@/features/queries';

const props = defineProps<{ groupId: string }>();
const queryClient = useQueryClient();
const summaryQuery = useCollaborationQuery(() => props.groupId || undefined);
const charterQuery = useCharterQuery(() => props.groupId || undefined);
const summary = computed(() => summaryQuery.data.value);
const charter = computed(() => charterQuery.data.value ?? null);
const archived = computed(() =>
  summary.value ? !summary.value.communicationOpen : false,
);
const busy = ref(false);
const archiveConfirm = ref(false);

async function refresh() {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['snapshot'] }),
    queryClient.invalidateQueries({ queryKey: ['collaboration', props.groupId] }),
    queryClient.invalidateQueries({ queryKey: ['charter', props.groupId] }),
  ]);
}

async function archiveTeam() {
  if (busy.value) return;
  archiveConfirm.value = false;
  busy.value = true;
  try {
    await api.archiveTeam(props.groupId);
    await refresh();
    toast.success('团队已归档', { description: '归档后团队不再接收消息。' });
  } catch (error) {
    toast.error('归档团队失败', { description: String(error) });
  } finally {
    busy.value = false;
  }
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
      description="正在同步沟通状态与团队说明。"
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
        <div class="flex flex-wrap gap-2">
          <Button
            v-if="!archived"
            variant="destructive"
            size="sm"
            :disabled="busy"
            @click="archiveConfirm = true"
          >
            <Archive data-icon="inline-start" />
            归档团队
          </Button>
          <Button
            v-else
            variant="outline"
            size="sm"
            :disabled="busy"
            @click="restoreTeam"
          >
            <Undo2 data-icon="inline-start" />
            恢复团队
          </Button>
        </div>
      </section>

      <section v-if="summary.unknown.length" class="flex flex-col gap-2">
        <h3 class="text-xs font-semibold tracking-wide text-muted-foreground">
          待核实运行 · {{ summary.unknown.length }}
        </h3>
        <p class="text-xs text-muted-foreground">
          以下宿主运行状态未知，请在 CLI 中核实宿主进程是否已停止。
        </p>
        <div
          v-for="runtime in summary.unknown"
          :key="runtime.turn_id"
          class="flex flex-col gap-1 border p-3"
        >
          <p class="break-all font-mono text-xs">{{ runtime.turn_id }}</p>
          <p class="text-xs text-muted-foreground">{{ runtime.detail }}</p>
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
        <p v-else-if="charter" class="whitespace-pre-wrap">{{ charter }}</p>
        <p v-else class="text-xs text-muted-foreground">暂无团队说明。</p>
      </section>
    </template>

    <ConfirmDialog
      :open="archiveConfirm"
      title="归档这个团队？"
      description="归档后团队不再接收消息或启动任务。"
      confirm-text="归档"
      destructive
      @confirm="archiveTeam"
      @cancel="archiveConfirm = false"
    />
  </div>
</template>
