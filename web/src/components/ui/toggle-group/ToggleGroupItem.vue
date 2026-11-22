<script setup lang="ts">
import type { VariantProps } from "class-variance-authority"
import type { ToggleGroupItemProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { cn } from "cn"
import { ToggleGroupItem, useForwardProps } from "reka-ui"
import { computed, inject, type ComputedRef } from "vue"
import { toggleVariants } from '@/components/ui/toggle'

type ToggleGroupVariants = VariantProps<typeof toggleVariants> & {
  spacing?: number
}
interface ToggleGroupContext {
  variant: ComputedRef<ToggleGroupVariants["variant"]>
  size: ComputedRef<ToggleGroupVariants["size"]>
  spacing: ComputedRef<number | undefined>
}

const props = defineProps<ToggleGroupItemProps & {
  class?: HTMLAttributes["class"]
  variant?: ToggleGroupVariants["variant"]
  size?: ToggleGroupVariants["size"]
}>()

const context = inject<ToggleGroupContext | undefined>("toggleGroup", undefined)
const activeVariant = computed(() => context?.variant.value || props.variant)
const activeSize = computed(() => context?.size.value || props.size || "md")
const activeSpacing = computed(() => context?.spacing.value)

const delegatedProps = reactiveOmit(props, "class", "size", "variant")
const forwardedProps = useForwardProps(delegatedProps)
</script>

<template>
  <ToggleGroupItem
    v-slot="slotProps"
    data-slot="toggle-group-item"
    :data-variant="activeVariant"
    :data-size="activeSize"
    :data-spacing="activeSpacing"
    v-bind="forwardedProps"
    :class="cn(
      toggleVariants({
        variant: activeVariant,
        size: activeSize,
      }),
      'w-auto min-w-0 shrink-0 px-3 focus:z-10 focus-visible:z-10',
      'data-[spacing=0]:rounded-none data-[spacing=0]:shadow-none data-[spacing=0]:first:rounded-l-md data-[spacing=0]:last:rounded-r-md data-[spacing=0]:data-[variant=outline]:border-l-0 data-[spacing=0]:data-[variant=outline]:first:border-l',
      props.class)"
  >
    <slot v-bind="slotProps" />
  </ToggleGroupItem>
</template>
