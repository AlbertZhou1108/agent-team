<script setup lang="ts">
import { LoaderCircle, Trash2 } from '@lucide/vue';
import { Button } from '@/components/ui/button';
defineProps<{ disabled: boolean; busy: boolean; label: string; description: string }>();
defineEmits<{ click: [] }>();
</script>

<template>
  <Button variant="ghost" size="icon-sm" :disabled="disabled || busy" :aria-label="busy ? '正在清理' : label" :title="description" @click="$emit('click')">
    <LoaderCircle v-if="busy" class="animate-spin" />
    <Trash2 v-else />
  </Button>
</template>
