<script setup lang="ts">
import type { Component } from 'vue';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';

withDefaults(defineProps<{
  icon?: Component;
  title: string;
  description?: string;
  actionsAtFooter?: boolean;
}>(), {
  icon: undefined,
  description: '',
  actionsAtFooter: false,
});
</script>

<template>
  <Item variant="outline" size="sm" class="items-start">
    <ItemMedia v-if="icon" variant="icon" class="mt-0.5">
      <component :is="icon" />
    </ItemMedia>
    <ItemContent>
      <ItemTitle>{{ title }}</ItemTitle>
      <ItemDescription v-if="description" class="line-clamp-none text-xs leading-5">
        {{ description }}
      </ItemDescription>
      <slot name="meta" />
    </ItemContent>
    <ItemActions v-if="!actionsAtFooter" class="w-full justify-end sm:w-auto">
      <slot />
    </ItemActions>
    <ItemFooter v-else class="justify-end pt-1">
      <slot />
    </ItemFooter>
  </Item>
</template>
