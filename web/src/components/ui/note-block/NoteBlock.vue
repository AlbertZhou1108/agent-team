<script setup lang="ts">
import type { Component, HTMLAttributes } from 'vue';
import { cn } from 'cn';

/**
 * 弱提示/次级信息块:区域内的底色分组,不造边框卡片(DESIGN.md「区域内
 * 用小标题、分割线与间距」)。底色 + card 档圆角是体系配方,内距与布局
 * 由调用方 class 提供;承载代码/原始载荷时经 as="pre" 保留等宽排版。
 */
const props = withDefaults(
  defineProps<{
    /** 渲染为哪个元素或组件,默认 div;属性透传到其根元素。 */
    as?: string | Component;
    class?: HTMLAttributes['class'];
  }>(),
  { as: 'div' },
);
</script>

<template>
  <component
    :is="as"
    :class="cn('rounded-(--component-card-radius) bg-muted/30 p-3 text-sm', props.class)"
  >
    <slot />
  </component>
</template>
