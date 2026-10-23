<script setup lang="ts">
import SidebarEntry from './SidebarEntry.vue';
import type { Group } from '@/shared/api/raw-types';
import TeamMenu from './TeamMenu.vue';
defineProps<{
  group: Group;
  active: boolean;
  selected: boolean;
  collapsed: boolean;
}>();
const emit = defineEmits<{
  select: [event: MouseEvent];
  drag: [event: DragEvent];
  reorder: [event: DragEvent];
  over: [event: DragEvent];
  leave: [event: DragEvent];
  archive: [];
}>();
</script>
<template>
  <div
    class="team-row w-full"
    :class="{ 'team-row-selected': selected }"
    draggable="true"
    @dragstart="emit('drag', $event)"
    @dragover.prevent.stop="emit('over', $event)"
    @dragleave="emit('leave', $event)"
    @drop="emit('reorder', $event)"
  >
    <SidebarEntry :active="active || selected" :current="active" :title="`${group.name} · ${group.id}`" @activate="emit('select', $event)">
      {{ collapsed ? group.name.slice(0, 1) : group.name }}
      <template v-if="!collapsed" #actions><TeamMenu :id="group.id" :name="group.name" :archived="group.state === 'archived'" @archive="emit('archive')" /></template>
    </SidebarEntry>
  </div>
</template>
