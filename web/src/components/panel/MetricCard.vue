<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { Progress } from '@/components/ui/progress';
import { cn } from 'cn';

/**
 * 面板级指标卡：统一消费 `--component-control-radius`、`bg-card/60` 与 `tabular-nums`，
 * 支持大号 KPI（含可选进度条）与紧凑 9 项指标格两种尺寸。
 */
const props = withDefaults(
  defineProps<{
    label: string;
    value: string | number;
    valueTitle?: string;
    subtitle?: string;
    progress?: number | null;
    progressLabel?: string;
    size?: 'lg' | 'sm';
    class?: HTMLAttributes['class'];
  }>(),
  {
    progress: undefined,
    size: 'lg',
  },
);
</script>

<template>
  <div
    data-component="metric-card"
    :class="
      cn(
        'flex min-w-0 flex-col rounded-(--component-control-radius) border border-border bg-card/60 tabular-nums',
        size === 'sm' ? 'gap-0.5 px-3 py-2' : progress !== undefined ? 'gap-1.5 p-3' : 'gap-1 p-3',
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
        :class="
          size === 'sm'
            ? 'text-sm font-semibold text-foreground'
            : 'text-lg font-semibold text-foreground'
        "
        :title="valueTitle"
      >{{ value }}</span>
    </template>
    <span v-if="subtitle" class="text-xs text-muted-foreground">{{ subtitle }}</span>
  </div>
</template>
