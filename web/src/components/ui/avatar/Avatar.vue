<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import type { ControlSize } from "@/components/ui/size"
import { cn } from "cn"
import { AvatarRoot } from "reka-ui"

const props = withDefaults(defineProps<{
  size?: ControlSize
  class?: HTMLAttributes["class"]
}>(), {
  size: "md",
})

const sizeClass: Record<ControlSize, string> = {
  xs: "size-6 text-2xs",
  sm: "size-7 text-xs",
  md: "size-8 text-xs",
  lg: "size-10 text-sm",
}
</script>

<template>
  <AvatarRoot
    data-slot="avatar"
    :data-size="size"
    :class="cn('relative flex shrink-0 overflow-hidden rounded-full', sizeClass[size], props.class)"
  >
    <slot />
  </AvatarRoot>
</template>
