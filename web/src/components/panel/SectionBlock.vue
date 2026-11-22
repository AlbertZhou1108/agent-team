<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { computed } from 'vue';
import { cn } from 'cn';

/**
 * 面板级通用边框分区容器（components/panel 组合层）：
 * 统一消费 `--component-card-radius` + `border-border` 与 `@container` 容器查询上下文，
 * 避免在 features/pages 内重复手写边框容器或误用视口断点。
 */
const props = withDefaults(
  defineProps<{
    as?: 'section' | 'div';
    title?: string;
    meta?: string;
    headingLevel?: 2 | 3 | 4;
    tone?: 'default' | 'muted' | 'dashed';
    compact?: boolean;
    container?: boolean;
    class?: HTMLAttributes['class'];
  }>(),
  {
    as: 'section',
    headingLevel: 2,
    tone: 'default',
    compact: false,
    container: true,
  },
);

const toneClass = computed(() => {
  if (props.tone === 'muted') return 'bg-muted/20';
  if (props.tone === 'dashed') return 'border-dashed';
  return 'bg-background/40';
});

const headingTag = computed(() => `h${props.headingLevel}`);
</script>

<template>
  <component
    :is="as"
    data-component="section-block"
    :class="
      cn(
        'min-w-0 rounded-(--component-card-radius) border border-border',
        container && '@container',
        compact
          ? 'flex items-center justify-between gap-2 px-3 py-2.5'
          : 'flex flex-col gap-3 p-3.5',
        toneClass,
        props.class,
      )
    "
  >
    <template v-if="compact">
      <slot name="header">
        <component
          :is="headingTag"
          v-if="title || $slots.title"
          class="text-sm font-semibold text-foreground"
        >
          <slot name="title">{{ title }}</slot>
        </component>
        <span
          v-if="meta || $slots.meta"
          class="text-xs text-muted-foreground tabular-nums"
        >
          <slot name="meta">{{ meta }}</slot>
        </span>
      </slot>
      <slot />
    </template>
    <template v-else>
      <div
        v-if="title || meta || $slots.header || $slots.title || $slots.meta"
        class="flex flex-wrap items-center justify-between gap-2"
      >
        <slot name="header">
          <component
            :is="headingTag"
            v-if="title || $slots.title"
            class="text-xs font-semibold tracking-wide text-muted-foreground"
          >
            <slot name="title">{{ title }}</slot>
          </component>
          <span
            v-if="meta || $slots.meta"
            class="text-xs text-muted-foreground tabular-nums"
          >
            <slot name="meta">{{ meta }}</slot>
          </span>
        </slot>
      </div>
      <slot />
    </template>
  </component>
</template>
