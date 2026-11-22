<script setup lang="ts">
import type { Component, HTMLAttributes } from 'vue';
import type { ContainerSize } from '@/components/ui/size';
import { cn } from 'cn';

/**
 * 弱提示/次级信息块:区域内的底色分组,不造边框卡片(docs/DESIGN.md「区域内
 * 用小标题、分割线与间距」)。底色 + card 档圆角是体系配方,内距与字号消费标准三档尺寸。
 */
const props = withDefaults(
  defineProps<{
    /** 渲染为哪个元素或组件,默认 div;属性透传到其根元素。 */
    as?: string | Component;
    size?: ContainerSize;
    class?: HTMLAttributes['class'];
  }>(),
  { as: 'div', size: 'md' },
);

const sizeClass: Record<ContainerSize, string> = {
  sm: 'p-2.5 text-xs',
  md: 'p-3 text-sm',
  lg: 'p-3.5 text-sm',
};
</script>

<template>
  <component
    :is="as"
    data-slot="note-block"
    :data-size="size"
    :class="cn('rounded-(--component-card-radius) bg-muted/30', sizeClass[size], props.class)"
  >
    <slot />
  </component>
</template>
