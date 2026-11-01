<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "cn"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <div
    data-slot="card-footer"
    :class="cn('flex items-center px-(--card-padding) [.border-t]:pt-(--card-padding)', props.class)"
  >
    <slot />
  </div>
</template>
