<script setup lang="ts">
import { computed, provide, type HTMLAttributes } from "vue"
import type { ControlSize } from "@/components/ui/size"
import { cn } from "cn"
import { INPUT_GROUP_SIZE_KEY } from "."

const props = withDefaults(defineProps<{
  size?: ControlSize
  class?: HTMLAttributes["class"]
}>(), {
  size: "md",
})

provide(INPUT_GROUP_SIZE_KEY, computed(() => props.size))

const heightClass: Record<ControlSize, string> = {
  xs: "h-(--component-control-xs-height) rounded-(--component-chip-radius)",
  sm: "h-(--component-control-sm-height) rounded-(--component-control-radius)",
  md: "h-(--component-control-height) rounded-(--component-control-radius)",
  lg: "h-(--component-control-lg-height) rounded-(--component-control-radius)",
}
</script>

<template>
  <div
    data-slot="input-group"
    data-surface="input"
    :data-size="size"
    role="group"
    :class="cn(
      'group/input-group border-input dark:bg-input/30 relative flex w-full items-center border shadow-xs transition-[color,background-color,border-color,box-shadow] outline-none',
      heightClass[size],
      'min-w-0 has-[>textarea]:h-auto',

      // Variants based on alignment.
      'has-[>[data-align=inline-start]]:[&>input]:pl-2',
      'has-[>[data-align=inline-end]]:[&>input]:pr-2',
      'has-[>[data-align=block-start]]:h-auto has-[>[data-align=block-start]]:flex-col has-[>[data-align=block-start]]:[&>input]:pb-3',
      'has-[>[data-align=block-end]]:h-auto has-[>[data-align=block-end]]:flex-col has-[>[data-align=block-end]]:[&>input]:pt-3',

      // Focus state.
      'has-[[data-slot=input-group-control]:focus-visible]:border-ring has-[[data-slot=input-group-control]:focus-visible]:ring-ring/50 has-[[data-slot=input-group-control]:focus-visible]:ring-3',

      // Error state.
      'has-[[data-slot][aria-invalid=true]]:ring-destructive/20 has-[[data-slot][aria-invalid=true]]:border-destructive dark:has-[[data-slot][aria-invalid=true]]:ring-destructive/40',

      props.class,
    )"
  >
    <slot />
  </div>
</template>
