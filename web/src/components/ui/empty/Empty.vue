<script setup lang="ts">
import { computed, provide, type HTMLAttributes } from "vue"
import type { ContainerSize } from "@/components/ui/size"
import { cn } from "cn"
import { EMPTY_SIZE_KEY } from "."

const props = withDefaults(defineProps<{
  size?: ContainerSize
  class?: HTMLAttributes["class"]
}>(), {
  size: "md",
})

provide(EMPTY_SIZE_KEY, computed(() => props.size))

const sizeClass: Record<ContainerSize, string> = {
  sm: "gap-3 p-4",
  md: "gap-4 p-6",
  lg: "gap-6 p-10",
}
</script>

<template>
  <div
    data-slot="empty"
    :data-size="size"
    :class="cn(
      'flex min-w-0 flex-1 flex-col items-center justify-center text-balance rounded-(--component-card-radius) border-dashed text-center',
      sizeClass[size],
      props.class,
    )"
  >
    <slot />
  </div>
</template>
