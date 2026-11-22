<script setup lang="ts">
import type { TabsListProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import type { ControlSize } from "@/components/ui/size"
import { computed, provide } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { cn } from "cn"
import { TabsList } from "reka-ui"
import { TABS_SIZE_KEY, TABS_VARIANT_KEY, type TabsVariant } from "./context"

const props = withDefaults(
  defineProps<TabsListProps & { variant?: TabsVariant; size?: ControlSize; class?: HTMLAttributes["class"] }>(),
  { variant: "pill" },
)

const resolvedSize = computed<ControlSize>(() => props.size ?? (props.variant === "underline" ? "sm" : "md"))
const pillSizeClass: Record<ControlSize, string> = {
  xs: "h-auto rounded-[calc(var(--component-chip-radius)+2px)] p-0.5",
  sm: "h-(--component-control-sm-height) rounded-[calc(var(--component-control-radius)+2px)] p-0.5",
  md: "h-(--component-control-height) rounded-[calc(var(--component-control-radius)+3px)] p-0.75",
  lg: "h-(--component-control-lg-height) rounded-[calc(var(--component-control-radius)+3px)] p-1",
}

const delegatedProps = reactiveOmit(props, "class", "variant", "size")
provide(
  TABS_VARIANT_KEY,
  computed(() => props.variant),
)
provide(TABS_SIZE_KEY, resolvedSize)
</script>

<template>
  <TabsList
    data-slot="tabs-list"
    :data-variant="variant"
    :data-size="resolvedSize"
    v-bind="delegatedProps"
    :class="cn(
      variant === 'underline'
        ? 'inline-flex h-auto w-fit items-center gap-1 rounded-none bg-transparent p-0 text-muted-foreground'
        : ['bg-muted text-muted-foreground inline-flex w-fit items-center justify-center', pillSizeClass[resolvedSize]],
      props.class,
    )"
  >
    <slot />
  </TabsList>
</template>
