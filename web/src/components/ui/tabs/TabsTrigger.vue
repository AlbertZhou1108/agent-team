<script setup lang="ts">
import type { TabsTriggerProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { computed, inject } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { cn } from "cn"
import { TabsTrigger, useForwardProps } from "reka-ui"
import { TABS_VARIANT_KEY, type TabsVariant } from "./context"

const props = defineProps<TabsTriggerProps & { variant?: TabsVariant; class?: HTMLAttributes["class"] }>()

const listVariant = inject(TABS_VARIANT_KEY, computed<TabsVariant>(() => "pill"))
const activeVariant = computed<TabsVariant>(() => props.variant ?? listVariant.value)

const delegatedProps = reactiveOmit(props, "class", "variant")

const forwardedProps = useForwardProps(delegatedProps)
</script>

<template>
  <TabsTrigger
    data-slot="tabs-trigger"
    :data-variant="activeVariant"
    :class="cn(
      activeVariant === 'underline'
        ? 'relative inline-flex items-center justify-center gap-1.5 rounded-none border-0 bg-transparent px-2.5 py-1 text-xs font-medium whitespace-nowrap text-muted-foreground shadow-none transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none data-[state=active]:after:absolute data-[state=active]:after:inset-x-1 data-[state=active]:after:-bottom-2 data-[state=active]:after:h-0.5 data-[state=active]:after:bg-primary [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=\'size-\'])]:size-4'
        : `data-[state=active]:bg-background dark:data-[state=active]:text-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:outline-ring dark:data-[state=active]:border-input dark:data-[state=active]:bg-input/30 text-foreground dark:text-muted-foreground inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 border border-transparent px-2 py-1 text-sm font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow] focus-visible:ring-3 focus-visible:outline-1 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4`,
      props.class,
    )"
    v-bind="forwardedProps"
  >
    <slot />
  </TabsTrigger>
</template>
