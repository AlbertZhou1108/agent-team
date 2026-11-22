<script setup lang="ts">
import type { PrimitiveProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import type { BadgeVariants } from "."
import { reactiveOmit } from "@vueuse/core"
import { cn } from "cn"
import { Primitive } from "reka-ui"
import { badgeVariants } from "."

const props = withDefaults(defineProps<PrimitiveProps & {
  variant?: BadgeVariants["variant"]
  size?: BadgeVariants["size"]
  class?: HTMLAttributes["class"]
}>(), {
  size: "md",
})

const delegatedProps = reactiveOmit(props, "class", "size")
</script>

<template>
  <Primitive
    data-slot="badge"
    :data-size="size"
    :class="cn(badgeVariants({ variant, size }), props.class)"
    v-bind="delegatedProps"
  >
    <slot />
  </Primitive>
</template>
