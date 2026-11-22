<script setup lang="ts">
import type { Component } from 'vue';
import type { ContainerSize } from '@/components/ui/size';
import { Inbox, LoaderCircle } from '@lucide/vue';
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription, EmptyContent } from '@/components/ui/empty';
withDefaults(defineProps<{ title: string; description?: string; icon?: Component; loading?: boolean; size?: ContainerSize }>(), { description: '', loading: false, size: 'md' });
</script>

<template>
  <Empty :size="size" :role="loading ? 'status' : undefined" :aria-busy="loading || undefined">
    <EmptyHeader>
      <EmptyMedia variant="icon"><LoaderCircle v-if="loading" class="animate-spin" /><component v-else :is="icon ?? Inbox" /></EmptyMedia>
      <EmptyTitle>{{ title }}</EmptyTitle>
      <EmptyDescription v-if="description">{{ description }}</EmptyDescription>
    </EmptyHeader>
    <EmptyContent v-if="$slots.default"><slot /></EmptyContent>
  </Empty>
</template>
