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
  sm: 'text-sm font-semibold text-foreground',
  md: 'text-lg font-semibold text-foreground',
  lg: 'text-xl font-semibold text-foreground',
};
</script>

<template>
  <div
    data-component="metric-card"
    :data-size="size"
    :class="
      cn(
        'flex min-w-0 flex-col rounded-(--component-control-radius) border border-border bg-card/60 tabular-nums',
        size === 'sm'
          ? 'gap-0.5 px-3 py-2'
          : size === 'lg'
            ? progress !== undefined ? 'gap-2 p-4' : 'gap-1.5 p-4'
            : progress !== undefined ? 'gap-1.5 p-3' : 'gap-1 p-3',
        props.class,
      )
    "
  >
    <template v-if="progress !== undefined">
      <div class="flex items-center justify-between gap-2 text-xs">
        <span class="text-muted-foreground">{{ label }}</span>
        <span class="font-semibold text-foreground" :title="valueTitle">{{ value }}</span>
      </div>
      <Progress
        :model-value="progress ?? 0"
        :aria-label="progressLabel ?? `${label} ${value}`"
        class="h-1.5"
      />
    </template>
    <template v-else>
      <span class="text-xs text-muted-foreground">{{ label }}</span>
      <span
        :class="valueClass[size]"
        :title="valueTitle"
      >{{ value }}</span>
    </template>
    <span v-if="subtitle" class="text-xs text-muted-foreground">{{ subtitle }}</span>
  </div>
</template>
