<script setup lang="ts">
import { Item, ItemMedia, ItemContent, ItemTitle, ItemActions } from '@/components/ui/item';
withDefaults(defineProps<{ active?: boolean; title?: string; expanded?: boolean; current?: boolean; pressed?: boolean }>(), { expanded: undefined, pressed: undefined });
const emit = defineEmits<{ activate: [event: MouseEvent] }>();
</script>

<template>
  <div class="flex w-full min-w-0 items-center gap-1">
    <Item as="button" type="button" size="sm" :variant="active ? 'muted' : 'default'" class="min-w-0 flex-1 flex-nowrap" :title="title" :aria-expanded="expanded" :aria-current="current ? 'page' : undefined" :aria-pressed="pressed" @click="emit('activate', $event)">
      <ItemMedia v-if="$slots.icon"><slot name="icon" /></ItemMedia>
      <ItemContent class="min-w-0"><ItemTitle class="min-w-0 max-w-full"><span class="min-w-0 truncate"><slot /></span></ItemTitle></ItemContent>
      <ItemActions v-if="$slots.indicator"><slot name="indicator" /></ItemActions>
    </Item>
    <div v-if="$slots.actions" class="flex shrink-0 items-center"><slot name="actions" /></div>
  </div>
</template>
