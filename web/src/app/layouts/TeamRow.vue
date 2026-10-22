<script setup lang="ts">
import type { Group } from '@/shared/api/raw-types';
import { useTeamOrganization } from '@/stores/team-organization';
import TeamMenu from './TeamMenu.vue';
defineProps<{ group: Group; active: boolean; selected: boolean; collapsed: boolean }>();
const emit = defineEmits<{
  select: [event: MouseEvent];
  drag: [event: DragEvent];
  reorder: [event: DragEvent];
  over: [event: DragEvent];
  leave: [event: DragEvent];
  archive: [];
}>();
const org = useTeamOrganization();
</script>
<template>
  <div class="team-row" :class="{ 'team-row-selected': selected }" draggable="true" @dragstart="emit('drag', $event)" @dragover.prevent.stop="emit('over', $event)" @dragleave="emit('leave', $event)" @drop="emit('reorder', $event)">
    <button
      type="button"
      draggable="true"
      :title="active ? '取消选中团队' : group.name"
      :class="['group-nav-item', active && 'group-nav-item-active']"
      :aria-current="active ? 'page' : undefined"
      :aria-pressed="active"
      @click="emit('select', $event)"
    >
      <span class="team-avatar grid size-7 shrink-0 place-items-center rounded-lg border border-border bg-muted font-mono text-[10px]"
        :class="{ 'team-avatar-tagged': org.teams[group.id]?.color }"
        :style="org.teams[group.id]?.color ? { '--tag-color': org.teams[group.id]?.color } : undefined">{{ group.name.slice(0, 1) }}</span>
      <span v-if="!collapsed" class="min-w-0 flex-1">
        <span class="block truncate text-left text-xs font-medium">{{ group.name }}</span>
        <span class="mt-0.5 block truncate text-left font-mono text-[9px] text-dim">{{ group.id }}</span>
      </span>
    </button>
    <TeamMenu
      v-if="!collapsed"
      :id="group.id"
      :name="group.name"
      :archived="group.state === 'archived'"
      @archive="emit('archive')"
    />
  </div>
</template>
