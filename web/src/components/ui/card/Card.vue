<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import type { ContainerSize } from "@/components/ui/size"
import { cn } from "cn"

const props = withDefaults(defineProps<{
  class?: HTMLAttributes["class"]
  size?: ContainerSize
}>(), {
  size: "lg",
})
</script>

<template>
  <div
    data-slot="card"
    data-component="content-surface"
    :data-size="size"
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
