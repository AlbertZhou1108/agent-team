<script setup lang="ts">
import { computed, inject, type HTMLAttributes } from "vue"
import type { ContainerSize } from "@/components/ui/size"
import type { EmptyMediaVariants } from "."
import { cn } from "cn"
import { EMPTY_SIZE_KEY, emptyMediaVariants } from "."

const props = defineProps<{
  class?: HTMLAttributes["class"]
  variant?: EmptyMediaVariants["variant"]
  size?: ContainerSize
}>()

const emptySize = inject(EMPTY_SIZE_KEY, computed<ContainerSize>(() => "md"))
const resolvedSize = computed(() => props.size ?? emptySize.value)
</script>

<template>
  <div
    data-slot="empty-icon"
    :data-variant="variant"
    :data-size="resolvedSize"
    :class="cn(emptyMediaVariants({ variant, size: resolvedSize }), props.class)"
  >
    <slot />
  </div>
</template>
