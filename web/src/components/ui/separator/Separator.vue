<script setup lang="ts">
import type { SeparatorProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { cn } from "cn"
import { Separator } from "reka-ui"

const props = withDefaults(defineProps<
  SeparatorProps & {
    size?: "full" | "inline"
    class?: HTMLAttributes["class"]
  }
>(), {
  orientation: "horizontal",
  decorative: true,
  size: "full",
})

const delegatedProps = reactiveOmit(props, "class", "size")
</script>

<template>
  <Separator
    data-slot="separator"
    :data-size="props.size"
    v-bind="delegatedProps"
    :class="
      cn(
        'bg-border shrink-0',
        props.size === 'inline'
          ? 'data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-3.5 data-[orientation=vertical]:h-3.5 data-[orientation=vertical]:w-px'
          : 'data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px',
        props.class,
      )
    "
  />
</template>
