<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue';
import { useTeamOrganization } from '@/stores/team-organization';
import SidebarEntry from './SidebarEntry.vue';
import type { Group } from '@/shared/api/raw-types';
import TeamMenu from './TeamMenu.vue';
const props = defineProps<{
  group: Group;
  active: boolean;
  selected: boolean;
  collapsed: boolean;
  /** 由侧栏注册 PDD 拖拽与投放；本组件不 import PDD。 */
  attach: (element: HTMLElement | null) => void;
}>();
const org = useTeamOrganization();
const emit = defineEmits<{
  select: [event: MouseEvent];
  archive: [];
}>();

function setElement(element: Element | ComponentPublicInstance | null) {
  props.attach(element instanceof HTMLElement ? element : null);
}
</script>
<template>
  <div class="team-row w-full" :class="{ 'team-row-selected': selected }" :ref="setElement">
    <SidebarEntry :color="org.teams[group.id]?.color" :active="active" :current="active" :selected="selected" :pressed="selected" :title="`${group.name} · ${group.id}`" @activate="emit('select', $event)">
      {{ collapsed ? group.name.slice(0, 1) : group.name }}
      <template v-if="!collapsed" #actions><TeamMenu :id="group.id" :name="group.name" :archived="group.state === 'archived'" @archive="emit('archive')" /></template>
    </SidebarEntry>
  </div>
</template>
