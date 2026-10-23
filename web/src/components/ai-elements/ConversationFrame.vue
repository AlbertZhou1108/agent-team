<script setup lang="ts">
import { Card, CardContent } from '@/components/ui/card';
withDefaults(defineProps<{ readonly?: boolean }>(), { readonly: true });
</script>

<template>
  <Card class="min-h-0 min-w-0 overflow-hidden">
    <CardContent class="flex min-h-0 flex-1 flex-col">
      <slot name="header" />
      <slot />
      <slot name="footer" />
      <slot v-if="!readonly" name="composer" />
    </CardContent>
  </Card>
</template>
