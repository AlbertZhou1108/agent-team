<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "cn"

const props = defineProps<{
  class?: HTMLAttributes["class"]
  size?: 'default' | 'compact'
}>()
</script>

<template>
  <div
    data-slot="card"
    :data-size="size || 'default'"
    :class="
      cn(
        'bg-card text-card-foreground flex flex-col gap-(--card-gap) rounded-(--component-panel-radius) border py-(--card-padding) shadow-xs',
        props.class,
      )
    "
  >
    <slot />
  </div>
</template>
