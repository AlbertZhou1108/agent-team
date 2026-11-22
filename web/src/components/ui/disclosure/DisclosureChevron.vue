<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { ChevronDown, ChevronRight } from '@lucide/vue';
import { cn } from 'cn';

/**
 * 统一的折叠指示箭头：固定绑定 `data-part="disclosure-indicator"` 以继承
 * `--component-disclosure-duration` / `--component-disclosure-easing` 双属性过渡。
 */
const props = withDefaults(
  defineProps<{
    open?: boolean;
    direction?: 'down' | 'right';
    class?: HTMLAttributes['class'];
  }>(),
  { open: false, direction: 'down' },
);
</script>

<template>
  <ChevronDown
    v-if="direction === 'down'"
    data-part="disclosure-indicator"
    aria-hidden="true"
    :class="cn('size-3.5 shrink-0', open && 'rotate-180', props.class)"
  />
  <ChevronRight
    v-else
    data-part="disclosure-indicator"
    aria-hidden="true"
    :class="cn('size-3.5 shrink-0', open && 'rotate-90', props.class)"
  />
</template>
