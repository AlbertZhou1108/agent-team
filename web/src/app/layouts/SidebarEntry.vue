<script setup lang="ts">
import { ChevronRight } from '@lucide/vue';
import { Item, ItemMedia, ItemContent, ItemTitle, ItemActions } from '@/components/ui/item';
withDefaults(defineProps<{ color?: string; active?: boolean; title?: string; label?: string; collapsed?: boolean; expanded?: boolean; current?: boolean; pressed?: boolean; selected?: boolean; controls?: string }>(), { expanded: undefined, pressed: undefined });
const emit = defineEmits<{ activate: [event: MouseEvent] }>();
</script>

<template>
  <div class="flex w-full min-w-0 items-center gap-1">
    <Item as="button" type="button" size="sm" variant="default" data-component="navigation-item" :data-current="!!current" :data-selected="!!selected" :data-collapsed="!!collapsed" :data-contains-current="!!active && !current" class="min-w-0 flex-1 flex-nowrap" :title="title" :aria-label="label || (collapsed ? title : undefined)" :aria-expanded="expanded" :aria-controls="controls" :aria-current="current ? 'page' : undefined" :aria-pressed="pressed" @click="emit('activate', $event)">
      <ItemMedia v-if="$slots.icon"><slot name="icon" /></ItemMedia>
      <ItemContent v-if="!collapsed" class="min-w-0"><ItemTitle class="min-w-0 max-w-full"><span v-if="color" class="size-2 shrink-0 rounded-full" :style="{ backgroundColor: color }" aria-hidden="true" /><span class="min-w-0 truncate"><slot /></span></ItemTitle></ItemContent>
      <ItemActions v-if="$slots.indicator || expanded !== undefined"><slot name="indicator"><ChevronRight data-part="disclosure-indicator" aria-hidden="true" /></slot></ItemActions>
    </Item>
    <div v-if="$slots.actions" class="flex shrink-0 items-center"><slot name="actions" /></div>
  </div>
</template>
