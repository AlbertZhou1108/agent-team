<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import type { ControlSize } from "@/components/ui/size"
import { useVModel } from "@vueuse/core"
import { cn } from "cn"

const props = withDefaults(defineProps<{
  defaultValue?: string | number
  modelValue?: string | number
  size?: ControlSize
  class?: HTMLAttributes["class"]
}>(), {
  size: "md",
})

const sizeClass: Record<ControlSize, string> = {
  xs: "h-(--component-control-xs-height) rounded-(--component-chip-radius) px-2 text-(length:--component-control-xs-font-size)",
  sm: "h-(--component-control-sm-height) rounded-(--component-control-radius) px-2.5 text-(length:--component-control-sm-font-size)",
  md: "h-(--component-control-height) rounded-(--component-control-radius) px-3 text-base md:text-(length:--component-control-font-size)",
  lg: "h-(--component-control-lg-height) rounded-(--component-control-radius) px-3.5 text-base md:text-(length:--component-control-lg-font-size)",
}

const emits = defineEmits<{
  (e: "update:modelValue", payload: string | number): void
}>()

const modelValue = useVModel(props, "modelValue", emits, {
  passive: true,
  defaultValue: props.defaultValue,
})
</script>

<template>
  <input
    v-model="modelValue"
    data-slot="input"
    data-surface="input"
    :data-size="size"
    :class="cn(
      'file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground dark:bg-input/30 border-input w-full min-w-0 border bg-transparent py-1 shadow-xs transition-[color,background-color,border-color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
      sizeClass[size],
      'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-3',
      'aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive',
      props.class,
    )"
  >
</template>
