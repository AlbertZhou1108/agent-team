<script setup lang="ts">
import type { CollapsibleContentProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { CollapsibleContent } from "reka-ui"

const props = defineProps<CollapsibleContentProps & { class?: HTMLAttributes["class"] }>()

// 展开测量帧可能早于字体/布局稳定,动画高度会短暂超过容器并闪现滚动条。
// 动画期间对最近的滚动容器隐藏滚动条(计数保护,支持多区块并行动画)。
const activeCount = new WeakMap<Element, number>();

function suppressScrollbar(target: Element) {
  let el = target.parentElement;
  while (el) {
    const overflowY = getComputedStyle(el).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') break;
    el = el.parentElement;
  }
  if (!el) return;
  const count = (activeCount.get(el) ?? 0) + 1;
  activeCount.set(el, count);
  el.classList.add('collapse-scroll-suppressed');
}

function releaseScrollbar(target: Element) {
  let el = target.parentElement;
  while (el) {
    if (el.classList.contains('collapse-scroll-suppressed')) break;
    const overflowY = getComputedStyle(el).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') break;
    el = el.parentElement;
  }
  if (!el) return;
  const count = (activeCount.get(el) ?? 1) - 1;
  activeCount.set(el, Math.max(0, count));
  if (count <= 0) el.classList.remove('collapse-scroll-suppressed');
}

function onAnimationStart(event: AnimationEvent) {
  if (event.animationName === 'collapsible-down' || event.animationName === 'collapsible-up') {
    suppressScrollbar(event.currentTarget as Element);
  }
}

function onAnimationFinish(event: AnimationEvent) {
  if (event.animationName === 'collapsible-down' || event.animationName === 'collapsible-up') {
    releaseScrollbar(event.currentTarget as Element);
  }
}
</script>

<template>
  <CollapsibleContent
    data-slot="collapsible-content"
    class="overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up"
    v-bind="props"
    @animationstart="onAnimationStart"
    @animationend="onAnimationFinish"
    @animationcancel="onAnimationFinish"
  >
    <slot />
  </CollapsibleContent>
</template>
