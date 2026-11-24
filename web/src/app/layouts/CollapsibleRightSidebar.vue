<script setup lang="ts" generic="T extends string">
import type { Component } from 'vue';
import { Button } from '@/components/ui/button';
import { Surface } from '@/components/surface';
import SidebarCollapseButton from './SidebarCollapseButton.vue';

withDefaults(defineProps<{
  collapsed: boolean;
  collapsedActions?: { value: T; label: string; icon: Component }[];
  activeAction?: T;
  desktopOnlyToggle?: boolean;
}>(), { collapsedActions: () => [], desktopOnlyToggle: false });
const emit = defineEmits<{
  'update:collapsed': [value: boolean];
  action: [value: T];
}>();
</script>

<template>
  <!-- 本组件职能上就是上下文面板载体:全贴边贴右缘（L0b），左侧 1px 发丝线分隔。 -->
  <Surface
    role="context-panel"
    as="aside"
    class="flex min-h-0 min-w-0 flex-col gap-4 overflow-hidden border-l border-border py-4 text-card-foreground"
  >
    <div v-show="!collapsed" class="flex min-h-0 flex-1 flex-col">
      <slot />
    </div>
    <div v-if="collapsed && collapsedActions.length" class="flex flex-col items-center gap-2 px-2">
      <Button
        v-for="action in collapsedActions"
        :key="action.value"
        :variant="activeAction === action.value ? 'secondary' : 'ghost'"
        size="icon-md"
        :aria-label="action.label"
        :title="action.label"
        @click="emit('action', action.value)"
      ><component :is="action.icon" /></Button>
    </div>
    <div :class="['mt-auto w-full shrink-0', collapsed ? 'px-2' : 'px-4', desktopOnlyToggle && 'hidden xl:block']">
      <SidebarCollapseButton
        side="right"
        :collapsed="collapsed"
        :class="collapsed && 'justify-center px-0'"
        @toggle="emit('update:collapsed', !collapsed)"
      />
    </div>
  </Surface>
</template>
