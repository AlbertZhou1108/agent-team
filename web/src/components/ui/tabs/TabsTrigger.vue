<script setup lang="ts">
import type { TabsTriggerProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import type { ControlSize } from "@/components/ui/size"
import { computed, inject } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { cn } from "cn"
import { TabsTrigger, useForwardProps } from "reka-ui"
import { TABS_SIZE_KEY, TABS_VARIANT_KEY, type TabsVariant } from "./context"

const props = defineProps<TabsTriggerProps & { variant?: TabsVariant; size?: ControlSize; class?: HTMLAttributes["class"] }>()

const listVariant = inject(TABS_VARIANT_KEY, computed<TabsVariant>(() => "pill"))
const listSize = inject(TABS_SIZE_KEY, computed<ControlSize>(() => "md"))
const activeVariant = computed<TabsVariant>(() => props.variant ?? listVariant.value)
const activeSize = computed<ControlSize>(() => props.size ?? listSize.value)

const underlineSizeClass: Record<ControlSize, string> = {
  xs: "px-2 py-0.5 text-(length:--component-control-xs-font-size) [&_svg:not([class*='size-'])]:size-3",
  sm: "px-2.5 py-1 text-(length:--component-control-sm-font-size) [&_svg:not([class*='size-'])]:size-3.5",
  md: "px-3 py-1.5 text-(length:--component-control-font-size) [&_svg:not([class*='size-'])]:size-4",
  lg: "px-3.5 py-2 text-(length:--component-control-lg-font-size) [&_svg:not([class*='size-'])]:size-4.5",
}

const pillSizeClass: Record<ControlSize, string> = {
  xs: "h-(--component-control-xs-height) rounded-(--component-chip-radius) px-1.5 py-0.5 text-(length:--component-control-xs-font-size) [&_svg:not([class*='size-'])]:size-3",
  sm: "h-[calc(100%-1px)] px-2 py-0.5 text-(length:--component-control-sm-font-size) [&_svg:not([class*='size-'])]:size-3.5",
  md: "h-[calc(100%-1px)] px-2.5 py-1 text-(length:--component-control-font-size) [&_svg:not([class*='size-'])]:size-4",
  lg: "h-[calc(100%-1px)] px-3 py-1.5 text-(length:--component-control-lg-font-size) [&_svg:not([class*='size-'])]:size-4.5",
}

const delegatedProps = reactiveOmit(props, "class", "variant", "size")

const forwardedProps = useForwardProps(delegatedProps)
</script>

<template>
  <TabsTrigger
    data-slot="tabs-trigger"
    :data-variant="activeVariant"
    :data-size="activeSize"
    :class="cn(
      activeVariant === 'underline'
        ? [
            'relative inline-flex items-center justify-center gap-1.5 rounded-none border-0 bg-transparent font-medium whitespace-nowrap text-muted-foreground shadow-none transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none data-[state=active]:after:absolute data-[state=active]:after:inset-x-1 data-[state=active]:after:-bottom-2 data-[state=active]:after:h-0.5 data-[state=active]:after:bg-primary [&_svg]:pointer-events-none [&_svg]:shrink-0',
            underlineSizeClass[activeSize],
          ]
        : [
            'data-[state=active]:bg-background dark:data-[state=active]:text-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:outline-ring dark:data-[state=active]:border-input dark:data-[state=active]:bg-input/30 text-foreground dark:text-muted-foreground inline-flex flex-1 items-center justify-center gap-1.5 border border-transparent font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow] focus-visible:ring-3 focus-visible:outline-1 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
            pillSizeClass[activeSize],
          ],
      props.class,
    )"
    v-bind="forwardedProps"
  >
    <slot />
  </TabsTrigger>
</template>
