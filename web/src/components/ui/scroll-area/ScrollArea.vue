<script setup lang="ts">
import type { ScrollAreaRootProps } from 'reka-ui';
import type { HTMLAttributes } from 'vue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue';
import { reactiveOmit } from '@vueuse/core';
import {
  ScrollAreaCorner,
  ScrollAreaRoot,
  ScrollAreaViewport,
} from 'reka-ui';
import { cn } from '@/lib/utils';
import ScrollBar from './ScrollBar.vue';

const props = defineProps<ScrollAreaRootProps & {
  class?: HTMLAttributes['class'];
  itemSelector?: string;
  maxVisibleItems?: number;
}>();
const delegatedProps = reactiveOmit(props, 'class', 'itemSelector', 'maxVisibleItems');
const contentRef = useTemplateRef<HTMLElement>('content');
const measuredHeight = ref<number>();
let resizeObserver: ResizeObserver | undefined;
let mutationObserver: MutationObserver | undefined;
let measureFrame = 0;

const rootStyle = computed(() => (
  measuredHeight.value ? { height: `${measuredHeight.value}px` } : undefined
));

function scheduleMeasure() {
  window.cancelAnimationFrame(measureFrame);
  measureFrame = window.requestAnimationFrame(measure);
}

function measure() {
  const content = contentRef.value;
  const selector = props.itemSelector;
  const limit = props.maxVisibleItems;
  if (!content || !selector || !limit) {
    measuredHeight.value = undefined;
    return;
  }
  const items = [...content.querySelectorAll<HTMLElement>(selector)];
  if (items.length <= limit) {
    measuredHeight.value = undefined;
    return;
  }
  const lastVisible = items[limit - 1].getBoundingClientRect();
  measuredHeight.value = Math.ceil(lastVisible.bottom - content.getBoundingClientRect().top);
}

watch(
  () => [props.itemSelector, props.maxVisibleItems],
  async () => {
    await nextTick();
    scheduleMeasure();
  },
);

onMounted(() => {
  const content = contentRef.value;
  if (!content) return;
  resizeObserver = new ResizeObserver(scheduleMeasure);
  resizeObserver.observe(content);
  mutationObserver = new MutationObserver(scheduleMeasure);
  mutationObserver.observe(content, {
    attributes: true,
    attributeFilter: ['class', 'style'],
    childList: true,
    subtree: true,
  });
  window.addEventListener('resize', scheduleMeasure);
  scheduleMeasure();
});

onBeforeUnmount(() => {
  window.cancelAnimationFrame(measureFrame);
  resizeObserver?.disconnect();
  mutationObserver?.disconnect();
  window.removeEventListener('resize', scheduleMeasure);
});
</script>

<template>
  <ScrollAreaRoot
    data-slot="scroll-area"
    v-bind="delegatedProps"
    :style="rootStyle"
    :class="cn('relative overflow-hidden', props.class)"
  >
    <ScrollAreaViewport
      data-slot="scroll-area-viewport"
      class="size-full rounded-[inherit] outline-none transition-[color,box-shadow] focus-visible:ring-3 focus-visible:ring-[var(--ring)]/50 focus-visible:outline-1"
    >
      <div ref="content" data-slot="scroll-area-content">
        <slot />
      </div>
    </ScrollAreaViewport>
    <ScrollBar />
    <ScrollAreaCorner />
  </ScrollAreaRoot>
</template>
