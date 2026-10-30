<script setup lang="ts">
import { computed } from 'vue';
import { ChevronsLeft, ChevronsRight } from '@lucide/vue';
import { Button } from '@/components/ui/button';
const props = defineProps<{ collapsed: boolean; side: 'left' | 'right' }>();
const emit = defineEmits<{ toggle: [] }>();
const label = computed(() => (props.collapsed ? '展开' : '收起') + (props.side === 'left' ? '侧栏' : '右侧栏'));
const pointsLeft = computed(() => props.side === 'left' ? !props.collapsed : props.collapsed);
</script>
<template>
  <Button variant="ghost" size="sm" class="sidebar-collapse-button w-full justify-start" :title="label" :aria-label="label" :aria-expanded="!collapsed" @click="emit('toggle')">
    <ChevronsLeft v-if="pointsLeft" /><ChevronsRight v-else />
    <span v-if="!collapsed">收起</span>
  </Button>
</template>
