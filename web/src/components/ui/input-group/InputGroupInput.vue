<script setup lang="ts">
import { computed, inject, type HTMLAttributes } from "vue"
import type { ControlSize } from "@/components/ui/size"
import { cn } from "cn"
import { Input } from '@/components/ui/input'
import { INPUT_GROUP_SIZE_KEY } from "."

const props = defineProps<{
  size?: ControlSize
  class?: HTMLAttributes["class"]
}>()

const groupSize = inject(INPUT_GROUP_SIZE_KEY, computed<ControlSize>(() => "md"))
const resolvedSize = computed(() => props.size ?? groupSize.value)
</script>

<template>
  <Input
    data-slot="input-group-control"
    :size="resolvedSize"
    :class="cn(
      'h-full flex-1 rounded-none border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent',
      props.class,
    )"
  />
</template>
