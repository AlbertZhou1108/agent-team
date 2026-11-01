<script setup lang="ts">
import { Network } from '@lucide/vue';
defineProps<{ collapsed?: boolean }>();
</script>

<template>
  <Network
    :class="collapsed ? 'size-4' : 'size-6'"
    class="shrink-0"
    role="img"
    aria-label="Agent Team"
  />
</template>
