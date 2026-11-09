<script setup lang="ts">
import { ref, watch } from 'vue';
import { Archive } from '@lucide/vue';
import { useQueryClient } from '@tanstack/vue-query';
import { toast } from 'vue-sonner';
import { api } from '@/shared/api/client';
import { invalidateWorkspaceResources } from '@/features/query-keys';
import type { Group } from '@/shared/api/raw-types';
import ArchiveSnapshotView from '../ArchiveSnapshotView.vue';
import { Disclosure } from '@/components/ui/disclosure';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import ConfirmDialog from '@/components/panel/ConfirmDialog.vue';

const props = defineProps<{ archivedTeams: Group[] }>();
const emit = defineEmits<{ restoreTeam: [team: Group] }>();

const archivedOpen = ref(true);
const snapshotTeam = ref<Group | null>(null);
const deletingTeam = ref<Group | null>(null);
const deletingTeamBusy = ref(false);
const deletingTeamError = ref('');
const queryClient = useQueryClient();
function requestDeleteTeam(team: Group) {
  deletingTeamError.value = '';
  deletingTeam.value = team;
}
function cancelDeleteTeam() {
  if (!deletingTeamBusy.value) deletingTeam.value = null;
}
async function confirmDeleteTeam() {
  const team = deletingTeam.value;
  if (!team || deletingTeamBusy.value) return;
  deletingTeamBusy.value = true;
  deletingTeamError.value = '';
  try {
    const result = await api.deleteTeam(team.id);
    deletingTeam.value = null;
    queryClient.removeQueries({ queryKey: ['archive-snapshot', team.id] });
    await invalidateWorkspaceResources(queryClient);
    if (result.cleanupWarnings?.length) toast.warning('团队已删除，部分会话缓存未能清理');
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : '删除团队失败';
    try { deletingTeamError.value = JSON.parse(message).error || message; }
    catch { deletingTeamError.value = message; }
  } finally {
    deletingTeamBusy.value = false;
  }
}
watch(() => props.archivedTeams, teams => {
  if (snapshotTeam.value && !teams?.some(team => team.id === snapshotTeam.value?.id)) snapshotTeam.value = null;
});

</script>

<template>

          <ArchiveSnapshotView v-if="snapshotTeam" :key="snapshotTeam.id" :team="snapshotTeam" @back="snapshotTeam = null" />
          <section v-else class="flex flex-col gap-3 pt-6">
            <Disclosure :heading-level="3" :open="!archivedTeams?.length || archivedOpen" :disabled="!archivedTeams?.length" @update:open="archivedOpen = $event">
<template #summary><span>归档团队</span><Badge>{{ archivedTeams?.length ?? 0 }}</Badge></template>
<template #description>归档团队不再接收消息；恢复后可继续沟通。</template>
            <Empty v-if="!archivedTeams?.length">
              <EmptyHeader><EmptyTitle>没有归档团队</EmptyTitle></EmptyHeader>
            </Empty>

            <div class="flex max-h-72 flex-col gap-2 overflow-y-auto overscroll-contain pr-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" role="region" aria-label="归档团队列表" tabindex="0">
              <div
                v-for="team in archivedTeams"
                :key="team.id"
                class="flex flex-wrap items-center gap-3 border p-3"
              >
                <span
                  class="grid size-8 shrink-0 place-items-center text-muted-foreground"
                >
                  <Archive />
                </span>
                <span class="min-w-0 flex-1">
                  <strong class="block truncate text-xs">{{
                    team.name
                  }}</strong>
                  <small
                    class="block truncate font-mono text-muted-foreground"
                    >{{ team.id }}</small
                  >
                </span>
                <Button variant="outline" size="sm" @click="snapshotTeam = team">查看快照</Button>
                <Button
                  variant="outline"
                  size="sm"
                  @click="emit('restoreTeam', team)"
                  >恢复</Button
                >
                <Button variant="destructive" size="sm" @click="requestDeleteTeam(team)">删除</Button>
              </div>
            </div>

</Disclosure>
          </section>
    <ConfirmDialog
      :open="deletingTeam !== null"
      :title="`永久删除「${deletingTeam?.name ?? ''}」？`"
      description="团队记录、消息和归档快照将被永久删除，删除后无法恢复。项目工作目录及文件、宿主历史和 Panel Agent 私人聊天会保留。"
      confirm-text="永久删除"
      destructive
      :busy="deletingTeamBusy"
      :error="deletingTeamError"
      @confirm="confirmDeleteTeam"
      @cancel="cancelDeleteTeam"
    />
</template>
