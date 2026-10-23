<script setup lang="ts">
import { ref } from 'vue';
import { ChevronDown } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Item } from '@/components/ui/item';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
withDefaults(defineProps<{
  title: string;
  count: number;
  description?: string;
  countLabel?: string;
  visibleItems?: number;
}>(), { description: '', countLabel: '条', visibleItems: 5 });
const open = ref(true);
</script>

<template>
  <Collapsible v-model:open="open" class="min-w-0">
    <Item variant="outline" class="block overflow-hidden p-0">
      <CollapsibleTrigger as-child>
        <Button variant="ghost" class="h-auto w-full min-w-0 justify-between gap-3 p-3 text-left" :aria-label="`${open ? '收起' : '展开'}${title}`">
          <span class="flex min-w-0 flex-1 flex-col gap-1">
            <span class="truncate">{{ title }}</span>
            <span v-if="description" class="text-xs font-normal text-muted-foreground whitespace-normal">{{ description }}</span>
          </span>
          <span class="flex shrink-0 items-center gap-2">
            <Badge variant="outline">{{ count }} {{ countLabel }}</Badge>
            <slot name="status" />
            <ChevronDown :class="{ 'rotate-180': open }" />
          </span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent force-mount v-show="open">
        <div
          class="record-panel-scroll mx-3 mb-3 min-w-0 overflow-y-auto overscroll-contain rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          :style="{ maxHeight: `min(${visibleItems * 2.75}rem, 50vh)` }"
          role="region"
          :aria-label="`${title}内容`"
          tabindex="0"
        ><slot /></div>
        <div v-if="$slots.footer" class="px-3 pb-3"><slot name="footer" /></div>
      </CollapsibleContent>
    </Item>
  </Collapsible>
</template>
