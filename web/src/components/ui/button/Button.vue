<script setup lang="ts">
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:pointer-events-none disabled:opacity-50 [--button-icon-size:1rem] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=\'size-\'])]:size-[var(--button-icon-size)]',
  {
    variants: {
      variant: {
        default: 'bg-[var(--primary)] text-[var(--primary-foreground)] hover:bg-[var(--primary-hover)]',
        secondary: 'bg-[var(--secondary)] text-[var(--foreground)] hover:bg-[var(--secondary-hover)]',
        outline: 'border border-[var(--border)] bg-transparent hover:bg-[var(--surface-raised)]',
        ghost: 'hover:bg-[var(--surface-raised)]',
        destructive: 'bg-[var(--danger)] text-white hover:opacity-90',
      },
      size: {
        default: 'h-9 px-4 py-2',
        xs: 'h-7 rounded-md px-2 text-xs [--button-icon-size:0.75rem]',
        sm: 'h-8 rounded-md px-3 text-xs',
        icon: 'size-9 p-0',
        'icon-sm': 'size-8 p-0',
        'icon-xs': 'size-6 p-0 [--button-icon-size:0.75rem]',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export type ButtonVariants = VariantProps<typeof buttonVariants>;
const props = withDefaults(defineProps<{
  variant?: ButtonVariants['variant'];
  size?: ButtonVariants['size'];
  class?: string;
  type?: 'button' | 'submit' | 'reset';
  disabled?: boolean;
}>(), {
  type: 'button',
  variant: 'default',
  size: 'default',
});
</script>

<template>
  <button
    :type="props.type"
    :disabled="props.disabled"
    :class="cn(buttonVariants({ variant: props.variant, size: props.size }), props.class)"
    v-bind="$attrs"
  >
    <slot />
  </button>
</template>
