<script setup lang="ts">
import { SwitchRoot, SwitchThumb } from 'reka-ui';
import { cn } from '@/lib/utils';

const props = defineProps<{
  modelValue: boolean;
  label: string;
  class?: string;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();
</script>

<template>
  <label :class="cn('flex cursor-pointer items-center justify-between gap-4 text-xs', props.class)">
    <span>{{ label }}</span>
    <SwitchRoot
      :model-value="modelValue"
      :class="cn(
        'relative h-5 w-9 rounded-full border transition-colors',
        modelValue
          ? 'border-[var(--primary)] bg-[var(--primary)]'
          : 'border-[var(--border)] bg-[var(--surface-raised)]',
      )"
      @update:model-value="emit('update:modelValue', $event)"
    >
      <SwitchThumb
        :class="cn(
          'block size-3.5 rounded-full bg-white shadow transition-transform',
          modelValue ? 'translate-x-[18px]' : 'translate-x-0.5',
        )"
      />
    </SwitchRoot>
  </label>
</template>
