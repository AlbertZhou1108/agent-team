<script setup lang="ts">
/**
 * 有界滚动区:内容超出 max-height 时在自身区域内滚动,不撑长外层页面。
 * 传 `as` 保留语义标签(例如指标列表用 dl),`label` 必填 —— 区域可聚焦,
 * 需要可访问名称。样式集中在 globals.css 的 scroll-region 槽位,调用处只
 * 传高度与间距。
 */
withDefaults(
  defineProps<{
    /** 滚动区域的语义标签,同时用作 aria-label。 */
    label: string;
    /** 滚动区最大高度,超出后内部滚动。 */
    maxHeight?: string;
    /** 内容间距。 */
    gap?: string;
    /** 根元素标签,默认 div。 */
    as?: 'div' | 'dl' | 'ul' | 'ol' | 'section';
  }>(),
  {
    maxHeight: 'min(28rem,60vh)',
    gap: '1rem',
    as: 'div',
  },
);
</script>

<template>
  <component
    :is="as"
    data-slot="scroll-region"
    role="region"
    :aria-label="label"
    tabindex="0"
    :style="{ maxHeight, gap }"
  >
    <slot />
  </component>
</template>
