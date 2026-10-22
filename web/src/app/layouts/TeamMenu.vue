<script setup lang="ts">
import { computed } from 'vue';
import { Archive, Ellipsis } from '@lucide/vue';
import {
  DropdownMenu as DropdownMenuRoot,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { useTeamOrganization } from '@/stores/team-organization';
const props = defineProps<{
  id: string;
  folder?: boolean;
  name: string;
  archived?: boolean;
}>();
const emit = defineEmits<{ archive: [] }>();
const org = useTeamOrganization();
const selectedColor = computed(() => props.folder ? org.folders.find(item => item.id === props.id)?.color : org.teams[props.id]?.color);
const colors = [{ label: '红色', value: '#ef4444' }, { label: '橙色', value: '#f59e0b' }, { label: '绿色', value: '#22c55e' }, { label: '蓝色', value: '#3b82f6' }, { label: '紫色', value: '#a855f7' }];
</script>
<template>
  <DropdownMenuRoot>
    <DropdownMenuTrigger class="team-menu-trigger" :aria-label="`${name}的菜单`" @click.stop><Ellipsis :size="15" /></DropdownMenuTrigger>
      <DropdownMenuContent class="team-menu" :side-offset="4" align="start">
        <DropdownMenuGroup>
          <div class="team-color-palette" role="group" aria-label="标签色">
            <DropdownMenuItem v-for="color in colors" :key="color.value" class="team-color-choice"
              :aria-label="color.label" :title="color.label" :data-selected="selectedColor === color.value"
              :style="{ '--tag-color': color.value }"
              @select.prevent="org.color(id, selectedColor === color.value ? undefined : color.value, folder)">
              <span aria-hidden="true" />
            </DropdownMenuItem>
          </div>
          <DropdownMenuSeparator class="team-menu-separator" />
          <DropdownMenuItem v-if="!folder" class="team-menu-item" @select="org.togglePin(id)">{{ org.teams[id]?.pinned ? '取消置顶' : '置顶团队' }}</DropdownMenuItem>
          <DropdownMenuItem v-if="!folder && !archived" class="team-menu-item" @select="emit('archive')">
            <Archive data-icon="inline-start" />
            归档团队
          </DropdownMenuItem>
          <DropdownMenuItem v-if="folder" class="team-menu-item" @select="org.dissolve(id)">解散文件夹</DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
  </DropdownMenuRoot>
</template>
