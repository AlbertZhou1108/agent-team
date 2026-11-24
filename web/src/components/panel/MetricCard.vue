<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import type { ContainerSize } from '@/components/ui/size';
import { Progress } from '@/components/ui/progress';
import { cn } from 'cn';

/**
 * 面板级指标卡：统一消费 `--component-control-radius`、`bg-card/60` 与 `tabular-nums`，
 * 支持 `sm | md | lg` 三档尺寸（`sm` 紧凑指标格、`md` 标准 KPI、`lg` 强调 KPI）与可选进度条。
 */
const props = withDefaults(
  defineProps<{
    label: string;
    value: string | number;
    valueTitle?: string;
    subtitle?: string;
    progress?: number | null;
    progressLabel?: string;
    size?: ContainerSize;
    class?: HTMLAttributes['class'];
  }>(),
  {
    progress: undefined,
    size: 'md',
  },
);

const valueClass: Record<ContainerSize, string> = {
  sm: 'text-base leading-tight font-semibold tracking-tight text-foreground',
  md: 'text-[1.375rem] leading-tight font-semibold tracking-tight text-foreground',
  lg: 'text-2xl leading-tight font-semibold tracking-tight text-foreground',
};
</script>

<template>
  <div
    data-component="metric-card"
    :data-size="size"
    :class="
      cn(
        'flex min-w-0 flex-col rounded-(--component-control-radius) border border-border bg-secondary/50 tabular-nums',
        size === 'sm'
          ? 'gap-1 px-3 py-2.5'
          : size === 'lg'
            ? 'gap-1.5 p-4'
            : 'gap-1.5 p-3.5',
        props.class,
      )
    "
  >
    <span class="truncate text-xs text-muted-foreground">{{ label }}</span>
    <span
      :class="valueClass[size]"
      :title="valueTitle"
    >{{ value }}</span>
    <Progress
      v-if="progress !== undefined"
      :model-value="progress ?? 0"
      :aria-label="progressLabel ?? `${label} ${value}`"
      class="mt-0.5 h-1.5"
    />
    <span v-if="subtitle" class="truncate text-xs text-muted-foreground">{{ subtitle }}</span>
  </div>
</template>
