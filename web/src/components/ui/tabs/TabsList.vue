<script setup lang="ts">
import type { TabsListProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { computed, provide } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { cn } from "cn"
import { TabsList } from "reka-ui"
import { TABS_VARIANT_KEY, type TabsVariant } from "./context"

const props = withDefaults(
  defineProps<TabsListProps & { variant?: TabsVariant; class?: HTMLAttributes["class"] }>(),
  { variant: "pill" },
)

const delegatedProps = reactiveOmit(props, "class", "variant")
provide(
  TABS_VARIANT_KEY,
  computed(() => props.variant),
)
</script>

<template>
  <TabsList
    data-slot="tabs-list"
    :data-variant="variant"
    v-bind="delegatedProps"
    :class="cn(
      variant === 'underline'
        ? 'inline-flex h-auto w-fit items-center gap-1 rounded-none bg-transparent p-0 text-muted-foreground'
        : 'bg-muted text-muted-foreground inline-flex h-9 w-fit items-center justify-center rounded-[calc(var(--component-control-radius)+3px)] p-0.75',
      props.class,
    )"
  >
    <slot />
  </TabsList>
</template>
