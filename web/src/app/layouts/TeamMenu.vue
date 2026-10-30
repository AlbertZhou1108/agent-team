<script setup lang="ts">
import { computed } from 'vue';
import { Button } from '@/components/ui/button';
import { Archive, Ellipsis, PenLine, Pin, FolderMinus } from '@lucide/vue';
import {
  DropdownMenu as DropdownMenuRoot,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { useTeamOrganization } from '@/stores/team-organization';
const props = defineProps<{
  id: string;
  folder?: boolean;
  name: string;
  archived?: boolean;
  allIds?: string[];
}>();
const emit = defineEmits<{ archive: []; rename: [] }>();
const org = useTeamOrganization();
const selectedColor = computed(() =>
  props.folder
    ? org.folders.find((item) => item.id === props.id)?.color
    : org.teams[props.id]?.color,
);
const peers = computed(() => {
  const meta = org.teams[props.id];
  return [...new Set([...org.order, ...(props.allIds ?? [])])].filter(id => (props.allIds ?? []).includes(id) && org.teams[id]?.folder === meta?.folder && Boolean(org.teams[id]?.pinned) === Boolean(meta?.pinned));
});
function neighbor(direction: number) {
  const ids = props.folder ? org.folders.map(item => item.id) : peers.value;
  return ids[ids.indexOf(props.id) + direction];
}
function shift(direction: number) {
  const target = neighbor(direction);
  if (!target) return;
  if (props.folder) org.reorderFolder(props.id, target, direction > 0);
  else org.reorderTeams([props.id], target, direction > 0, props.allIds ?? []);
}
const colors = [
  { label: '红色', value: '#ef4444' },
  { label: '橙色', value: '#f59e0b' },
  { label: '绿色', value: '#22c55e' },
  { label: '蓝色', value: '#3b82f6' },
  { label: '紫色', value: '#a855f7' },
];
</script>
<template>
  <DropdownMenuRoot>
    <DropdownMenuTrigger as-child
      ><Button
        variant="ghost"
        size="icon-sm"
        class="team-menu-trigger"
        :aria-label="`${name}的菜单`"
        @click.stop
        ><Ellipsis /></Button
    ></DropdownMenuTrigger>
    <DropdownMenuContent class="team-menu" :side-offset="4" align="end">
      <DropdownMenuGroup v-if="!folder" class="flex items-center justify-between gap-2 px-2 py-2" aria-label="颜色标签">
        <DropdownMenuCheckboxItem
          v-for="color in colors"
          :key="color.value"
          :model-value="selectedColor === color.value"
          :aria-label="`${color.label}标签`"
          :title="`${color.label}标签`"
          class="size-6 rounded-full border-2 p-0 focus-visible:ring-2 focus-visible:ring-ring"
          :style="{
            backgroundColor: color.value,
            borderColor: selectedColor === color.value ? `color-mix(in srgb, ${color.value}, black 45%)` : 'transparent',
          }"
          @select.prevent="org.color(id, selectedColor === color.value ? undefined : color.value, folder)"
        ><template #indicator-icon><span /></template></DropdownMenuCheckboxItem>
      </DropdownMenuGroup>
      <DropdownMenuGroup>
        <DropdownMenuItem :disabled="!neighbor(-1)" @select="shift(-1)">向前移动</DropdownMenuItem>
        <DropdownMenuItem :disabled="!neighbor(1)" @select="shift(1)">向后移动</DropdownMenuItem>
        <template v-if="!folder">
          <DropdownMenuItem v-for="target in org.folders" :key="target.id" :disabled="org.teams[id]?.folder === target.id" @select="org.move([id], target.id)">移至 {{ target.name }}</DropdownMenuItem>
          <DropdownMenuItem v-if="org.teams[id]?.folder" @select="org.move([id])">移出文件夹</DropdownMenuItem>
        </template>
        <DropdownMenuSeparator v-if="!folder" class="team-menu-separator" />
        <DropdownMenuItem
          v-if="!folder"
          class="team-menu-item"
          @select="org.togglePin(id)"
          ><Pin />{{
            org.teams[id]?.pinned ? '取消置顶' : '置顶团队'
          }}</DropdownMenuItem
        >
        <DropdownMenuItem
          v-if="!folder && !archived"
          class="team-menu-item"
          @select="emit('archive')"
        >
          <Archive data-icon="inline-start" />
          归档团队
        </DropdownMenuItem>
        <DropdownMenuItem
          v-if="folder"
          class="team-menu-item"
          @select="emit('rename')"
          ><PenLine />重命名文件夹</DropdownMenuItem
        >
        <DropdownMenuItem
          v-if="folder"
          class="team-menu-item"
          @select="org.dissolve(id)"
          ><FolderMinus />解散文件夹</DropdownMenuItem
        >
      </DropdownMenuGroup>
    </DropdownMenuContent>
  </DropdownMenuRoot>
</template>
