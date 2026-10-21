<script setup lang="ts">
import { cn } from '@/lib/utils';

const props = defineProps<{ class?: string }>();
</script>

<template>
  <section :class="cn('panel', props.class)">
    <slot />
  </section>
</template>
