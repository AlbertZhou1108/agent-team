<script setup lang="ts">
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium tracking-wide',
  {
    variants: {
      variant: {
        default: 'border-[var(--border)] bg-[var(--surface-raised)] text-[var(--muted-foreground)]',
        success: 'border-[color-mix(in_oklch,var(--success)_40%,transparent)] bg-[color-mix(in_oklch,var(--success)_12%,transparent)] text-[var(--success)]',
        warning: 'border-[color-mix(in_oklch,var(--warning)_40%,transparent)] bg-[color-mix(in_oklch,var(--warning)_12%,transparent)] text-[var(--warning)]',
        danger: 'border-[color-mix(in_oklch,var(--danger)_40%,transparent)] bg-[color-mix(in_oklch,var(--danger)_12%,transparent)] text-[var(--danger)]',
        accent: 'border-[color-mix(in_oklch,var(--primary)_40%,transparent)] bg-[color-mix(in_oklch,var(--primary)_12%,transparent)] text-[var(--primary)]',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

const props = withDefaults(defineProps<{
  variant?: VariantProps<typeof badgeVariants>['variant'];
  class?: string;
}>(), { variant: 'default' });
</script>

<template>
  <span :class="cn(badgeVariants({ variant: props.variant }), props.class)">
    <slot />
  </span>
</template>
