<script setup lang="ts">
import { useId } from 'vue';
import { CircleHelp } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
defineProps<{ title: string }>();
const titleId = useId();
</script>

<template>
  <Popover>
    <PopoverTrigger as-child>
      <Button type="button" variant="ghost" size="icon-sm" :aria-label="title + '说明'">
        <CircleHelp />
      </Button>
    </PopoverTrigger>
    <PopoverContent align="start" :aria-labelledby="titleId" class="max-h-[min(24rem,var(--reka-popover-content-available-height))] overflow-y-auto">
      <div class="flex flex-col gap-3 text-sm leading-6">
        <h4 :id="titleId" class="font-medium">{{ title }}</h4>
        <slot />
      </div>
    </PopoverContent>
  </Popover>
</template>
