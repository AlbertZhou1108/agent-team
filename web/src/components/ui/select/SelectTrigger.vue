<script setup lang="ts">
import type { SelectTriggerProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import type { ControlSize } from "@/components/ui/size"
import { ChevronDown } from "@lucide/vue"
import { reactiveOmit } from "@vueuse/core"
import { cn } from "cn"
import { SelectIcon, SelectTrigger, useForwardProps } from "reka-ui"

const props = withDefaults(
  defineProps<SelectTriggerProps & { class?: HTMLAttributes["class"], size?: ControlSize }>(),
  { size: "md" },
)

const sizeClass: Record<ControlSize, string> = {
  xs: "h-(--component-control-xs-height) rounded-(--component-chip-radius) px-2 py-1 text-(length:--component-control-xs-font-size) [&_svg:not([class*='size-'])]:size-3",
  sm: "h-(--component-control-sm-height) rounded-(--component-control-radius) px-2.5 py-1.5 text-(length:--component-control-sm-font-size) [&_svg:not([class*='size-'])]:size-3.5",
  md: "h-(--component-control-height) rounded-(--component-control-radius) px-3 py-2 text-(length:--component-control-font-size) [&_svg:not([class*='size-'])]:size-4",
  lg: "h-(--component-control-lg-height) rounded-(--component-control-radius) px-3.5 py-2 text-(length:--component-control-lg-font-size) [&_svg:not([class*='size-'])]:size-4.5",
}

const delegatedProps = reactiveOmit(props, "class", "size")
const forwardedProps = useForwardProps(delegatedProps)
</script>

<template>
  <SelectTrigger
    data-slot="select-trigger"
    data-surface="input"
    :data-size="size"
    v-bind="forwardedProps"
    :class="cn(
      `border-input data-[placeholder]:text-muted-foreground [&_svg:not([class*='text-'])]:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:bg-input/30 dark:hover:bg-input/50 flex w-fit items-center justify-between gap-2 border bg-transparent whitespace-nowrap shadow-xs transition-[color,background-color,border-color,box-shadow] outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2 [&_svg]:pointer-events-none [&_svg]:shrink-0`,
      sizeClass[size],
      props.class,
    )"
  >
    <slot />
    <SelectIcon as-child>
      <ChevronDown class="opacity-50" />
    </SelectIcon>
  </SelectTrigger>
</template>
