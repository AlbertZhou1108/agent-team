<script setup lang="ts">
import { Badge } from '@/components/ui/badge';
import { Disclosure } from '@/components/ui/disclosure';
withDefaults(defineProps<{
  title: string;
  count: number;
  description?: string;
  countLabel?: string;
  visibleItems?: number;
}>(), { description: '', countLabel: '条', visibleItems: 5 });
</script>

<template>
  <Disclosure default-open variant="card">
    <template #summary>
      <span class="flex min-w-0 flex-1 flex-col gap-1">
        <span class="truncate">{{ title }}</span>
        <span v-if="description" class="whitespace-normal text-xs font-normal text-muted-foreground">{{ description }}</span>
      </span>
      <Badge variant="outline">{{ count }} {{ countLabel }}</Badge>
      <slot name="status" />
    </template>
    <div
      class="record-panel-scroll min-w-0 overflow-y-auto overscroll-contain focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      :style="{ maxHeight: `min(${visibleItems * 2.75}rem, 50vh)` }"
      role="region" :aria-label="`${title}内容`" tabindex="0"
    ><slot /></div>
    <slot name="footer" />
  </Disclosure>
</template>
